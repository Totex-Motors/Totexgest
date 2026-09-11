import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  getSignatureProvider, saveWebhookSecret, SignatureConfigError, SignatureProviderError,
  type EnvelopeSignerInput, type SignatureProvider, type SignerAuth, type SignerChannel,
} from "../_shared/signature/index.ts";
import { hasTwoWords, normalizePhoneBR } from "../_shared/signature/clicksign.ts";
import { applyProviderEvent, CONTRACT_BUCKET, type ContractDocumentRow, reconcileDocument } from "../_shared/signature/reconcile.ts";

// INTERMEDIAÇÃO — Fase 3: envio do contrato pra assinatura eletrônica (Clicksign).
//
// Chamada pelo app com o JWT do usuário (verify_jwt = true). Só admin/comercial/closer.
// Body: { action, ...}
//   send            { document_id, signers:[{signer_id, channel, auth_method, email?, phone?}], deadline_days?, message? }
//   resend          { document_id, message? }
//   cancel          { document_id, reason }
//   status          { document_id }                       → reconcilia agora
//   register_webhook {}                                   → admin; grava CLICKSIGN_WEBHOOK_SECRET do tenant
//   test_connection {}
//
// Regras: chave por tenant (getIntegrationKey); RPCs de provedor via service_role; o
// "completed" do provedor não formaliza — só reconcileDocument() (baixa + confere o PDF).
// Nunca logar token/secret/PDF.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ALLOWED_ROLES = new Set(["admin", "comercial", "closer"]);
const ADMIN_ROLES = new Set(["admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CHANNELS = new Set<string>(["email", "whatsapp", "sms"]);
const AUTHS = new Set<string>(["email", "whatsapp", "sms", "pix"]);
const SENDABLE = new Set(["generated", "ready", "error"]);
const LOG = "[contract-send]";

interface Member { id: string; tenant_id: string; role: string; name: string | null }
interface SignerRow {
  id: string; party_type: string; name: string; cpf_cnpj: string | null; email: string | null; phone: string | null;
  signing_order: number; status: string; channel: string | null; auth_method: string | null; provider_signer_id: string | null;
}
interface SignerInput { signer_id?: unknown; channel?: unknown; auth_method?: unknown; email?: unknown; phone?: unknown }
interface RequestBody {
  action?: unknown; document_id?: unknown; signers?: unknown; deadline_days?: unknown; message?: unknown; reason?: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

async function resolveMember(sb: SupabaseClient, user: { id: string; email?: string }): Promise<Member | null> {
  const cols = "id, tenant_id, role, name";
  if (user.email) {
    const { data, error } = await sb.from("team_members").select(cols)
      .eq("email", user.email).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (error) console.error(LOG, "team_members por email:", error.message);
    if (data) return data as Member;
  }
  const { data, error } = await sb.from("team_members").select(cols)
    .eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
  if (error) console.error(LOG, "team_members por auth_user_id:", error.message);
  return (data as Member | null) ?? null;
}

function safeFilePart(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "contrato";
}

function optString(v: unknown, max = 500): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

async function loadDocument(sb: SupabaseClient, id: string, tenantId: string): Promise<ContractDocumentRow> {
  const { data, error } = await sb.from("contract_documents").select("*").eq("id", id).maybeSingle();
  if (error) throw new HttpError(500, `Erro ao buscar o documento: ${error.message}`);
  const doc = data as ContractDocumentRow | null;
  if (!doc || doc.tenant_id !== tenantId) throw new HttpError(404, "Documento não encontrado");
  return doc;
}

async function loadSigners(sb: SupabaseClient, documentId: string): Promise<SignerRow[]> {
  const { data, error } = await sb.from("contract_signers")
    .select("id, party_type, name, cpf_cnpj, email, phone, signing_order, status, channel, auth_method, provider_signer_id")
    .eq("document_id", documentId).order("signing_order");
  if (error) throw new HttpError(500, `Erro ao buscar signatários: ${error.message}`);
  return (data ?? []) as SignerRow[];
}

/** URL pública do projeto pro endpoint do webhook (SUPABASE_URL interno pode ser kong/localhost). */
async function publicProjectUrl(sb: SupabaseClient): Promise<string> {
  const internal = SUPABASE_URL.replace(/\/+$/, "");
  const looksLocal = /localhost|127\.0\.0\.1|kong|host\.docker\.internal/i.test(internal);
  const { data } = await sb.from("config").select("value").eq("key", "SUPABASE_PROJECT_URL").maybeSingle();
  const cfg = typeof data?.value === "string" ? data.value.trim().replace(/\/+$/, "") : "";
  if (cfg && /^https?:\/\//.test(cfg) && !cfg.includes("__REPLACE")) return cfg;
  if (!looksLocal && internal) return internal;
  return cfg || internal;
}

async function setStatus(sb: SupabaseClient, documentId: string, status: "cancelled" | "error" | "ready", reason: string | null, actor: string | null) {
  const { error } = await sb.rpc("contract_document_set_status", { p_document_id: documentId, p_status: status, p_reason: reason, p_actor: actor });
  if (error) console.error(LOG, `contract_document_set_status(${status}) falhou:`, error.message);
}

// ─── actions ─────────────────────────────────────────────────────────────────

async function actionSend(sb: SupabaseClient, member: Member, body: RequestBody, provider: SignatureProvider): Promise<Response> {
  const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
  if (!UUID_RE.test(documentId)) throw new HttpError(400, "document_id inválido");
  const doc = await loadDocument(sb, documentId, member.tenant_id);
  if (!SENDABLE.has(doc.status)) throw new HttpError(409, `Documento v${doc.version} não pode ser enviado (status ${doc.status})`, { status: doc.status });
  const renderedPath = typeof doc.rendered_file_path === "string" ? doc.rendered_file_path : "";
  if (!renderedPath) throw new HttpError(422, "Documento sem PDF gerado — gere o contrato antes de enviar");

  const days = Number.isFinite(Number(body.deadline_days)) ? Math.round(Number(body.deadline_days)) : 7;
  if (days < 1 || days > 30) throw new HttpError(400, "deadline_days precisa estar entre 1 e 30");
  const message = optString(body.message, 1000);

  // signatários: linha do banco + overrides do body
  const rows = await loadSigners(sb, documentId);
  if (!rows.length) throw new HttpError(422, "Documento sem signatários cadastrados — gere o contrato de novo");
  const inputs = new Map<string, SignerInput>();
  for (const s of (Array.isArray(body.signers) ? body.signers : []) as SignerInput[]) {
    if (s && typeof s.signer_id === "string") inputs.set(s.signer_id, s);
  }
  for (const id of inputs.keys()) if (!rows.some((r) => r.id === id)) throw new HttpError(400, `Signatário ${id} não pertence a este documento`);

  const errors: { signer_id: string; message: string }[] = [];
  const envelopeSigners: EnvelopeSignerInput[] = [];
  const updates: { id: string; email: string | null; phone: string | null }[] = [];
  const marks: { signer_id: string; channel: SignerChannel; auth_method: SignerAuth }[] = [];

  for (const row of rows) {
    const inp = inputs.get(row.id) ?? {};
    const channelRaw = optString(inp.channel, 20) ?? row.channel ?? "email";
    const authRaw = optString(inp.auth_method, 20) ?? row.auth_method ?? channelRaw;
    const email = (optString(inp.email, 200) ?? row.email ?? "").toLowerCase() || null;
    const phone = optString(inp.phone, 40) ?? row.phone ?? null;
    const label = row.party_type === "company" ? "Empresa" : row.party_type === "owner" ? "Proprietário" : row.party_type;

    if (!CHANNELS.has(channelRaw)) errors.push({ signer_id: row.id, message: `${label}: canal inválido (${channelRaw})` });
    if (!AUTHS.has(authRaw)) errors.push({ signer_id: row.id, message: `${label}: autenticação inválida (${authRaw})` });
    if (!hasTwoWords(row.name)) errors.push({ signer_id: row.id, message: `${label}: o nome precisa ter nome e sobrenome ("${row.name}")` });
    const needsEmail = channelRaw === "email" || authRaw === "email";
    const needsPhone = channelRaw === "whatsapp" || channelRaw === "sms" || authRaw === "whatsapp" || authRaw === "sms";
    if (needsEmail && !(email && EMAIL_RE.test(email))) errors.push({ signer_id: row.id, message: `${label}: e-mail obrigatório e válido para envio/autenticação por e-mail` });
    if (needsPhone && !normalizePhoneBR(phone)) errors.push({ signer_id: row.id, message: `${label}: telefone com DDD obrigatório para WhatsApp/SMS` });
    if (email && !EMAIL_RE.test(email)) errors.push({ signer_id: row.id, message: `${label}: e-mail inválido` });

    if (email !== (row.email ?? null) || phone !== (row.phone ?? null)) updates.push({ id: row.id, email, phone });
    const channel = channelRaw as SignerChannel;
    const auth = authRaw as SignerAuth;
    marks.push({ signer_id: row.id, channel, auth_method: auth });
    envelopeSigners.push({ ref: row.id, name: row.name, email, phone, cpf: row.cpf_cnpj, channel, auth });
  }
  if (errors.length) throw new HttpError(422, errors.map((e) => e.message).join(" · "), { errors });

  for (const u of updates) {
    const { error } = await sb.from("contract_signers").update({ email: u.email, phone: u.phone }).eq("id", u.id).eq("document_id", documentId);
    if (error) throw new HttpError(500, `Erro ao atualizar signatário: ${error.message}`);
  }

  // PDF gerado
  const { data: blob, error: dlErr } = await sb.storage.from(CONTRACT_BUCKET).download(renderedPath);
  if (dlErr || !blob) throw new HttpError(500, `Erro ao ler o PDF gerado: ${dlErr?.message ?? "arquivo vazio"}`);
  const pdfBytes = new Uint8Array(await blob.arrayBuffer());
  if (pdfBytes.byteLength < 100) throw new HttpError(500, "PDF gerado está vazio ou corrompido");

  const { data: inter } = await sb.from("intermediations").select("code").eq("id", doc.intermediation_id).maybeSingle();
  const code = String((inter as { code?: string } | null)?.code ?? doc.intermediation_id.slice(0, 8));
  const filename = `contrato-${safeFilePart(code)}-v${doc.version}.pdf`;
  const deadlineAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const envelopeName = `Contrato de Intermediação ${code} v${doc.version}`;

  const t0 = Date.now();
  let created;
  try {
    created = await provider.createEnvelope({ name: envelopeName, deadlineAt, pdfBytes, filename, signers: envelopeSigners, message });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG, `createEnvelope ${code} v${doc.version} falhou:`, msg);
    await setStatus(sb, documentId, "error", msg.slice(0, 500), member.id);
    throw err;
  }
  console.log(LOG, `envelope ${created.envelopeId} criado p/ ${code} v${doc.version} (${pdfBytes.byteLength} bytes, ${envelopeSigners.length} signers) em ${Date.now() - t0}ms`);

  const providerIds = new Map(created.signers.map((s) => [s.ref, s.providerSignerId]));
  const pSigners = marks.map((m) => ({ ...m, provider_signer_id: providerIds.get(m.signer_id) ?? null }));
  const meta = {
    provider_env: provider.env, envelope_name: envelopeName, filename, deadline_days: days, message: message ?? null,
    warnings: created.warnings, sent_by: member.id,
  };
  const { error: markErr } = await sb.rpc("contract_document_mark_sent", {
    p_document_id: documentId, p_provider: provider.name, p_envelope_id: created.envelopeId, p_provider_document_id: created.documentId,
    p_signers: pSigners, p_deadline_at: deadlineAt, p_meta: meta, p_actor: member.id,
  });
  if (markErr) {
    console.error(LOG, "contract_document_mark_sent falhou; cancelando envelope:", markErr.message);
    try { await provider.cancel(created.envelopeId, "falha ao registrar envio"); } catch (cErr) { console.warn(LOG, "cancel após falha:", cErr instanceof Error ? cErr.message : String(cErr)); }
    await setStatus(sb, documentId, "error", `Erro ao registrar o envio: ${markErr.message}`.slice(0, 500), member.id);
    throw new HttpError(500, `Erro ao registrar o envio: ${markErr.message}`);
  }

  const document = await loadDocument(sb, documentId, member.tenant_id);
  console.log(LOG, `documento ${documentId} v${doc.version} enviado por ${member.name ?? member.id} — envelope ${created.envelopeId}`);
  return json({ ok: true, document, envelope_id: created.envelopeId, warnings: created.warnings });
}

async function actionResend(sb: SupabaseClient, member: Member, body: RequestBody, provider: SignatureProvider): Promise<Response> {
  const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
  if (!UUID_RE.test(documentId)) throw new HttpError(400, "document_id inválido");
  const doc = await loadDocument(sb, documentId, member.tenant_id);
  if (!["sent", "partial"].includes(doc.status)) throw new HttpError(409, `Documento v${doc.version} não está aguardando assinatura (status ${doc.status})`);
  if (!doc.provider_envelope_id) throw new HttpError(409, "Documento sem envelope no provedor");
  const message = optString(body.message, 1000);
  const { notified } = await provider.notify(doc.provider_envelope_id, message);
  try {
    await applyProviderEvent(sb, documentId, {
      provider: provider.name, provider_event_id: `resend:${doc.provider_envelope_id}:${Date.now()}`, event_type: "info", raw_event_name: "resend",
      payload: { source: "user", message: "Convites reenviados", notified, by: member.id },
    });
  } catch (err) {
    console.warn(LOG, "log do reenvio:", err instanceof Error ? err.message : String(err));
  }
  console.log(LOG, `convites reenviados doc ${documentId} (notificados ${notified}) por ${member.id}`);
  return json({ ok: true, notified, document: await loadDocument(sb, documentId, member.tenant_id) });
}

async function actionCancel(sb: SupabaseClient, member: Member, body: RequestBody, provider: SignatureProvider | null): Promise<Response> {
  const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
  if (!UUID_RE.test(documentId)) throw new HttpError(400, "document_id inválido");
  const reason = optString(body.reason, 500);
  if (!reason || reason.length < 3) throw new HttpError(400, "Informe o motivo do cancelamento");
  const doc = await loadDocument(sb, documentId, member.tenant_id);
  if (doc.status === "validated") throw new HttpError(409, "Contrato já assinado e validado — não pode ser cancelado");
  if (doc.status === "completed") throw new HttpError(409, "Todos já assinaram — aguarde a validação do PDF (use \"Verificar agora\")");
  if (["cancelled", "declined", "expired"].includes(doc.status)) return json({ ok: true, already: true, document: doc });

  if (doc.provider_envelope_id) {
    if (!provider) throw new HttpError(422, "Chave da Clicksign não configurada — não dá pra cancelar no provedor");
    await provider.cancel(doc.provider_envelope_id, reason); // "já cancelado" não lança
  }
  const { error } = await sb.rpc("contract_document_set_status", { p_document_id: documentId, p_status: "cancelled", p_reason: reason, p_actor: member.id });
  if (error) throw new HttpError(500, `Erro ao cancelar o documento: ${error.message}`);
  console.log(LOG, `documento ${documentId} cancelado por ${member.id}`);
  return json({ ok: true, document: await loadDocument(sb, documentId, member.tenant_id) });
}

async function actionStatus(sb: SupabaseClient, member: Member, body: RequestBody, provider: SignatureProvider): Promise<Response> {
  const documentId = typeof body.document_id === "string" ? body.document_id.trim() : "";
  if (!UUID_RE.test(documentId)) throw new HttpError(400, "document_id inválido");
  const doc = await loadDocument(sb, documentId, member.tenant_id);
  if (!doc.provider_envelope_id) throw new HttpError(409, "Documento ainda não foi enviado para assinatura");
  const r = await reconcileDocument(sb, provider, doc);
  return json({ ok: true, document: r.document, applied: r.applied, finalized: r.finalized, provider_status: r.providerStatus, skipped: r.skipped ?? null });
}

async function actionRegisterWebhook(sb: SupabaseClient, member: Member, provider: SignatureProvider): Promise<Response> {
  if (!ADMIN_ROLES.has(member.role)) throw new HttpError(403, "Só o administrador registra o webhook");
  const base = await publicProjectUrl(sb);
  if (!/^https?:\/\//.test(base)) throw new HttpError(500, "URL pública do projeto desconhecida (config.SUPABASE_PROJECT_URL)");
  const endpoint = `${base}/functions/v1/clicksign-webhook`;
  const reg = await provider.registerWebhook(endpoint);
  await saveWebhookSecret(sb, member.tenant_id, reg.secret);
  console.log(LOG, `webhook ${reg.webhookId} registrado (${provider.env}) p/ tenant ${member.tenant_id} → ${endpoint}`);
  return json({ ok: true, webhook_id: reg.webhookId, endpoint, env: provider.env, events: reg.events });
}

// ─── server ──────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) {
    console.error(LOG, "variáveis SUPABASE_* ausentes");
    return json({ error: "Função sem configuração do Supabase" }, 500);
  }

  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sem autenticação" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const member = await resolveMember(sb, user);
    if (!member) return json({ error: "Membro do time não encontrado" }, 403);
    if (!ALLOWED_ROLES.has(member.role)) {
      console.warn(LOG, `membro ${member.id} (${member.role}) tentou usar assinatura eletrônica`);
      return json({ error: "Seu perfil não pode enviar contratos para assinatura" }, 403);
    }

    const body: RequestBody = await req.json().catch(() => ({}));
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (action === "cancel") {
      let provider: SignatureProvider | null = null;
      try { provider = await getSignatureProvider(sb, member.tenant_id); } catch (err) {
        if (!(err instanceof SignatureConfigError)) throw err;
      }
      return await actionCancel(sb, member, body, provider);
    }

    const provider = await getSignatureProvider(sb, member.tenant_id);
    switch (action) {
      case "send": return await actionSend(sb, member, body, provider);
      case "resend": return await actionResend(sb, member, body, provider);
      case "status": return await actionStatus(sb, member, body, provider);
      case "register_webhook": return await actionRegisterWebhook(sb, member, provider);
      case "test_connection": {
        const r = await provider.testConnection();
        return json({ ok: r.ok, env: r.env, detail: r.detail ?? null, error: r.ok ? undefined : r.detail });
      }
      default: return json({ error: `Ação desconhecida: ${action || "(vazia)"}` }, 400);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      console.error(LOG, err.status, err.message);
      return json({ error: err.message, ...err.extra }, err.status);
    }
    if (err instanceof SignatureConfigError) return json({ error: err.message, code: "not_configured" }, 412);
    if (err instanceof SignatureProviderError) {
      console.error(LOG, "provedor:", err.status, err.message);
      return json({ error: err.message, code: err.code, provider_status: err.status }, 502);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro inesperado:", message);
    return json({ error: `Erro na assinatura eletrônica: ${message}` }, 500);
  }
});
