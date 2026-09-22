import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// CAPTAÇÃO "COMPRAR" — a promotora, no totem, capta um COMPRADOR interessado num
// carro do estoque de uma loja da rede. Cria o lead, distribui pro tenant da loja
// (agente/grupo dela atende) e dá crédito de indicação à promotora.
//
// Reusa: distribuir-lead (roteia + avisa a loja) e repasse_track (atribuição).
// POST (JWT do usuário): { name, phone, target_tenant_id, vehicle_id?, loja?,
//                          marketplace_url?, titulo?, preco? }
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const LOG = "[captar-comprador]";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

async function resolveMember(sb: SupabaseClient, user: { id: string; email?: string }) {
  const cols = "id, tenant_id, role, name, repasse_code";
  if (user.email) {
    const { data } = await sb.from("team_members").select(cols).eq("email", user.email).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (data) return data as any;
  }
  const { data } = await sb.from("team_members").select(cols).eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
  return (data as any) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sem autenticação" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sessão inválida" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const member = await resolveMember(sb, user);
    if (!member) return json({ error: "Membro do time não encontrado" }, 403);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    const phone = digits(body.phone);
    const targetTenantId = String(body.target_tenant_id ?? "").trim();
    if (!name || phone.length < 10) return json({ error: "Nome e WhatsApp válidos são obrigatórios." }, 400);
    if (!targetTenantId) return json({ error: "Escolha a loja do carro." }, 400);

    const veiculo = {
      vehicle_id: (body.vehicle_id as string) || null,
      titulo: (body.titulo as string) || null,
      loja: (body.loja as string) || null,
      preco: (body.preco as string) || null,
      link: (body.marketplace_url as string) || null,
    };

    // 1. Cria o lead do comprador no tenant da promotora (master), com o carro de interesse.
    //    NÃO seta captured_by_member_id (isso é pra captação de consignação) — este é um
    //    comprador; a atribuição da promotora vai via metadata + repasse_track.
    const { data: lead, error: lErr } = await sb.from("leads").insert({
      tenant_id: member.tenant_id,
      name,
      phone,
      source: "totem-compra",
      utm_source: "totem-compra",
      metadata: {
        comprador: true,
        veiculo_interesse: veiculo,
        owner_tenant_id: targetTenantId,
        promoter_id: member.id,
        promoter_code: member.repasse_code ?? null,
        promoter_name: member.name ?? null,
      },
    }).select("id").single();
    if (lErr) return json({ error: `Falha ao criar o lead: ${lErr.message}` }, 500);

    // 2. Distribui pro tenant da loja (cria o lead lá + avisa o grupo/agente).
    let distribuido = false, notified = false;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/distribuir-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ lead_id: lead.id, target_tenant_id: targetTenantId, motivo: "Comprador captado no totem" }),
      });
      const r = await res.json().catch(() => ({}));
      distribuido = !!r?.success;
      notified = !!r?.notified;
    } catch (e) {
      console.warn(LOG, "distribuir-lead falhou:", e instanceof Error ? e.message : String(e));
    }

    // 3. Crédito de indicação à promotora (se ela tiver código de repasse).
    if (member.repasse_code) {
      const { error: tErr } = await sb.rpc("repasse_track", { p_code: member.repasse_code, p_phone: phone, p_name: name });
      if (tErr && !/inv[aá]lid/i.test(tErr.message)) console.warn(LOG, "repasse_track:", tErr.message);
    }

    console.log(LOG, `comprador captado lead=${lead.id} loja=${targetTenantId} distribuido=${distribuido}`);
    return json({ ok: true, lead_id: lead.id, distribuido, notified });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message }, 500);
  }
});
