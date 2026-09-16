import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { uazapiTargetAllowed } from "../_shared/wa-policy.ts";

// SEGUNDO CÉREBRO — Briefing matinal automático no grupo de gestão.
// Chamado por cron (pg_cron → pg_net). Monta a foto da operação, pede um
// "bom dia" curto pra IA e posta no grupo do cérebro (só-grupo, regra respeitada).
// Config: MCP_BOT_GROUP_JID + MCP_BOT_INSTANCE_ID (qual instância envia).

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";
const LOG = "[daily-brain-briefing]";

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const { data: cfg } = await sb.from("config").select("key,value").in("key", ["MCP_BOT_GROUP_JID", "MCP_BOT_INSTANCE_ID"]);
    const map: Record<string, string> = {};
    for (const r of (cfg || [])) map[r.key] = r.value;
    const groupJid = (map["MCP_BOT_GROUP_JID"] || "").trim();
    const instanceId = (map["MCP_BOT_INSTANCE_ID"] || "").trim();
    if (!groupJid || !instanceId) return json({ ok: false, error: "MCP_BOT_GROUP_JID/INSTANCE_ID ausente" }, 200);

    const { data: inst } = await sb.from("whatsapp_instances").select("id, api_url, api_key, tenant_id, provider, group_only").eq("id", instanceId).maybeSingle();
    if (!inst?.api_url || !inst?.api_key || !inst?.tenant_id) return json({ ok: false, error: "instância do bot não encontrada" }, 200);

    const { data: snap, error: snapErr } = await sb.rpc("mcp_bot_snapshot", { p_tenant: inst.tenant_id });
    if (snapErr || !snap) return json({ ok: false, error: "snapshot falhou" }, 200);

    const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", inst.tenant_id);
    if (!anthropicKey) return json({ ok: false, error: "ANTHROPIC_API_KEY ausente" }, 200);

    const system =
      "Você é o *Segundo Cérebro* da TotexMotors (venda e intermediação de veículos). Escreva um *briefing matinal* CURTO pro gestor no WhatsApp, com base SOMENTE nos dados do JSON. " +
      "Comece com um bom-dia. Destaque o que precisa de atenção HOJE (tarefas atrasadas, aprovações esperando, deals parados). Use *asterisco* pra negrito, no máx 2-3 emojis, listas curtas. " +
      "Termine com *1-2 prioridades do dia*. Se estiver tudo tranquilo, diga isso de forma leve. Português do Brasil. Não exponha ids técnicos.";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: `Dados da operação agora (JSON):\n${JSON.stringify(snap)}` }] }),
    });
    if (!res.ok) { console.error(LOG, "anthropic", res.status, (await res.text()).slice(0, 200)); return json({ ok: false, error: "anthropic falhou" }, 200); }
    const data = await res.json();
    const briefing = String(data?.content?.[0]?.text ?? "").trim();
    if (!briefing) return json({ ok: false, error: "briefing vazio" }, 200);

    const allowed = await uazapiTargetAllowed(sb, { id: inst.id, provider: inst.provider, group_only: inst.group_only }, groupJid, "daily-brain-briefing", briefing);
    if (!allowed) return json({ ok: false, error: "política bloqueou (não é grupo)" }, 200);
    const sent = await fetch(`${inst.api_url}/send/text`, { method: "POST", headers: { "Content-Type": "application/json", token: inst.api_key }, body: JSON.stringify({ number: groupJid, text: briefing }) });
    if (!sent.ok) { console.error(LOG, "send", sent.status, (await sent.text()).slice(0, 200)); return json({ ok: false, error: "envio falhou" }, 200); }
    return json({ ok: true });
  } catch (e) {
    console.error(LOG, "erro", (e as Error)?.message);
    return json({ ok: false, error: "erro inesperado" }, 200);
  }
});
