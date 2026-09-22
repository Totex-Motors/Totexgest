import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// REPASSE — reconcilia "entrou no grupo" (belt-and-suspenders do webhook).
//
// O evento de participante em tempo real do WhatsApp é frágil (o novo formato
// LID não traz o telefone → não casa). Aqui a gente PUXA a lista de participantes
// do grupo de repasse pela UAZAPI (/group/list) e marca como 'joined' toda
// indicação cujo telefone está no grupo. Idempotente (repasse_register_join só
// avança quem está em 'confirmed'). Roda por cron.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[repasse-reconcile-joins]";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// extrai só os dígitos de um participante (string ou objeto), tirando @lid/@s.whatsapp.net
function participantDigits(p: any): string {
  const s = typeof p === "string" ? p : String(p?.JID || p?.jid || p?.id || p?.phone || p?.number || "");
  return s.replace(/@.*$/, "").replace(/\D/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const { data: cfg } = await sb.from("config").select("value").eq("key", "REPASSE_GROUP_JID").maybeSingle();
    const groupJid = (cfg?.value || "").trim();
    if (!groupJid) return json({ ok: false, motivo: "REPASSE_GROUP_JID não configurado." });

    // Instância (UAZAPI) que enxerga esse grupo — vem do sync de grupos.
    const { data: grp } = await sb.from("whatsapp_groups")
      .select("instance_id, tenant_id")
      .eq("group_jid", groupJid)
      .limit(1).maybeSingle();
    if (!grp?.instance_id) {
      return json({ ok: false, motivo: "Grupo de repasse ainda não sincronizado (rode o sync de grupos primeiro)." });
    }

    const { data: inst } = await sb.from("whatsapp_instances")
      .select("api_url, api_key, provider, status, tenant_id")
      .eq("id", grp.instance_id).maybeSingle();
    if (!inst?.api_url || !inst?.api_key) {
      return json({ ok: false, motivo: "Instância do grupo sem credenciais." });
    }

    // Puxa os grupos da UAZAPI e acha o de repasse (com participantes)
    const res = await fetch(`${inst.api_url}/group/list`, { headers: { Accept: "application/json", token: inst.api_key } });
    if (!res.ok) return json({ ok: false, motivo: `UAZAPI /group/list falhou (${res.status})` }, 502);
    const raw = await res.json().catch(() => null);
    const groups: any[] = Array.isArray(raw) ? raw : (raw?.groups || []);
    const jidBare = groupJid.replace("@g.us", "");
    const group = groups.find((g) => String(g?.JID || g?.id || "").includes(jidBare));
    if (!group) return json({ ok: false, motivo: "Grupo de repasse não veio no /group/list dessa instância." });

    const participants: any[] = group.Participants || group.participants || [];
    const tenantId = grp.tenant_id || inst.tenant_id;

    let phones = 0, marcados = 0;
    for (const p of participants) {
      const digits = participantDigits(p);
      if (digits.length < 10) continue; // LID/algo estranho → repasse_register_join ignora de qualquer jeito
      phones++;
      const { data, error } = await sb.rpc("repasse_register_join", { p_tenant: tenantId, p_phone: digits });
      if (!error && (data as any)?.matched) marcados += (data as any).matched;
    }

    console.log(LOG, `participantes=${participants.length} telefones=${phones} novos_joined=${marcados}`);
    return json({ ok: true, participantes: participants.length, novos_joined: marcados });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ ok: false, error: message }, 500);
  }
});
