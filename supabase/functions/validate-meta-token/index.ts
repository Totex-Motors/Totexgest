// validate-meta-token
// Recebe um System User access_token e retorna o que ele consegue acessar:
//   - permissions concedidas (vs as requeridas pelo CRM)
//   - ad_accounts
//   - pages (com page_access_token de cada — importante pra subscribe leadgen)
//   - forms de cada page
//
// Usado pelo wizard de Novo Cliente (Step 5 Meta).
// Deploy: npx supabase functions deploy validate-meta-token --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRAPH = "https://graph.facebook.com/v23.0";

const REQUIRED_PERMISSIONS = [
  "ads_management",
  "ads_read",
  "business_management",
  "leads_retrieval",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
];

async function fbGet(path: string, token: string) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${GRAPH}${path}${sep}access_token=${encodeURIComponent(token)}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      data?.error?.message || `Graph API ${res.status}: ${JSON.stringify(data)}`
    );
  }
  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { access_token } = await req.json();
    if (!access_token || typeof access_token !== "string") {
      return new Response(
        JSON.stringify({ ok: false, error: "access_token obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1) Sanity — pega user + permissions concedidas
    const [me, permsResp] = await Promise.all([
      fbGet("/me?fields=id,name", access_token),
      fbGet("/me/permissions", access_token),
    ]);

    const granted: string[] = (permsResp?.data || [])
      .filter((p: any) => p.status === "granted")
      .map((p: any) => p.permission);
    const missing = REQUIRED_PERMISSIONS.filter((p) => !granted.includes(p));

    // 2) Ad Accounts
    const adAccountsResp = await fbGet(
      "/me/adaccounts?fields=id,name,account_status,currency&limit=200",
      access_token
    ).catch(() => ({ data: [] }));
    const ad_accounts = (adAccountsResp?.data || []).map((a: any) => ({
      account_id: a.id,
      account_name: a.name,
      account_status: a.account_status,
      currency: a.currency,
    }));

    // 3) Pages — vem com page_access_token (importante!)
    const pagesResp = await fbGet(
      "/me/accounts?fields=id,name,access_token,followers_count,fan_count&limit=200",
      access_token
    ).catch(() => ({ data: [] }));

    const pagesRaw = pagesResp?.data || [];

    // 4) Pra cada page, busca leadgen_forms em paralelo
    const pages = await Promise.all(
      pagesRaw.map(async (p: any) => {
        let forms: any[] = [];
        try {
          const formsResp = await fbGet(
            `/${p.id}/leadgen_forms?fields=id,name,status,leads_count&limit=100`,
            p.access_token || access_token
          );
          forms = (formsResp?.data || [])
            .filter((f: any) => f.status === "ACTIVE" || f.status === undefined)
            .map((f: any) => ({
              form_id: f.id,
              form_name: f.name,
              leads_count: f.leads_count || 0,
            }));
        } catch {
          // Sem leads_retrieval ou sem forms — ok
        }
        return {
          page_id: p.id,
          page_name: p.name,
          page_access_token: p.access_token,
          followers: p.followers_count || p.fan_count,
          forms,
        };
      })
    );

    return new Response(
      JSON.stringify({
        ok: true,
        user: { id: me.id, name: me.name },
        permissions_detected: granted,
        permissions_missing: missing,
        ad_accounts,
        pages,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ ok: false, error: e?.message || "Erro inesperado" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
