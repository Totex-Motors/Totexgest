import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type {
  CommissionStatus,
  Intermediation,
  IntermediationEvent,
  IntermediationFunnel,
  IntermediationFunnelPeriod,
  IntermediationStatusAction,
  IntermediationTermsInput,
  LegalEntity,
} from "@/types/intermediation";

/**
 * INTERMEDIAÇÃO (migration 20260911200000) — lado do time comercial/admin.
 *
 * Leitura direta das tabelas (RLS do tenant; promotora só vê as dela).
 * Escrita SÓ via RPCs: set_terms, import_signed_contract, set_status,
 * set_commission. Prêmio da promotora, funil e estado do carro são
 * consequência no servidor — nada aqui cria saldo nem move estágio na mão.
 */

export const CONTRACTS_BUCKET = "intermediation-contracts";

export const intermediationKeys = {
  all: ["intermediation"] as const,
  byLead: (leadId: string) => ["intermediation", "by-lead", leadId] as const,
  events: (id: string) => ["intermediation", "events", id] as const,
  funnel: (period: IntermediationFunnelPeriod) => ["intermediation", "funnel", period] as const,
  legalEntities: ["intermediation", "legal-entities"] as const,
};

/** Depois de qualquer mutação: intermediação + card de captação + lead. */
function useInvalidateIntermediation() {
  const qc = useQueryClient();
  return (leadId?: string | null) => {
    qc.invalidateQueries({ queryKey: intermediationKeys.all });
    qc.invalidateQueries({ queryKey: ["capture"] });
    if (leadId) {
      qc.invalidateQueries({ queryKey: ["sales-lead", leadId] });
      qc.invalidateQueries({ queryKey: ["lead", leadId] });
    }
    qc.invalidateQueries({ queryKey: ["sales-leads"] });
    qc.invalidateQueries({ queryKey: ["sales-deals"] });
    qc.invalidateQueries({ queryKey: ["pipeline-deals"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
  };
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export function useIntermediationByLead(leadId: string | null | undefined) {
  return useQuery({
    queryKey: intermediationKeys.byLead(leadId ?? ""),
    enabled: !!leadId,
    queryFn: async () => {
      const { data, error } = await supabase.from("intermediations").select("*").eq("owner_lead_id", leadId!).maybeSingle();
      if (error) throw error;
      return (data as Intermediation | null) ?? null;
    },
    staleTime: 15_000,
  });
}

export function useIntermediationEvents(intermediationId: string | null | undefined) {
  return useQuery({
    queryKey: intermediationKeys.events(intermediationId ?? ""),
    enabled: !!intermediationId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("intermediation_events")
        .select("*")
        .eq("intermediation_id", intermediationId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as IntermediationEvent[];
    },
    staleTime: 15_000,
  });
}

export function useIntermediationFunnel(period: IntermediationFunnelPeriod) {
  return useQuery({
    queryKey: intermediationKeys.funnel(period),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("intermediation_funnel", { p_period: period });
      if (error) throw error;
      const r = (data ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => Number(v) || 0;
      const numOrNull = (v: unknown) => (v == null ? null : Number(v));
      return {
        period_start: String(r.period_start ?? ""),
        captadas: num(r.captadas),
        validas: num(r.validas),
        formalizadas: num(r.formalizadas),
        em_vitrine: num(r.em_vitrine),
        com_proposta: num(r.com_proposta),
        vendidas: num(r.vendidas),
        encerradas: num(r.encerradas),
        ativas: num(r.ativas),
        vencendo: num(r.vencendo),
        comissao_apurada: num(r.comissao_apurada),
        comissao_paga: num(r.comissao_paga),
        dias_para_formalizar: numOrNull(r.dias_para_formalizar),
        dias_para_vender: numOrNull(r.dias_para_vender),
      } satisfies IntermediationFunnel;
    },
    staleTime: 30_000,
  });
}

export function useLegalEntities() {
  return useQuery({
    queryKey: intermediationKeys.legalEntities,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("legal_entities")
        .select("*")
        .order("is_default", { ascending: false })
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as LegalEntity[];
    },
    staleTime: 5 * 60_000,
  });
}

// ─── Mutações (RPCs) ────────────────────────────────────────────────────────

export interface SetTermsResult {
  ok: boolean;
  complete: boolean;
  status: Intermediation["status"];
}

export function useSetIntermediationTerms() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, terms }: { id: string; leadId?: string | null; terms: IntermediationTermsInput }) => {
      const { data, error } = await supabase.rpc("intermediation_set_terms", { p_id: id, p_terms: terms });
      if (error) throw error;
      return (data ?? { ok: false, complete: false, status: "lead" }) as SetTermsResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export interface ImportContractResult {
  ok: boolean;
  code: string;
  status?: Intermediation["status"];
  already?: boolean;
}

/** SHA-256 hex (64 chars) do arquivo — o servidor exige pra registrar o contrato. */
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/**
 * Admin: importa o PDF assinado (fallback PRD 13.2.13). Valida PDF (≤ 25 MB),
 * calcula o hash, sobe pro bucket privado em `${tenantId}/${id}/…` (a policy
 * exige a 1ª pasta = tenant_id) e chama a RPC. Se a RPC falhar, remove o arquivo.
 */
export function useImportSignedContract() {
  const { tenantId } = useAuth();
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, file, signedAt, reason }: {
      id: string;
      leadId?: string | null;
      file: File;
      /** Data da assinatura ('YYYY-MM-DD' ou ISO) */
      signedAt: string;
      reason: string;
    }) => {
      if (!tenantId) throw new Error("Não consegui identificar sua empresa (tenant). Recarregue a página e tente de novo.");
      if (!isPdf(file)) throw new Error("O contrato precisa ser um arquivo PDF.");
      if (file.size > 25 * 1024 * 1024) throw new Error("PDF muito grande — o limite é 25 MB.");
      if (reason.trim().length < 3) throw new Error("Informe o motivo/origem da importação (ex.: assinado em papel na loja).");

      const sha256 = await sha256Hex(file);
      const path = `${tenantId}/${id}/${Date.now()}-contrato.pdf`;

      const up = await supabase.storage.from(CONTRACTS_BUCKET).upload(path, file, { contentType: "application/pdf", upsert: false });
      if (up.error) throw new Error(`Não consegui enviar o PDF: ${up.error.message}`);

      const signedIso = /^\d{4}-\d{2}-\d{2}$/.test(signedAt) ? new Date(`${signedAt}T12:00:00`).toISOString() : new Date(signedAt).toISOString();
      const { data, error } = await supabase.rpc("intermediation_import_signed_contract", {
        p_id: id,
        p_file_path: path,
        p_sha256: sha256,
        p_signed_at: signedIso,
        p_reason: reason.trim(),
      });
      if (error) {
        // Não deixa PDF órfão no bucket
        await supabase.storage.from(CONTRACTS_BUCKET).remove([path]).catch(() => undefined);
        throw error;
      }
      return (data ?? { ok: false, code: "" }) as ImportContractResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export interface SetStatusResult {
  ok: boolean;
  status: Intermediation["status"];
  unpublish_task?: string | null;
}

export function useSetIntermediationStatus() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; leadId?: string | null; status: IntermediationStatusAction; reason?: string | null }) => {
      const { data, error } = await supabase.rpc("intermediation_set_status", { p_id: id, p_status: status, p_reason: reason ?? null });
      if (error) throw error;
      return (data ?? { ok: false, status: "lead" }) as SetStatusResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export function useSetIntermediationCommission() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, status, amount }: { id: string; leadId?: string | null; status: CommissionStatus; amount?: number | null }) => {
      const { error } = await supabase.rpc("intermediation_set_commission", { p_id: id, p_status: status, p_amount: amount ?? null });
      if (error) throw error;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** URL temporária (5 min) do PDF do contrato no bucket privado. */
export async function getContractSignedUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(CONTRACTS_BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "Não consegui gerar o link do PDF.");
  return data.signedUrl;
}
