// INTERMEDIAÇÃO — Fase 3: provedor Clicksign (API v3, envelopes).
//
// Doc: https://developers.clicksign.com (reference/api-criar-envelope, api-upload-documentos,
// api-criar-signatario, criar-requisito-qualificacao, criar-requisito-de-autenticacao,
// api-editar-envelope, api-notificar-envelope, api-criar-webhook, docs/seguranca-de-webhooks).
//
//   • Base: sandbox https://sandbox.clicksign.com · produção https://app.clicksign.com
//   • Headers: Authorization: <access_token> (sem "Bearer"), Content-Type/Accept application/vnd.api+json
//   • JSON:API: {data:{type, attributes, relationships}}
//   • Webhook: header Content-Hmac: sha256=<hex>, HMAC-SHA256(raw body, secret)
//
// NUNCA logar o token, o secret, o HMAC ou o conteúdo do PDF.

import {
  type CreateEnvelopeInput, type CreateEnvelopeResult, type EnvelopeSignerStatus, type EnvelopeStatus,
  type EnvelopeStatusResult, type ParsedWebhook, type ProviderEventType, type SignatureProvider,
  SignatureProviderError, type WebhookRegistration,
} from "./provider.ts";

const LOG = "[clicksign]";
const REQUEST_TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const JSONAPI = "application/vnd.api+json";

export const CLICKSIGN_BASE_URL: Record<"sandbox" | "production", string> = {
  sandbox: "https://sandbox.clicksign.com",
  production: "https://app.clicksign.com",
};

/** Eventos que registramos no webhook (nomes da Clicksign). */
export const CLICKSIGN_WEBHOOK_EVENTS = [
  "upload", "add_signer", "remove_signer", "signature_started", "sign", "refusal",
  "auto_close", "close", "document_closed", "cancel", "deadline", "update_deadline",
];

// ─── helpers puros (testáveis sem rede) ──────────────────────────────────────

/** Telefone BR pra Clicksign: 10–11 dígitos (DDD + número), SEM o DDI 55. Retorna null se inválido. */
export function normalizePhoneBR(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("0") && d.length > 11) d = d.replace(/^0+/, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10 || d.length > 11) return null;
  return d;
}

/** CPF formatado 000.000.000-00 (só 11 dígitos). CNPJ/inválido → null (has_documentation:false). */
export function formatCpf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function hasTwoWords(name: string | null | undefined): boolean {
  return String(name ?? "").trim().split(/\s+/).filter((w) => w.length > 0).length >= 2;
}

/** Nome de evento da Clicksign → event_type normalizado (contract_apply_provider_event). */
export function mapClicksignEvent(name: string | null | undefined): ProviderEventType {
  switch (String(name ?? "").toLowerCase()) {
    case "sign": return "signed";
    case "refusal": return "refused";
    case "cancel": return "canceled";
    case "deadline": return "expired";
    case "auto_close":
    case "close":
    case "document_closed":
      return "completed";
    case "signature_started": return "viewed";
    default: return "info"; // upload, add_signer, remove_signer, update_deadline, custom, add_image, ...
  }
}

