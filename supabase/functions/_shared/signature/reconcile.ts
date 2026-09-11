// INTERMEDIAÇÃO — Fase 3: reconciliação de um documento com o provedor.
//
// Usada por: contract-send (action "status"), clicksign-webhook (após "completed")
// e contract-reconcile (cron). É a ÚNICA rotina que formaliza: só depois de baixar o
// PDF assinado, calcular o SHA-256 e gravar no bucket é que chama contract_document_finalize().
//
// Eventos sintéticos (idempotentes por provider_event_id "reconcile:<envelope>:<...>"):
//   • por signatário assinado  → signed   (signer_ref = provider_signer_id)
//   • por signatário recusado  → refused
//   • envelope closed          → completed
//   • envelope canceled        → canceled
//   • running após o prazo     → expired  (com folga, pra Clicksign fechar/cancelar sozinha)

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { sha256Hex } from "./clicksign.ts";
import type { EnvelopeStatusResult, SignatureProvider } from "./provider.ts";

const LOG = "[contract-reconcile]";
export const CONTRACT_BUCKET = "intermediation-contracts";
/** Quanto tempo depois do prazo a gente marca "expired" por conta própria. */
const DEADLINE_GRACE_MS = 60 * 60 * 1000;

export interface ContractDocumentRow {
  id: string;
  tenant_id: string;
  intermediation_id: string;
  document_type: string;
  version: number;
  status: string;
  provider: string | null;
  provider_envelope_id: string | null;
  provider_document_id: string | null;
  provider_status: string | null;
  deadline_at: string | null;
  signed_file_path: string | null;
  [key: string]: unknown;
}

export interface ApplyEventResult {
  applied: boolean;
  duplicate: boolean;
  document_status: string;
  all_signed?: boolean;
  intermediation_id: string;
}

export interface ReconcileResult {
  document: ContractDocumentRow | null;
  applied: number;
  finalized: boolean;
  providerStatus: string;
  skipped?: string;
  error?: string;
}

export interface ProviderEventInput {
  provider: string;
  provider_event_id?: string;
  event_type: string;
  raw_event_name?: string;
  signer_ref?: string;
  occurred_at?: string;
  payload: Record<string, unknown>;
}

/** Aplica um evento via RPC service_role. Lança se a RPC falhar. */
export async function applyProviderEvent(sb: SupabaseClient, documentId: string, event: ProviderEventInput): Promise<ApplyEventResult> {
  const { data, error } = await sb.rpc("contract_apply_provider_event", { p_document_id: documentId, p_event: event });
  if (error) throw new Error(`contract_apply_provider_event: ${error.message}`);
  return (data ?? { applied: false, duplicate: false, document_status: "", intermediation_id: "" }) as ApplyEventResult;
}

/**
 * Resolve a referência do signatário pra algo que contract_apply_provider_event case:
 * prefere provider_signer_id; senão e-mail; senão telefone (com/sem DDI 55).
 */
export async function resolveSignerRef(
  sb: SupabaseClient, documentId: string, cand: { key?: string | null; email?: string | null; phone?: string | null },
): Promise<string | undefined> {
  const { data, error } = await sb.from("contract_signers").select("id, provider_signer_id, email, phone").eq("document_id", documentId);
  if (error || !data) return cand.key ?? cand.email ?? cand.phone ?? undefined;
  const rows = data as { id: string; provider_signer_id: string | null; email: string | null; phone: string | null }[];
  const dig = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  const byKey = cand.key ? rows.find((r) => r.provider_signer_id === cand.key) : undefined;
  const byEmail = cand.email ? rows.find((r) => (r.email ?? "").toLowerCase() === cand.email!.toLowerCase()) : undefined;
  const byPhone = cand.phone && dig(cand.phone) ? rows.find((r) => dig(r.phone) === dig(cand.phone)) : undefined;
  const hit = byKey ?? byEmail ?? byPhone;
  if (!hit) return cand.key ?? cand.email ?? cand.phone ?? undefined;
  return hit.provider_signer_id ?? hit.email ?? hit.phone ?? undefined;
}

