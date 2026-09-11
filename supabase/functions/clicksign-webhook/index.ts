import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getSignatureProvider, getWebhookSecret, PROVIDER_NAME } from "../_shared/signature/index.ts";
import { parseClicksignWebhook, verifyClicksignWebhook } from "../_shared/signature/clicksign.ts";
import { applyProviderEvent, type ContractDocumentRow, reconcileDocument, resolveSignerRef } from "../_shared/signature/reconcile.ts";

// INTERMEDIAÇÃO — Fase 3: webhook da Clicksign (verify_jwt = false; auth por HMAC).
//
// Fluxo: raw body → parse → acha o documento pelo id do documento/envelope no provedor
// (contract_document_by_provider_ref) → secret do tenant → HMAC → contract_apply_provider_event.
// Se o evento fecha o envelope (completed / todos assinaram) → reconcileDocument() baixa e
// confere o PDF assinado e só então formaliza.
//
//   • documento desconhecido → 200 {ignored:true} (senão a Clicksign reenvia pra sempre)
//   • sem secret ou HMAC inválido → 401
//   • erro interno → 500 (a Clicksign reenvia)
// Nunca logar body, secret ou HMAC.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const LOG = "[clicksign-webhook]";

interface ProviderRef { document_id: string; tenant_id: string; intermediation_id: string; status: string; provider_envelope_id: string | null; provider_document_id: string | null }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "GET" || req.method === "HEAD") return json({ ok: true, service: "clicksign-webhook" });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error(LOG, "variáveis SUPABASE_* ausentes");
    return json({ error: "Função sem configuração do Supabase" }, 500);
  }

  const rawBody = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    console.warn(LOG, "body não é JSON válido", `${rawBody.length}b`);
    return json({ error: "JSON inválido" }, 400);
  }

  try {
    const parsed = parseClicksignWebhook(body);
    if (!parsed.documentRef && !parsed.envelopeRef) {
      console.warn(LOG, "evento sem referência de documento/envelope:", parsed.rawEventName || "(sem nome)");
      return json({ ignored: true, reason: "sem referência" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    let ref: ProviderRef | null = null;
    for (const candidate of [parsed.documentRef, parsed.envelopeRef]) {
      if (!candidate) continue;
      const { data, error } = await sb.rpc("contract_document_by_provider_ref", { p_provider: PROVIDER_NAME, p_ref: candidate });
      if (error) throw new Error(`contract_document_by_provider_ref: ${error.message}`);
      const row = Array.isArray(data) ? (data[0] as ProviderRef | undefined) : (data as ProviderRef | null);
      if (row?.document_id) { ref = row; break; }
    }
    if (!ref) {
      console.log(LOG, "documento desconhecido — ignorado:", parsed.rawEventName, parsed.documentRef ?? parsed.envelopeRef);
      return json({ ignored: true });
    }

    const secret = await getWebhookSecret(sb, ref.tenant_id);
    if (!secret) {
      console.warn(LOG, "tenant sem CLICKSIGN_WEBHOOK_SECRET:", ref.tenant_id);
      return json({ error: "Webhook não configurado para este tenant" }, 401);
    }
    if (!(await verifyClicksignWebhook(rawBody, req.headers, secret))) {
      console.warn(LOG, "assinatura HMAC inválida — doc", ref.document_id, "evento", parsed.rawEventName);
      return json({ error: "Assinatura inválida" }, 401);
    }

    const signerRef = (parsed.signerKey || parsed.signerEmail || parsed.signerPhone)
      ? await resolveSignerRef(sb, ref.document_id, { key: parsed.signerKey, email: parsed.signerEmail, phone: parsed.signerPhone })
      : undefined;

    const result = await applyProviderEvent(sb, ref.document_id, {
      provider: PROVIDER_NAME,
      provider_event_id: parsed.providerEventId,
      event_type: parsed.eventType,
      raw_event_name: parsed.rawEventName,
      signer_ref: signerRef,
      occurred_at: parsed.occurredAt,
      payload: parsed.payload,
    });
    console.log(LOG, `doc ${ref.document_id}: ${parsed.rawEventName} → ${parsed.eventType} · applied=${result.applied} dup=${result.duplicate} status=${result.document_status}`);

    let finalized = false;
    const closing = parsed.eventType === "completed" || result.all_signed === true || result.document_status === "completed";
    if (closing && result.document_status !== "validated") {
      const { data: docRow, error: docErr } = await sb.from("contract_documents").select("*").eq("id", ref.document_id).maybeSingle();
      if (docErr || !docRow) throw new Error(`carregar documento: ${docErr?.message ?? "não encontrado"}`);
      const provider = await getSignatureProvider(sb, ref.tenant_id);
      const r = await reconcileDocument(sb, provider, docRow as ContractDocumentRow);
      finalized = r.finalized;
    }

    return json({ ok: true, applied: result.applied, duplicate: result.duplicate, document_status: result.document_status, finalized });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message.slice(0, 300) }, 500);
  }
});
