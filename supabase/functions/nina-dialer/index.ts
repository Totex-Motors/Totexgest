/**
 * nina-dialer — a Nina LIGA pro cliente (Fase B — docs/NINA-VOZ.md §2d).
 *
 * Cron a cada 2 min (pg_cron → POST com header x-voice-token = config VOICE_AGENT_TOKEN).
 * Lê `nina_call_queue`, respeita: chave mestra NINA_OUTBOUND_ENABLED='true', horário
 * comercial do SLA (next_business_time), 1 ligação por vez (WaVoIP = 1 canal), permissão
 * de ligação da Meta (GET /{phone_number_id}/call_permissions). Sem permissão → manda o
 * pedido de permissão (interactive call_permission_request, 1 por 24h / 2 por 7 dias) e
 * espera a resposta (webhook → fila volta pra 'queued').
 *
 * Disca pela ElevenLabs: POST /v1/convai/sip-trunk/outbound-call (ElevenLabs → tronco SIP
 * da WaVoIP → Meta, ligação business-initiated). Passa o dossiê como dynamic variables
 * (customer_phone, customer_name, playbook) e a 1ª frase por playbook.
 *
 * Resultado volta pelo voice-agent-postcall (duração/outcome → fila done/no_answer, retry).
 * Aqui só expira tentativas travadas ('calling' > 15 min sem retorno).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { buildLeadBrief } from "../_shared/lead-brief.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const ELEVEN = "https://api.elevenlabs.io/v1";
const GRAPH = "https://graph.facebook.com/v22.0";
const STALE_CALLING_MIN = 15;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function firstMessageFor(playbook: string | null, nome: string, extra: { promotora?: string | null; local?: string | null; carro?: string | null; loja?: string | null }): string {
  const oi = nome ? `Oi, ${nome}! ` : "Oi! ";
  const base = `${oi}Aqui é a Nina, da Totex Motors. Tudo bem? `;
  switch (playbook) {
    case "vender":
      return base + (extra.promotora ? `Você conversou com a ${extra.promotora}${extra.local ? ` no ${extra.local}` : " no nosso stand"} sobre vender o seu carro, né? Posso te explicar rapidinho como funciona?` : "Você deixou seu contato com a gente sobre vender o seu carro, né? Posso te explicar rapidinho como funciona?");
    case "trocar":
      return base + (extra.carro ? `Você falou com a gente sobre trocar o seu ${extra.carro}, né? Tenho novidade boa pra você. Tem um minutinho?` : "Você falou com a gente sobre trocar de carro, né? Tem um minutinho?");
    case "comprar":
      return base + (extra.carro ? `Vi que você se interessou pelo ${extra.carro}${extra.loja ? ` na ${extra.loja}` : ""}. Ele ainda está disponível. Posso te ajudar a ver ele de perto?` : "Vi que você se interessou por um carro com a gente. Posso te ajudar?");
    default:
      return base + "Você deixou seu contato com a gente. Está pensando em vender, trocar ou comprar um carro?";
  }
}

Deno.serve(async (req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const expected = await getIntegrationKey(sb, "VOICE_AGENT_TOKEN");
  const got = req.headers.get("x-voice-token") || "";
  if (!expected || got.trim() !== expected.trim()) return json({ error: "unauthorized" }, 401);

  // 0. tentativas travadas
  const staleBefore = new Date(Date.now() - STALE_CALLING_MIN * 60_000).toISOString();
  await sb.from("nina_call_queue").update({ status: "no_answer", last_error: "sem retorno da ligação em 15 min" })
    .eq("status", "calling").lt("last_attempt_at", staleBefore);

  const enabled = (await getIntegrationKey(sb, "NINA_OUTBOUND_ENABLED")) === "true";
  if (!enabled) return json({ skipped: "NINA_OUTBOUND_ENABLED != true" });

  // 1. horário da NINA (config NINA_HORARIO_*; padrão todo dia 10h–22h = shopping) — vale pras
  //    ligações AUTOMÁTICAS. Pedido manual (botão) liga agora.
  const { data: nbt } = await sb.rpc("nina_business_time", { p_ts: new Date().toISOString() });
  const outsideHours = !!nbt && new Date(nbt).getTime() > Date.now() + 60_000;

  // 2. 1 por vez
  const { data: active } = await sb.from("nina_call_queue").select("id").eq("status", "calling").limit(1);
  if (active && active.length) return json({ skipped: "ligação em curso" });

  let q = sb.from("nina_call_queue").select("*")
    .eq("status", "queued").lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true }).limit(1);
  if (outsideHours) q = q.eq("reason", "manual");
  const { data: row } = await q.maybeSingle();
  if (!row) return json({ idle: true, outside_hours: outsideHours, next: nbt });

  const log = (msg: string) => console.log(`[nina-dialer] ${row.id} ${msg}`);
  const fail = async (status: string, err: string) => {
    await sb.from("nina_call_queue").update({ status, last_error: err }).eq("id", row.id);
    log(`${status}: ${err}`);
    return json({ id: row.id, status, error: err });
  };

  // 3. credenciais
  const tenantId = row.tenant_id || HQ_TENANT;
  const waToken = await getIntegrationKey(sb, "WHATSAPP_CLOUD_TOKEN", tenantId);
  const phoneNumberId = await getIntegrationKey(sb, "WHATSAPP_PHONE_NUMBER_ID", tenantId);
  const elevenKey = await getIntegrationKey(sb, "ELEVENLABS_API_KEY", HQ_TENANT);
  const agentId = await getIntegrationKey(sb, "VOICE_ELEVEN_AGENT_ID");
  const elevenPhoneId = await getIntegrationKey(sb, "VOICE_ELEVEN_PHONE_ID");
  if (!waToken || !phoneNumberId) return fail("failed", "sem WHATSAPP_CLOUD_TOKEN/PHONE_NUMBER_ID");
  if (!elevenKey || !agentId || !elevenPhoneId) return fail("failed", "ElevenLabs não provisionada (agente/número)");

  // 4. permissão de ligação (Meta)
  const permRes = await fetch(`${GRAPH}/${phoneNumberId}/call_permissions?user_wa_id=${row.phone}`, { headers: { Authorization: `Bearer ${waToken}` } });
  const perm = await permRes.json().catch(() => ({}));
  const status = String(perm?.permission?.status || "no_permission");
  const actions: any[] = Array.isArray(perm?.actions) ? perm.actions : [];
  const canCall = actions.find((a) => a.action_name === "start_call")?.can_perform_action !== false && status !== "no_permission";
  const canAsk = actions.find((a) => a.action_name === "send_call_permission_request")?.can_perform_action !== false;
  log(`permissão: ${status} canCall=${canCall} canAsk=${canAsk} (${permRes.status})`);

  const brief = await buildLeadBrief(sb, row.lead_id).catch(() => null);
  const nome = brief?.primeiro_nome || "";

  if (!canCall) {
    if (row.permission_requested_at && Date.now() - new Date(row.permission_requested_at).getTime() < 7 * 86400_000 && row.status === "queued" && row.attempts === 0 && !canAsk) {
      return fail("expired", "cliente não autorizou a ligação");
    }
    if (!canAsk) return fail("expired", `sem permissão e sem poder pedir (${status})`);
    // pede permissão (free-form: precisa da janela de 24h aberta — o lead acabou de falar com a gente)
    const assunto = row.playbook === "vender" ? "a venda do seu carro" : row.playbook === "trocar" ? "a troca do seu carro" : row.playbook === "comprar" ? (brief?.carro_interesse ? `o ${brief.carro_interesse}` : "o carro que você viu") : "o seu carro";
    const texto = `${nome ? `Oi, ${nome}! ` : "Oi! "}Aqui é a Nina, da Totex Motors. Posso te ligar rapidinho pra falar sobre ${assunto}? É só tocar em permitir. 😊`;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      body: JSON.stringify({ action: "send_call_permission", phone: row.phone, text: texto, lead_id: row.lead_id, tenant_id: tenantId, sent_by: "nina_dialer" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) return fail("failed", `pedido de permissão falhou: ${JSON.stringify(data).slice(0, 200)}`);
    await sb.from("nina_call_queue").update({ status: "awaiting_permission", permission_requested_at: new Date().toISOString() }).eq("id", row.id);
    log("pedido de permissão enviado");
    return json({ id: row.id, status: "awaiting_permission" });
  }

  // 5. liga
  const attempts = Number(row.attempts || 0) + 1;
  await sb.from("nina_call_queue").update({ status: "calling", attempts, last_attempt_at: new Date().toISOString(), playbook: brief?.playbook || row.playbook }).eq("id", row.id);
  const firstMessage = firstMessageFor(brief?.playbook || row.playbook, nome, {
    promotora: brief?.promotora ? brief.promotora.split(/\s+/)[0] : null, local: brief?.local_captacao || null,
    carro: brief?.carro_do_cliente?.descricao || brief?.carro_interesse || null, loja: brief?.loja_referencia || null,
  });
  const call = await fetch(`${ELEVEN}/convai/sip-trunk/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": elevenKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      agent_phone_number_id: elevenPhoneId,
      to_number: `+${row.phone}`,
      conversation_initiation_client_data: {
        dynamic_variables: { customer_phone: row.phone, customer_name: nome, playbook: brief?.playbook || row.playbook || "descobrir", reason: row.reason || "" },
        conversation_config_override: { agent: { first_message: firstMessage } },
      },
      telephony_call_config: { ringing_timeout_secs: 35 },
    }),
  });
  const callData = await call.json().catch(() => ({}));
  if (!call.ok || callData?.success === false) {
    const err = `ElevenLabs ${call.status}: ${JSON.stringify(callData).slice(0, 300)}`;
    const retry = attempts < Number(row.max_attempts || 3);
    const { data: next } = await sb.rpc("nina_business_time", { p_ts: new Date(Date.now() + 2 * 3600_000).toISOString() });
    await sb.from("nina_call_queue").update({ status: retry ? "queued" : "failed", scheduled_for: next || new Date().toISOString(), last_error: err }).eq("id", row.id);
    log(`erro ao discar: ${err}`);
    return json({ id: row.id, status: retry ? "queued" : "failed", error: err }, 502);
  }
  await sb.from("nina_call_queue").update({ conversation_id: callData.conversation_id || null, metadata: { ...(row.metadata || {}), sip_call_id: callData.sip_call_id || null, first_message: firstMessage } }).eq("id", row.id);
  log(`discando conv=${callData.conversation_id}`);
  return json({ id: row.id, status: "calling", conversation_id: callData.conversation_id });
});
