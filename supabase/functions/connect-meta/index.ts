// connect-meta
// Cadastra ativos Meta (ad accounts + pages + forms) selecionados pelo cliente,
// idempotente (UPSERT). Reusa o validate-meta-token pra descoberta.
// Tudo o que já existe pra o tenant é preservado/atualizado, nunca duplicado.
//
// Input:
// {
//   tenant_id: string,                 // obrigatório (caller deve ser admin desse tenant)
//   access_token: string,              // System User token
//   selected_ad_accounts: [{ account_id, account_name }],
//   selected_pages: [{
//     page_id, page_name, page_access_token,
//     subscribe_leadgen: boolean,      // chama POST /{page}/subscribed_apps
//     forms: [{ form_id, form_name, leads_count }]
//   }]
// }
//
// Comportamento idempotente:
// - meta_ads_accounts.account_id é UNIQUE GLOBAL — se outro tenant já tem essa conta,
//   bloqueia com erro claro (evita roubar conta de outro tenant)
// - meta_lead_ads_pages UNIQUE(tenant_id, page_id) → UPSERT
// - meta_lead_ads_forms UNIQUE(tenant_id, form_id) → UPSERT
// - subscribe_apps é best-effort (não falha se já estiver subscrito)
//
// Deploy: npx supabase functions deploy connect-meta --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const GRAPH = "https://graph.facebook.com/v23.0";

interface SelectedAdAccount {
  account_id: string;
  account_name: string;
}
interface SelectedForm {
  form_id: string;
  form_name: string;
  leads_count?: number;
}
interface SelectedPage {
  page_id: string;
  page_name: string;
  page_access_token: string;
  subscribe_leadgen: boolean;
  forms: SelectedForm[];
}

async function subscribePageLeadgen(page_id: string, page_token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const url = `${GRAPH}/${page_id}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(page_token)}`;
    const res = await fetch(url, { method: "POST" });
    const data = await res.json();
    if (!res.ok || data?.success === false) {
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "unknown" };
  }
}

async function isCallerAdminOfTenant(req: Request, tenantId: string): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  if (!auth) return false;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: auth } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return false;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  // Super-admin pode em qualquer tenant; admin precisa ser desse tenant
  const { data: members } = await (admin as any)
    .from("team_members")
    .select("role, is_superadmin, tenant_id")
    .eq("auth_user_id", user.id);

  if (!members || members.length === 0) return false;
  const isSuper = members.some((m: any) => m.is_superadmin);
  if (isSuper) return true;
  return members.some((m: any) => m.tenant_id === tenantId && m.role === "admin");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { access_token, selected_ad_accounts, selected_pages } = body as {
      access_token: string;
      selected_ad_accounts?: SelectedAdAccount[];
      selected_pages?: SelectedPage[];
    };
    // tenant explícito no body > tenant do JWT do chamador
    const tenant_id: string | null = (body as any).tenant_id || getTenantIdFromRequest(req);

    if (!tenant_id || !access_token) {
      return new Response(
        JSON.stringify({ ok: false, error: "tenant_id e access_token obrigatórios" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isAuthorized = await isCallerAdminOfTenant(req, tenant_id);
    if (!isAuthorized) {
      return new Response(
        JSON.stringify({ ok: false, error: "Acesso negado — só admin do tenant" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const result = {
      ad_accounts: { created: 0, updated: 0, conflicts: [] as string[] },
      pages: { created: 0, updated: 0 },
      forms: { created: 0, updated: 0 },
      webhooks: { subscribed: 0, failed: [] as Array<{ page_id: string; error: string }> },
    };

    // ─────────── AD ACCOUNTS ───────────
    // account_id é UNIQUE GLOBAL. Antes de UPSERT, verifica se outro tenant tem.
    for (const acc of selected_ad_accounts || []) {
      const accountIdNormalized = acc.account_id.startsWith("act_") ? acc.account_id.slice(4) : acc.account_id;

      const { data: existing } = await (admin as any)
        .from("meta_ads_accounts")
        .select("id, tenant_id")
        .eq("account_id", accountIdNormalized)
        .maybeSingle();

      if (existing && existing.tenant_id !== tenant_id) {
        // Conta já pertence a outro tenant — registra conflito, não sobrescreve
        result.ad_accounts.conflicts.push(accountIdNormalized);
        continue;
      }

      if (existing) {
        const { error } = await (admin as any)
          .from("meta_ads_accounts")
          .update({
            account_name: acc.account_name,
            access_token,
            is_active: true,
          })
          .eq("id", existing.id);
        if (!error) result.ad_accounts.updated++;
      } else {
        const { error } = await (admin as any).from("meta_ads_accounts").insert({
          tenant_id,
          account_id: accountIdNormalized,
          account_name: acc.account_name,
          access_token,
          is_active: true,
        });
        if (!error) result.ad_accounts.created++;
      }
    }

    // ─────────── PAGES + FORMS + WEBHOOK ───────────
    for (const p of selected_pages || []) {
      // UPSERT page (UNIQUE tenant_id, page_id)
      const { data: existingPage } = await (admin as any)
        .from("meta_lead_ads_pages")
        .select("id")
        .eq("tenant_id", tenant_id)
        .eq("page_id", p.page_id)
        .maybeSingle();

      if (existingPage) {
        const { error } = await (admin as any)
          .from("meta_lead_ads_pages")
          .update({
            page_name: p.page_name,
            page_access_token: p.page_access_token,
            is_active: true,
          })
          .eq("id", existingPage.id);
        if (!error) result.pages.updated++;
      } else {
        const { error } = await (admin as any).from("meta_lead_ads_pages").insert({
          tenant_id,
          page_id: p.page_id,
          page_name: p.page_name,
          page_access_token: p.page_access_token,
          is_active: true,
        });
        if (!error) result.pages.created++;
      }

      // Forms da page (UNIQUE tenant_id, form_id)
      for (const f of p.forms || []) {
        const { data: existingForm } = await (admin as any)
          .from("meta_lead_ads_forms")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("form_id", f.form_id)
          .maybeSingle();

        if (existingForm) {
          const { error } = await (admin as any)
            .from("meta_lead_ads_forms")
            .update({
              page_id: p.page_id,
              form_name: f.form_name,
              is_enabled: true,
              leads_count: f.leads_count || 0,
            })
            .eq("id", existingForm.id);
          if (!error) result.forms.updated++;
        } else {
          const { error } = await (admin as any).from("meta_lead_ads_forms").insert({
            tenant_id,
            page_id: p.page_id,
            form_id: f.form_id,
            form_name: f.form_name,
            is_enabled: true,
            leads_count: f.leads_count || 0,
          });
          if (!error) result.forms.created++;
        }
      }

      // Webhook leadgen (best-effort)
      if (p.subscribe_leadgen && p.page_access_token) {
        const sub = await subscribePageLeadgen(p.page_id, p.page_access_token);
        if (sub.ok) result.webhooks.subscribed++;
        else result.webhooks.failed.push({ page_id: p.page_id, error: sub.error || "" });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, result }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Erro inesperado" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
