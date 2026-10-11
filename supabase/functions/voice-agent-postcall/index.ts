/**
 * voice-agent-postcall — recebe o PÓS-CHAMADA da ElevenLabs (Nina voz) e grava a
 * ligação no CRM: `call_history` (aparece na timeline do lead como "Chamada Recebida"
 * com resumo e transcrição) + lead pela porta única. Fase 2 — docs/NINA-VOZ.md.
 *
 * Webhook configurado na ElevenLabs (Agents › Settings › Post-call webhooks):
 *   URL: https://<projeto>.supabase.co/functions/v1/voice-agent-postcall
 *   Tipos: post_call_transcription (usa) · post_call_audio (ignora) · call_initiation_failure (loga)
 *
 * Segurança: assinatura HMAC no header `ElevenLabs-Signature: t=<unix>,v0=<hex>`,
 * hex = HMAC-SHA256(secret, `${t}.${rawBody}`). Secret em config ELEVENLABS_WEBHOOK_SECRET.
 * Sem secret configurado = 401 (fail closed). Idempotente por conversation_id.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const MAX_SKEW_SEC = 30 * 60;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function normalizePhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/^(sip|sips|tel):/i, "").split("@")[0].replace(/\D/g, "");
  if (!d) return "";
  if (!d.startsWith("55") && (d.length === 10 || d.length === 11)) d = "55" + d;
  return d;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function verifySignature(header: string | null, rawBody: string, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = parts["t"];
  const v0 = parts["v0"];
  if (!t || !v0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > MAX_SKEW_SEC) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v0.toLowerCase());
}

/** Telefone do cliente: dynamic var da ElevenLabs (SIP) ou campos de telefonia do payload. */
function extractCallerPhone(data: any): string {
  const dv = data?.conversation_initiation_client_data?.dynamic_variables || {};
  const md = data?.metadata || {};
  const candidates = [
    dv.system__caller_id, dv.caller_phone, dv.caller_id,
    md.phone_call?.external_number, md.phone_call?.from_number, md.phone_call?.caller_number,
    md.from_number, md.caller_id, data?.from_number,
  ];
  for (const c of candidates) { const p = normalizePhone(c); if (p.length >= 10) return p; }
  return "";
}

function transcriptToRows(transcript: any[]): { role: string; text: string; at_sec: number | null }[] {
  return (Array.isArray(transcript) ? transcript : [])
    .filter((t) => t && (t.message || t.text))
    .map((t) => ({
      role: t.role === "agent" ? "agent" : "user",
      text: String(t.message ?? t.text ?? "").trim(),
      at_sec: Number.isFinite(Number(t.time_in_call_secs)) ? Number(t.time_in_call_secs) : null,
    }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, fn: "voice-agent-postcall" });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const rawBody = await req.text();
  const secret = await getIntegrationKey(sb, "ELEVENLABS_WEBHOOK_SECRET");
  if (!secret) { console.error("[voice-postcall] ELEVENLABS_WEBHOOK_SECRET ausente"); return json({ error: "webhook secret not configured" }, 401); }
  const ok = await verifySignature(req.headers.get("ElevenLabs-Signature") || req.headers.get("elevenlabs-signature"), rawBody, secret);
  if (!ok) { console.warn("[voice-postcall] assinatura inválida"); return json({ error: "invalid signature" }, 401); }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: "invalid json" }, 400); }
  const type = payload?.type;
  const data = payload?.data || {};

  if (type === "post_call_audio") return json({ ignored: true, type });
  if (type === "call_initiation_failure") {
    console.error("[voice-postcall] call_initiation_failure:", JSON.stringify(data).slice(0, 500));
    return json({ logged: true, type });
  }
  if (type !== "post_call_transcription") return json({ ignored: true, type });

  const conversationId = String(data.conversation_id || "");
  if (!conversationId) return json({ error: "conversation_id ausente" }, 400);

  // Idempotência (ElevenLabs reenvia em falha)
  const { data: dup } = await sb.from("call_history").select("id").contains("metadata", { conversation_id: conversationId }).limit(1).maybeSingle();
  if (dup) return json({ ok: true, duplicate: true, call_id: dup.id });

  const phone = extractCallerPhone(data);
  const tenantId = (await getIntegrationKey(sb, "VOICE_AGENT_TENANT_ID")) || HQ_TENANT;

  let leadId: string | null = null;
  if (phone) {
    const { data: r, error } = await sb.rpc("find_or_create_lead", {
      p_tenant: tenantId, p_phone: phone, p_name: null, p_source: "ligacao_ia", p_email: null,
      p_utm_source: "whatsapp_call", p_metadata: { origin: "nina-voz" }, p_lead_kind: "buyer",
    });
    if (error) console.error("[voice-postcall] find_or_create_lead:", error.message);
    leadId = r?.lead_id || null;
  }

  const md = data.metadata || {};
  const analysis = data.analysis || {};
  const duration = Number(md.call_duration_secs) || 0;
  const startedAt = md.start_time_unix_secs ? new Date(Number(md.start_time_unix_secs) * 1000) : new Date(Date.now() - duration * 1000);
  const endedAt = new Date(startedAt.getTime() + duration * 1000);
  const rows = transcriptToRows(data.transcript);
  const transcription = rows.map((r) => `${r.role === "agent" ? "Nina" : "Cliente"}: ${r.text}`).join("\n");
  const summary = analysis.transcript_summary || null;
  const successful = analysis.call_successful || null;

  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number").eq("provider", "meta_cloud").limit(1).maybeSingle();

  const { data: call, error } = await sb.from("call_history").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    call_type: "whatsapp_ai",
    direction: "INCOMING",
    status: duration > 0 ? "ENDED" : "NOT_ANSWERED",
    caller_phone: phone || null,
    receiver_phone: inst?.phone_number || null,
    peer_phone: phone || null,
    duration_seconds: duration,
    record_status: "DISABLED",
    transcription: transcription || null,
    transcriptions: rows,
    ai_summary: summary,
    ai_sentiment: successful === "success" ? "positive" : successful === "failure" ? "negative" : null,
    ai_key_points: analysis.data_collection_results || null,
    ai_processed_at: summary ? new Date().toISOString() : null,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    metadata: {
      source: "nina-voz",
      provider: "elevenlabs",
      conversation_id: conversationId,
      agent_id: data.agent_id || null,
      call_successful: successful,
      termination_reason: md.termination_reason || null,
      cost: md.cost ?? null,
      evaluation: analysis.evaluation_criteria_results || null,
    },
  }).select("id").single();
  if (error) { console.error("[voice-postcall] call_history:", error.message); return json({ error: error.message }, 500); }

  if (leadId) {
    await sb.from("leads").update({ last_interaction_at: new Date().toISOString() }).eq("id", leadId);
  }

  console.log(`[voice-postcall] ligação gravada ${call.id} lead=${leadId || "-"} ${duration}s conv=${conversationId}`);
  return json({ ok: true, call_id: call.id, lead_id: leadId, duration });
});