async function loadDocument(sb: SupabaseClient, id: string): Promise<ContractDocumentRow | null> {
  const { data, error } = await sb.from("contract_documents").select("*").eq("id", id).maybeSingle();
  if (error) console.warn(LOG, "recarregar documento:", error.message);
  return (data as ContractDocumentRow | null) ?? null;
}

async function touchReconciled(sb: SupabaseClient, id: string, providerStatus?: string | null): Promise<void> {
  const patch: Record<string, unknown> = { last_reconciled_at: new Date().toISOString() };
  if (providerStatus) patch.provider_status = providerStatus;
  const { error } = await sb.from("contract_documents").update(patch).eq("id", id);
  if (error) console.warn(LOG, "last_reconciled_at:", error.message);
}

/**
 * Baixa o PDF assinado, confere, grava no bucket e formaliza. Idempotente:
 * documento já validated → não baixa de novo.
 */
export async function finalizeSignedDocument(
  sb: SupabaseClient, provider: SignatureProvider, doc: ContractDocumentRow, st: EnvelopeStatusResult,
): Promise<{ finalized: boolean; path?: string; sha256?: string }> {
  if (doc.status === "validated") return { finalized: false };
  let url = st.signedFileUrl ?? null;
  if (!url && doc.provider_envelope_id) {
    // tenta de novo (o link do assinado pode demorar alguns segundos pra aparecer)
    const again = await provider.getStatus(doc.provider_envelope_id, doc.provider_document_id);
    url = again.signedFileUrl ?? null;
  }
  if (!url) throw new Error("Envelope fechado, mas o PDF assinado ainda não está disponível na Clicksign (tente de novo em instantes)");

  const bytes = await provider.downloadFile(url);
  const sha256 = await sha256Hex(bytes);
  const path = `${doc.tenant_id}/${doc.intermediation_id}/contrato-v${doc.version}-assinado-${Date.now()}.pdf`;
  const { error: upErr } = await sb.storage.from(CONTRACT_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`Erro ao salvar o PDF assinado no storage: ${upErr.message}`);

  const providerStatus = {
    envelope_status: st.status,
    envelope_updated_at: st.updatedAt ?? null,
    document_status: st.documentStatus ?? null,
    signed_bytes: bytes.byteLength,
    signers: st.signers.map((s) => ({ id: s.providerSignerId, status: s.status, signed_at: s.signedAt ?? null })),
    finalized_at: new Date().toISOString(),
  };
  const { error: finErr } = await sb.rpc("contract_document_finalize", {
    p_document_id: doc.id, p_signed_path: path, p_sha256: sha256, p_provider_status: providerStatus,
  });
  if (finErr) {
    const { error: rmErr } = await sb.storage.from(CONTRACT_BUCKET).remove([path]);
    if (rmErr) console.warn(LOG, "não removeu o PDF órfão:", rmErr.message);
    throw new Error(`contract_document_finalize: ${finErr.message}`);
  }
  console.log(LOG, `documento ${doc.id} v${doc.version} FINALIZADO — ${bytes.byteLength} bytes, sha ${sha256.slice(0, 12)}`);
  return { finalized: true, path, sha256 };
}

/**
 * Reconcilia um documento: consulta o provedor, aplica eventos sintéticos e,
 * se fechado com todas as assinaturas, baixa/valida/formaliza.
 * Nunca lança por "sem mudança"; lança só em erro real (quem chama decide).
 */