export function mapEnvelopeStatus(s: unknown): EnvelopeStatus {
  const v = String(s ?? "").toLowerCase();
  if (v === "running" || v === "closed" || v === "canceled" || v === "draft") return v;
  if (v === "cancelled") return "canceled";
  if (v === "finished" || v === "signed") return "closed";
  return "draft";
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Comparação em tempo constante (strings hex/ASCII). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Extrai o hex da assinatura do header (aceita "sha256=<hex>" ou só "<hex>"). */
export function extractSignature(headers: Headers): string | null {
  const raw = headers.get("content-hmac") ?? headers.get("x-clicksign-signature") ?? headers.get("x-hub-signature-256");
  if (!raw) return null;
  const m = raw.trim().match(/^(?:sha256=)?([0-9a-fA-F]{64})$/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Valida o webhook. Principal: HMAC-SHA256(body, secret) (doc "Segurança de webhooks").
 * Aceita também SHA-256(body + secret) — a doc descreve o cálculo como "soma do body com o secret";
 * as duas exigem o secret, então não abre brecha.
 */
export async function verifyClicksignWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
  if (!secret) return false;
  const given = extractSignature(headers);
  if (!given) return false;
  const hmac = await hmacSha256Hex(secret, rawBody);
  if (timingSafeEqual(hmac, given)) return true;
  const concat = await sha256Hex(rawBody + secret);
  return timingSafeEqual(concat, given);
}

/**
 * Normaliza o payload do webhook. Aceita:
 *   (a) formato legado/documento: {event:{name, data, occurred_at}, document:{key, status, downloads, signers, ...}}
 *   (b) JSON:API v3: {data:{id?, type, attributes:{name, data, occurred_at|created}, relationships:{envelope, document, signer}}}
 */
export function parseClicksignWebhook(body: unknown): ParsedWebhook {
  const root = obj(body);
  let name = "";
  let data: Record<string, unknown> = {};
  let occurredAt: string | undefined;
  let providerEventId: string | undefined;
  let documentRef: string | undefined;
  let envelopeRef: string | undefined;
  let providerStatus: string | undefined;
  let signedFileUrl: string | undefined;
  let signer: Record<string, unknown> = {};

  const legacyEvent = obj(root.event);
  const jsonapi = obj(root.data);
  const attrs = obj(jsonapi.attributes);

  if (Object.keys(legacyEvent).length) {
    name = str(legacyEvent.name) ?? "";
    data = obj(legacyEvent.data);
    occurredAt = str(legacyEvent.occurred_at) ?? str(legacyEvent.created_at);
    providerEventId = str(legacyEvent.id) ?? str(legacyEvent.key);
  } else if (Object.keys(attrs).length || str(jsonapi.type)) {
    name = str(attrs.name) ?? str(attrs.event) ?? str(attrs.event_name) ?? "";
    data = obj(attrs.data);
    occurredAt = str(attrs.occurred_at) ?? str(attrs.created) ?? str(attrs.created_at);
    providerEventId = str(jsonapi.id);
    const rel = obj(jsonapi.relationships);
    envelopeRef = str(obj(obj(rel.envelope).data).id);
    documentRef = str(obj(obj(rel.document).data).id);
    const relSigner = obj(obj(rel.signer).data);
    if (str(relSigner.id)) signer = { key: relSigner.id };
  } else {
    name = str(root.name) ?? str(root.event_name) ?? "";
    data = obj(root.data);
    occurredAt = str(root.occurred_at);
  }

  // documento (legado ou embutido)
  const document = obj(root.document ?? data.document ?? attrs.document);
  const docs = Array.isArray(root.document) ? (root.document as unknown[]).map(obj) : [];
  const doc0 = Object.keys(document).length ? document : (docs[0] ?? {});
  documentRef = documentRef ?? str(doc0.key) ?? str(doc0.id);
  providerStatus = str(doc0.status) ?? str(obj(root.envelope).status);
  const downloads = obj(doc0.downloads);
  signedFileUrl = str(downloads.signed_file_url) ?? str(obj(obj(doc0.links).files).signed);
  envelopeRef = envelopeRef ?? str(obj(root.envelope).id) ?? str(obj(root.envelope).key) ?? str(doc0.envelope_id) ?? str(obj(doc0.envelope).id) ?? str(obj(doc0.envelope).key);
  if (!occurredAt) occurredAt = str(obj(data.refusal).refused_at) ?? str(data.reached_at) ?? str(doc0.finished_at) ?? str(doc0.updated_at);

  // signatário afetado
  if (!Object.keys(signer).length) signer = obj(data.signer);
  const signerKey = str(signer.key) ?? str(signer.id);
  const signerEmail = str(signer.email)?.toLowerCase();
  const signerPhone = str(signer.phone_number) ?? str(signer.phone);
  const signerRef = signerKey ?? signerEmail ?? signerPhone;

  // motivo (recusa / cancelamento)
  const refusal = obj(data.refusal);
  const reasons = Array.isArray(refusal.reasons) ? (refusal.reasons as unknown[]).map(String).filter(Boolean) : [];
  const comment = str(refusal.comment) ?? str(refusal.reason);
  const reason = name === "refusal"
    ? [reasons.join(", "), comment].filter(Boolean).join(" — ") || "Recusado pelo signatário"
    : name === "cancel"
    ? (str(obj(data.user).name) ? `Cancelado na Clicksign por ${str(obj(data.user).name)}` : "Cancelado na Clicksign")
    : name === "deadline" ? "Prazo de assinatura expirou" : undefined;

  const eventType = mapClicksignEvent(name);
  if (!providerEventId && name && documentRef && occurredAt) {
    providerEventId = `wh:${name}:${documentRef}:${signerKey ?? signerEmail ?? "-"}:${occurredAt}`;
  }

  const payload: Record<string, unknown> = {
    source: "webhook",
    raw_event_name: name,
    provider_status: providerStatus,
    document_key: documentRef,
    envelope_id: envelopeRef,
    occurred_at: occurredAt,
    signer: signerKey || signerEmail || signerPhone
      ? { key: signerKey, email: signerEmail, phone: signerPhone, name: str(signer.name) }
      : undefined,
    reason,
    signed_file_available: Boolean(signedFileUrl),
    deadline_at: str(doc0.deadline_at),
    finished_at: str(doc0.finished_at),
  };
  if (eventType === "refused" || eventType === "canceled") payload.message = reason;
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  return {
    providerEventId, eventType, rawEventName: name, signerRef, signerEmail, signerPhone, signerKey,
    occurredAt, documentRef, envelopeRef, providerStatus, signedFileUrl, reason, payload,
  };
}

/** Uint8Array → base64 (em blocos, sem estourar a pilha). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function summarizeBody(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Mensagem legível a partir de um erro JSON:API ({errors:[{title, detail, source}]}). */
export function describeJsonApiError(status: number, text: string): string {
  try {
    const j = obj(JSON.parse(text));
    const errors = Array.isArray(j.errors) ? (j.errors as unknown[]).map(obj) : [];
    const parts = errors.map((e) => {
      const src = str(obj(e.source).pointer)?.replace(/^\/data\/attributes\//, "");
      const d = str(e.detail) ?? str(e.title) ?? str(e.code);
      return [src, d].filter(Boolean).join(": ");
    }).filter(Boolean);
    if (parts.length) return `Clicksign ${status}: ${parts.join("; ").slice(0, 400)}`;
    const msg = str(j.message) ?? str(j.error);
    if (msg) return `Clicksign ${status}: ${msg.slice(0, 300)}`;
  } catch { /* corpo não é JSON */ }
  if (status === 401) return "Clicksign 401: token inválido ou de outro ambiente (sandbox × produção)";
  if (status === 403) return "Clicksign 403: token sem permissão para esta operação";
  if (status === 404) return "Clicksign 404: recurso não encontrado (envelope/documento)";
  if (status === 503) return "Clicksign 503: recurso indisponível nesta conta (fale com o suporte da Clicksign)";
  return `Clicksign ${status}: ${summarizeBody(text, 200) || "sem detalhes"}`;
}

// ─── implementação ───────────────────────────────────────────────────────────

export class ClicksignProvider implements SignatureProvider {
  readonly name = "clicksign";
  readonly baseUrl: string;

  constructor(private readonly token: string, readonly env: "sandbox" | "production" = "sandbox") {
    if (!token) throw new SignatureProviderError("Token da Clicksign vazio", 0, "", "config");
    this.baseUrl = CLICKSIGN_BASE_URL[env];
  }

  private async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: this.token, "Content-Type": JSONAPI, Accept: JSONAPI },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError" ? `timeout após ${REQUEST_TIMEOUT_MS}ms` : (err instanceof Error ? err.message : String(err));
      console.error(LOG, method, path.split("?")[0], "falhou:", msg);
      throw new SignatureProviderError(`Clicksign indisponível (${method} ${path.split("?")[0]}): ${msg}`, 0, "", "network");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    console.log(LOG, method, path.split("?")[0], res.status, `${text.length}b`, `${Date.now() - t0}ms`);
    if (!res.ok) throw new SignatureProviderError(describeJsonApiError(res.status, text), res.status, summarizeBody(text), "http");
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SignatureProviderError(`Clicksign respondeu algo que não é JSON (${res.status})`, res.status, summarizeBody(text), "parse");
    }
  }

  // ── envio ──
  async createEnvelope(input: CreateEnvelopeInput): Promise<CreateEnvelopeResult> {
    const warnings: string[] = [];
    const message = str(input.message ?? undefined) ?? null;

    // 1) envelope
    const env = await this.request("POST", "/api/v3/envelopes", {
      data: {
        type: "envelopes",
        attributes: {
          name: input.name.slice(0, 255),
          locale: "pt-BR",
          auto_close: true,
          remind_interval: 3,
          block_after_refusal: true,
          deadline_at: input.deadlineAt,
          deadline_partial_signature_action: "canceled",
          default_message: message ?? undefined,
        },
      },
    });
    const envelopeId = str(obj(env.data).id);
    if (!envelopeId) throw new SignatureProviderError("Clicksign não devolveu o id do envelope", 0, "", "parse");
    console.log(LOG, "envelope criado", envelopeId, "pdf", input.pdfBytes.byteLength, "bytes", "signers", input.signers.length);

    // Daqui pra frente, se der erro, descartamos o envelope (rascunho → DELETE; ativo → cancel)
    // antes de propagar, pra não deixar envelope órfão na conta.
    try {
      return await this.fillAndActivate(envelopeId, input, message, warnings);
    } catch (err) {
      try {
        await this.cancel(envelopeId, "envio abortado");
      } catch (cancelErr) {
        console.warn(LOG, "não conseguiu descartar o envelope", envelopeId, cancelErr instanceof Error ? cancelErr.message : String(cancelErr));
      }
      throw err;
    }
  }

  private async fillAndActivate(envelopeId: string, input: CreateEnvelopeInput, message: string | null, warnings: string[]): Promise<CreateEnvelopeResult> {
    // 2) documento
    const doc = await this.request("POST", `/api/v3/envelopes/${envelopeId}/documents`, {
      data: {
        type: "documents",
        attributes: {
          filename: input.filename,
          content_base64: `data:application/pdf;base64,${bytesToBase64(input.pdfBytes)}`,
        },
      },
    });
    const documentId = str(obj(doc.data).id);
    if (!documentId) throw new SignatureProviderError("Clicksign não devolveu o id do documento", 0, "", "parse");

    // 3) signatários + 4) requisitos
    const signers: { ref: string; providerSignerId: string }[] = [];
    for (const s of input.signers) {
      const phone = normalizePhoneBR(s.phone);
      const cpf = formatCpf(s.cpf);
      const email = str(s.email ?? undefined)?.toLowerCase();
      const attributes: Record<string, unknown> = {
        name: s.name.trim(),
        email: email ?? undefined,
        phone_number: phone ?? undefined,
        has_documentation: Boolean(cpf),
        documentation: cpf ?? undefined,
        refusable: true,
        group: 1,
        communicate_events: {
          signature_request: s.channel,
          signature_reminder: s.channel === "email" && email ? "email" : "none",
          document_signed: email ? "email" : "whatsapp",
        },
      };
      const created = await this.request("POST", `/api/v3/envelopes/${envelopeId}/signers`, { data: { type: "signers", attributes } });
      const providerSignerId = str(obj(created.data).id);
      if (!providerSignerId) throw new SignatureProviderError("Clicksign não devolveu o id do signatário", 0, "", "parse");
      signers.push({ ref: s.ref, providerSignerId });

      const relationships = {
        document: { data: { type: "documents", id: documentId } },
        signer: { data: { type: "signers", id: providerSignerId } },
      };
      await this.request("POST", `/api/v3/envelopes/${envelopeId}/requirements`, {
        data: { type: "requirements", attributes: { action: "agree", role: "sign" }, relationships },
      });
      await this.request("POST", `/api/v3/envelopes/${envelopeId}/requirements`, {
        data: { type: "requirements", attributes: { action: "provide_evidence", auth: s.auth }, relationships },
      });
    }

    // 5) ativar
    await this.request("PATCH", `/api/v3/envelopes/${envelopeId}`, {
      data: { id: envelopeId, type: "envelopes", attributes: { status: "running" } },
    });

    // 6) notificar (convites). Falha aqui não derruba o envio: o envelope já está ativo
    //    e o usuário pode "Reenviar convites".
    try {
      const n = await this.notify(envelopeId, message);
      console.log(LOG, "envelope", envelopeId, "ativo; notificados", n.notified);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(LOG, "notificação inicial falhou (envelope segue ativo):", msg);
      warnings.push(`Envelope ativo, mas o envio dos convites falhou: ${msg}. Use "Reenviar convites".`);
    }

    return { envelopeId, documentId, signers, warnings };
  }

  // ── status ──
  async getStatus(envelopeId: string, documentId?: string | null): Promise<EnvelopeStatusResult> {
    const env = await this.request("GET", `/api/v3/envelopes/${envelopeId}`);
    const envData = obj(env.data);
    const envAttrs = obj(envData.attributes);
    const status = mapEnvelopeStatus(envAttrs.status);

    // documentos (pra achar o id e o link do assinado)
    let docId = str(documentId ?? undefined);
    let docStatus: string | undefined;
    let signedFileUrl: string | undefined;
    let docsRaw: unknown = null;
    try {
      const docs = await this.request("GET", `/api/v3/envelopes/${envelopeId}/documents`);
      docsRaw = docs.data;
      const list = Array.isArray(docs.data) ? (docs.data as unknown[]).map(obj) : [];
      const chosen = list.find((d) => str(d.id) === docId) ?? list[0];
      if (chosen) {
        docId = docId ?? str(chosen.id);
        docStatus = str(obj(chosen.attributes).status);
        signedFileUrl = this.pickSignedUrl(chosen);
      }
    } catch (err) {
      console.warn(LOG, "listar documentos falhou:", err instanceof Error ? err.message : String(err));
    }
    if (status === "closed" && !signedFileUrl && docId) {
      try {
        const d = await this.request("GET", `/api/v3/envelopes/${envelopeId}/documents/${docId}`);
        signedFileUrl = this.pickSignedUrl(obj(d.data));
        docStatus = docStatus ?? str(obj(obj(d.data).attributes).status);
      } catch (err) {
        console.warn(LOG, "detalhe do documento falhou:", err instanceof Error ? err.message : String(err));
      }
    }

    // signatários
    const signers: EnvelopeSignerStatus[] = [];
    let signersRaw: unknown = null;
    try {
      const sg = await this.request("GET", `/api/v3/envelopes/${envelopeId}/signers`);
      signersRaw = sg.data;
      for (const s of (Array.isArray(sg.data) ? (sg.data as unknown[]).map(obj) : [])) {
        const a = obj(s.attributes);
        const id = str(s.id);
        if (!id) continue;
        signers.push({
          providerSignerId: id,
          name: str(a.name) ?? null,
          email: str(a.email)?.toLowerCase() ?? null,
          phone: str(a.phone_number) ?? null,
          status: this.signerStatusFromAttrs(a),
          signedAt: str(a.signed_at) ?? str(obj(a.signature).signed_at) ?? null,
        });
      }
    } catch (err) {
      console.warn(LOG, "listar signatários falhou:", err instanceof Error ? err.message : String(err));
    }

    // eventos do documento → quem assinou / recusou (a lista de signers não traz status)
    let eventsRaw: unknown = null;
    if (docId && signers.some((s) => s.status === "unknown")) {
      try {
        const ev = await this.request("GET", `/api/v3/envelopes/${envelopeId}/documents/${docId}/events?page[size]=100`);
        eventsRaw = ev.data;
        for (const e of (Array.isArray(ev.data) ? (ev.data as unknown[]).map(obj) : [])) {
          const a = obj(e.attributes);
          const nm = String(a.name ?? "").toLowerCase();
          if (nm !== "sign" && nm !== "refusal" && nm !== "signature_started") continue;
          const d = obj(a.data);
          const sg = obj(d.signer);
          const key = str(sg.key) ?? str(sg.id) ?? str(obj(obj(obj(e.relationships).signer).data).id);
          const email = str(sg.email)?.toLowerCase();
          const phone = str(sg.phone_number);
          const when = str(a.created) ?? str(a.occurred_at) ?? str(a.created_at) ?? null;
          const target = signers.find((s) => (key && s.providerSignerId === key) || (email && s.email === email) || (phone && s.phone && digits(s.phone) === digits(phone)));
          if (!target) continue;
          if (nm === "sign") { target.status = "signed"; target.signedAt = target.signedAt ?? when; }
          else if (nm === "refusal") { target.status = "refused"; target.refusedAt = when; target.refusalReason = str(obj(d.refusal).comment) ?? null; }
          else if (target.status === "unknown" || target.status === "pending") target.status = "viewed";
        }
      } catch (err) {
        console.warn(LOG, "eventos do documento indisponíveis:", err instanceof Error ? err.message : String(err));
      }
    }

    return {
      status,
      updatedAt: str(envAttrs.modified) ?? str(envAttrs.updated_at) ?? null,
      deadlineAt: str(envAttrs.deadline_at) ?? null,
      documentId: docId ?? null,
      documentStatus: docStatus ?? null,
      signers,
      signedFileUrl: signedFileUrl ?? null,
      raw: { envelope: envData, documents: docsRaw, signers: signersRaw, events: eventsRaw },
    };
  }

  private signerStatusFromAttrs(a: Record<string, unknown>): EnvelopeSignerStatus["status"] {
    const s = String(a.status ?? obj(a.signature).status ?? "").toLowerCase();
    if (s === "signed" || a.signed_at || obj(a.signature).signed_at) return "signed";
    if (s === "refused" || s === "declined" || s === "rejected") return "refused";
    if (s === "viewed" || s === "opened") return "viewed";
    if (s === "pending" || s === "waiting" || s === "sent") return "pending";
    return "unknown";
  }

  /** URL do PDF assinado: links.files.signed | attributes.downloads.signed_file_url | attributes.signed_file_url */
  private pickSignedUrl(d: Record<string, unknown>): string | undefined {
    const files = obj(obj(d.links).files);
    const attrs = obj(d.attributes);
    const url = str(files.signed) ?? str(files.signed_file) ?? str(obj(attrs.downloads).signed_file_url) ?? str(attrs.signed_file_url) ?? str(obj(d.downloads).signed_file_url);
    if (!url) return undefined;
    return url.startsWith("/") ? `${this.baseUrl}${url}` : url;
  }

  // ── cancelar ──
  async cancel(envelopeId: string, reason?: string | null): Promise<void> {
    let status: EnvelopeStatus = "running";
    try {
      const env = await this.request("GET", `/api/v3/envelopes/${envelopeId}`);
      status = mapEnvelopeStatus(obj(obj(env.data).attributes).status);
    } catch (err) {
      if (err instanceof SignatureProviderError && err.status === 404) return; // já não existe
      throw err;
    }
    if (status === "canceled" || status === "closed") return; // "já cancelado" não é erro
    if (status === "draft") {
      // rascunho (envio abortado no meio): a API v3 exclui em vez de cancelar
      await this.request("DELETE", `/api/v3/envelopes/${envelopeId}`);
      console.log(LOG, "envelope rascunho excluído", envelopeId);
      return;
    }
    try {
      await this.request("PATCH", `/api/v3/envelopes/${envelopeId}`, {
        data: { id: envelopeId, type: "envelopes", attributes: { status: "canceled" } },
      });
    } catch (err) {
      if (err instanceof SignatureProviderError && /cancel/i.test(err.body)) return;
      throw err;
    }
    console.log(LOG, "envelope cancelado", envelopeId, reason ? `(${reason.slice(0, 80)})` : "");
  }

  // ── reenviar convites ──
  async notify(envelopeId: string, message?: string | null): Promise<{ notified: number }> {
    const res = await this.request("POST", `/api/v3/envelopes/${envelopeId}/notifications`, {
      data: { type: "notifications", attributes: { message: str(message ?? undefined) ?? undefined } },
    });
    const summary = obj(obj(res.data).attributes).summary;
    const notified = Array.isArray(summary) ? summary.filter((x) => obj(x).notified === true).length : 0;
    return { notified };
  }

  // ── webhook ──
  async registerWebhook(endpoint: string): Promise<WebhookRegistration> {
    const res = await this.request("POST", "/api/v3/webhooks", {
      data: { type: "webhooks", attributes: { endpoint, events: CLICKSIGN_WEBHOOK_EVENTS, status: "active" } },
    });
    const data = obj(res.data);
    const attrs = obj(data.attributes);
    const webhookId = str(data.id);
    const secret = str(attrs.secret);
    if (!webhookId || !secret) throw new SignatureProviderError("Clicksign não devolveu id/secret do webhook", 0, "", "parse");
    if (String(attrs.status ?? "") !== "active") {
      try {
        await this.request("PATCH", `/api/v3/webhooks/${webhookId}`, { data: { id: webhookId, type: "webhooks", attributes: { status: "active" } } });
      } catch (err) {
        console.warn(LOG, "ativar webhook falhou:", err instanceof Error ? err.message : String(err));
      }
    }
    console.log(LOG, "webhook registrado", webhookId, "→", endpoint);
    return { webhookId, secret, endpoint, events: Array.isArray(attrs.events) ? (attrs.events as unknown[]).map(String) : CLICKSIGN_WEBHOOK_EVENTS };
  }

  verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
    return verifyClicksignWebhook(rawBody, headers, secret);
  }

  parseWebhook(body: unknown): ParsedWebhook {
    return parseClicksignWebhook(body);
  }

  // ── download do assinado ──
  async downloadFile(url: string): Promise<Uint8Array> {
    const full = url.startsWith("/") ? `${this.baseUrl}${url}` : url;
    const sameHost = full.startsWith(this.baseUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(full, {
        headers: sameHost ? { Authorization: this.token, Accept: "application/pdf,*/*" } : { Accept: "application/pdf,*/*" },
        signal: ctrl.signal,
        redirect: "follow",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SignatureProviderError(`Download do PDF assinado falhou (${res.status})`, res.status, summarizeBody(text, 120), "download");
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < 100 || !(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
        throw new SignatureProviderError(`Arquivo baixado não parece um PDF (${bytes.byteLength} bytes)`, res.status, "", "download");
      }
      console.log(LOG, "PDF assinado baixado:", bytes.byteLength, "bytes");
      return bytes;
    } catch (err) {
      if (err instanceof SignatureProviderError) throw err;
      const msg = err instanceof Error && err.name === "AbortError" ? `timeout após ${DOWNLOAD_TIMEOUT_MS}ms` : (err instanceof Error ? err.message : String(err));
      throw new SignatureProviderError(`Download do PDF assinado falhou: ${msg}`, 0, "", "download");
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<{ ok: boolean; env: string; detail?: string }> {
    try {
      const res = await this.request("GET", "/api/v3/envelopes?page[size]=1");
      const count = obj(res.meta).record_count;
      return { ok: true, env: this.env, detail: typeof count === "number" ? `${count} envelope(s) na conta` : "conectado" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, env: this.env, detail: msg };
    }
  }
}

function digits(s: string | null | undefined): string {
  return String(s ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
}