export async function reconcileDocument(sb: SupabaseClient, provider: SignatureProvider, doc: ContractDocumentRow): Promise<ReconcileResult> {
  if (!doc.provider_envelope_id) return { document: doc, applied: 0, finalized: false, providerStatus: "", skipped: "sem envelope" };
  if (doc.status === "validated" || doc.status === "archived") {
    await touchReconciled(sb, doc.id);
    return { document: doc, applied: 0, finalized: false, providerStatus: doc.provider_status ?? "", skipped: `já ${doc.status}` };
  }

  const st = await provider.getStatus(doc.provider_envelope_id, doc.provider_document_id);
  const env = doc.provider_envelope_id;
  const providerName = provider.name;
  let applied = 0;
  let last: ApplyEventResult | null = null;
  const base = { source: "reconcile", provider_status: st.status, envelope_updated_at: st.updatedAt ?? undefined };

  const apply = async (e: ProviderEventInput) => {
    const r = await applyProviderEvent(sb, doc.id, e);
    if (r.applied) applied++;
    last = r;
    return r;
  };

  // por signatário
  const knownSignerInfo = st.signers.some((s) => s.status !== "unknown");
  for (const s of st.signers) {
    if (s.status === "signed") {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:signed:${s.providerSignerId}`, event_type: "signed",
        raw_event_name: "reconcile_signed", signer_ref: s.providerSignerId, occurred_at: s.signedAt ?? undefined,
        payload: { ...base, signer: { id: s.providerSignerId, email: s.email ?? undefined, signed_at: s.signedAt ?? undefined } },
      });
    } else if (s.status === "refused") {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:refused:${s.providerSignerId}`, event_type: "refused",
        raw_event_name: "reconcile_refusal", signer_ref: s.providerSignerId, occurred_at: s.refusedAt ?? undefined,
        payload: { ...base, reason: s.refusalReason ?? "Recusado pelo signatário", message: s.refusalReason ?? undefined, signer: { id: s.providerSignerId } },
      });
    } else if (s.status === "viewed") {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:viewed:${s.providerSignerId}`, event_type: "viewed",
        raw_event_name: "reconcile_viewed", signer_ref: s.providerSignerId, payload: { ...base, signer: { id: s.providerSignerId } },
      });
    }
  }

  // por envelope
  let finalized = false;
  if (st.status === "canceled") {
    await apply({
      provider: providerName, provider_event_id: `reconcile:${env}:canceled`, event_type: "canceled", raw_event_name: "reconcile_canceled",
      occurred_at: st.updatedAt ?? undefined, payload: { ...base, message: "Envelope cancelado na Clicksign" },
    });
  } else if (st.status === "closed") {
    // Todos assinaram? Se o provedor deu status por signatário, exige todos "signed";
    // se não deu (unknown em todos), confia no closed (auto_close + partial→canceled).
    const providerAllSigned = knownSignerInfo ? st.signers.every((s) => s.status === "signed") : true;
    const { data: localSigners } = await sb.from("contract_signers").select("status").eq("document_id", doc.id);
    const localAllSigned = Array.isArray(localSigners) && localSigners.length > 0 && localSigners.every((r) => (r as { status: string }).status === "signed");
    if (!providerAllSigned && !localAllSigned) {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:closed_partial:${st.updatedAt ?? "-"}`, event_type: "error", raw_event_name: "reconcile_closed_partial",
        payload: { ...base, message: "Envelope fechado na Clicksign sem todas as assinaturas — confira na Clicksign ou gere uma nova versão" },
      });
    } else {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:closed:${st.updatedAt ?? "-"}`, event_type: "completed", raw_event_name: "reconcile_closed",
        occurred_at: st.updatedAt ?? undefined, payload: { ...base, signed_file_available: Boolean(st.signedFileUrl) },
      });
      const fresh = (await loadDocument(sb, doc.id)) ?? doc;
      if (fresh.status !== "validated" && !["cancelled", "declined", "expired"].includes(fresh.status)) {
        const fin = await finalizeSignedDocument(sb, provider, fresh, st);
        finalized = fin.finalized;
      }
    }
  } else if (st.status === "running") {
    const deadline = st.deadlineAt ?? doc.deadline_at;
    const deadlineMs = deadline ? Date.parse(deadline) : NaN;
    if (Number.isFinite(deadlineMs) && Date.now() > deadlineMs + DEADLINE_GRACE_MS) {
      await apply({
        provider: providerName, provider_event_id: `reconcile:${env}:expired`, event_type: "expired", raw_event_name: "reconcile_deadline",
        occurred_at: deadline ?? undefined, payload: { ...base, deadline_at: deadline, message: "Prazo de assinatura expirou" },
      });
    }
  }

  if (!finalized) await touchReconciled(sb, doc.id, st.status);
  const document = (await loadDocument(sb, doc.id)) ?? doc;
  const lastStatus = last ? (last as ApplyEventResult).document_status : document.status;
  console.log(LOG, `doc ${doc.id} v${doc.version}: provedor=${st.status} local=${document.status} (rpc=${lastStatus}) eventos=${applied} finalizado=${finalized}`);
  return { document, applied, finalized, providerStatus: st.status };
}
