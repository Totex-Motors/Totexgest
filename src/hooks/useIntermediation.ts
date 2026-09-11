import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type {
  CommissionStatus,
  ContractDataInput,
  ContractDocument,
  ContractDocumentType,
  ContractMissing,
  ContractSnapshot,
  ContractTemplate,
  Intermediation,
  IntermediationEvent,
  IntermediationFunnel,
  IntermediationFunnelPeriod,
  IntermediationStatusAction,
  IntermediationTermsInput,
  LegalEntity,
  LegalEntityInput,
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
  contractSnapshot: (id: string, type: ContractDocumentType) => ["intermediation", "contract-snapshot", id, type] as const,
  contractDocuments: (id: string) => ["intermediation", "contract-documents", id] as const,
  contractTemplates: ["intermediation", "contract-templates"] as const,
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
    mutationFn: async ({ id, file, signedAt, reason, documentId }: {
      id: string;
      leadId?: string | null;
      file: File;
      /** Data da assinatura ('YYYY-MM-DD' ou ISO) */
      signedAt: string;
      reason: string;
      /** `intermediations.contract_document_id` — o PDF assinado desta versão gerada. */
      documentId?: string | null;
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
        p_document_id: documentId ?? null,
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

/** URL temporária (5 min por padrão) do PDF do contrato no bucket privado. */
export async function getContractSignedUrl(path: string, expiresIn = 300): Promise<string> {
  const { data, error } = await supabase.storage.from(CONTRACTS_BUCKET).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) throw new Error(error?.message ?? "Não consegui gerar o link do PDF.");
  return data.signedUrl;
}

// ═══ Fase 2 — Documentos (migration 20260912100000 + edge fn contract-render) ═══

/** Variáveis + o que falta pra gerar o contrato. `ready` = template vigente e nada faltando. */
export function useContractSnapshot(intermediationId: string | null | undefined, documentType: ContractDocumentType = "INTERMEDIATION_CONTRACT") {
  return useQuery({
    queryKey: intermediationKeys.contractSnapshot(intermediationId ?? "", documentType),
    enabled: !!intermediationId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("intermediation_contract_snapshot", { p_id: intermediationId!, p_document_type: documentType });
      if (error) throw error;
      return normalizeSnapshot(data);
    },
    staleTime: 10_000,
  });
}

function normalizeSnapshot(raw: unknown): ContractSnapshot {
  const r = (raw ?? {}) as Partial<ContractSnapshot> & Record<string, unknown>;
  return {
    variables: (r.variables ?? {}) as ContractSnapshot["variables"],
    missing: Array.isArray(r.missing) ? (r.missing as ContractMissing[]) : [],
    ready: r.ready === true,
    template: (r.template as ContractSnapshot["template"]) ?? null,
    next_version: Number(r.next_version) || 1,
    legal_entity_id: (r.legal_entity_id as string | null) ?? null,
  };
}

/** Salva CPF/RG/endereço do proprietário + placa/Renavam/chassi do carro. Devolve o snapshot novo. */
export function useSetContractData() {
  const qc = useQueryClient();
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; leadId?: string | null; data: ContractDataInput }) => {
      const { data: res, error } = await supabase.rpc("intermediation_set_contract_data", { p_id: id, p_data: data });
      if (error) throw error;
      return normalizeSnapshot(res);
    },
    onSuccess: (snap, { id, leadId }) => {
      qc.setQueryData(intermediationKeys.contractSnapshot(id, "INTERMEDIATION_CONTRACT"), snap);
      invalidate(leadId);
      qc.invalidateQueries({ queryKey: ["intermediation", "vehicle"] });
    },
  });
}

/** Versões geradas/importadas do contrato (mais nova primeiro), com signatários embutidos. */
export function useContractDocuments(intermediationId: string | null | undefined, documentType?: ContractDocumentType) {
  return useQuery({
    queryKey: [...intermediationKeys.contractDocuments(intermediationId ?? ""), documentType ?? "all"],
    enabled: !!intermediationId,
    queryFn: async () => {
      let q = supabase
        .from("contract_documents")
        .select("*, contract_signers(*)")
        .eq("intermediation_id", intermediationId!)
        .order("version", { ascending: false });
      if (documentType) q = q.eq("document_type", documentType);
      const { data, error } = await q;
      if (error) throw error;
      const docs = (data ?? []) as ContractDocument[];
      docs.forEach((d) => d.contract_signers?.sort((a, b) => a.signing_order - b.signing_order));
      return docs;
    },
    staleTime: 15_000,
  });
}

/** Erro da edge fn `contract-render` — 422 traz a lista de faltantes. */
export class ContractRenderError extends Error {
  status: number;
  missing: ContractMissing[];
  constructor(message: string, status: number, missing: ContractMissing[] = []) {
    super(message);
    this.name = "ContractRenderError";
    this.status = status;
    this.missing = missing;
  }
}

/** Traduz um erro do `functions.invoke` (FunctionsHttpError guarda a Response em `context`). */
async function toRenderError(error: unknown, fallback: string): Promise<ContractRenderError> {
  let msg = (error as { message?: string })?.message || fallback;
  let status = 0;
  let missing: ContractMissing[] = [];
  const ctx = (error as { context?: unknown })?.context;
  if (typeof Response !== "undefined" && ctx instanceof Response) {
    status = ctx.status;
    try {
      const j = await ctx.clone().json();
      if (j && typeof j.error === "string" && j.error) msg = j.error;
      if (Array.isArray(j?.missing)) missing = j.missing as ContractMissing[];
    } catch { /* corpo não é JSON — fica a mensagem padrão */ }
  }
  if (status === 422 && missing.length && msg === fallback) msg = "Ainda faltam dados pra gerar o contrato.";
  return new ContractRenderError(msg, status, missing);
}

export interface GenerateContractResult {
  ok: boolean;
  document: ContractDocument;
  signed_url: string | null;
}

/**
 * Gera (ou regenera) o PDF do contrato pela edge fn `contract-render`.
 * A versão anterior não assinada é cancelada no servidor — nunca sobrescrita.
 */
export function useGenerateContract() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; leadId?: string | null; reason?: string | null }) => {
      const { data, error } = await supabase.functions.invoke("contract-render", {
        body: { intermediation_id: id, reason: reason?.trim() || undefined },
      });
      if (error) throw await toRenderError(error, "Não consegui gerar o contrato.");
      const r = (data ?? {}) as Partial<GenerateContractResult> & { error?: string; missing?: ContractMissing[] };
      if (typeof r.error === "string" && r.error) throw new ContractRenderError(r.error, 422, r.missing ?? []);
      if (!r.document) throw new ContractRenderError("A geração não devolveu o documento.", 500);
      return { ok: r.ok !== false, document: r.document, signed_url: r.signed_url ?? null } as GenerateContractResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/**
 * Pré-visualização: a edge fn devolve o PDF binário (sem gravar nada) — abre numa aba nova.
 * Abre a aba ANTES do await pra não cair no bloqueador de pop-up; se falhar, fecha.
 */
export async function openContractPreview(intermediationId: string): Promise<void> {
  // "noopener" faria window.open devolver null — abre em branco e corta o opener na mão
  const win = window.open("about:blank", "_blank");
  if (win) win.opener = null;
  try {
    const { data, error } = await supabase.functions.invoke("contract-render", {
      body: { preview: true, intermediation_id: intermediationId },
      headers: { Accept: "application/pdf" },
    });
    if (error) throw await toRenderError(error, "Não consegui montar a pré-visualização.");
    let blob: Blob;
    if (data instanceof Blob) blob = data.type === "application/pdf" ? data : new Blob([data], { type: "application/pdf" });
    else if (data instanceof ArrayBuffer) blob = new Blob([data], { type: "application/pdf" });
    else if (typeof data === "string" && data.startsWith("%PDF")) blob = new Blob([data], { type: "application/pdf" });
    else if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      const d = data as { error: string; missing?: ContractMissing[] };
      throw new ContractRenderError(d.error, 422, d.missing ?? []);
    } else throw new ContractRenderError("A pré-visualização não veio como PDF.", 500);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

// ─── Templates (jurídico) ───────────────────────────────────────────────────

/** Templates que o tenant enxerga: globais (Totex) + os dele. */
export function useContractTemplates() {
  return useQuery({
    queryKey: intermediationKeys.contractTemplates,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contract_templates")
        .select("*")
        .order("document_type")
        .order("version", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ContractTemplate[];
    },
    staleTime: 60_000,
  });
}

export type SaveContractTemplateInput =
  | {
      action: "create_draft";
      document_type: ContractDocumentType;
      name: string;
      body: string;
      required_variables: string[];
      notes?: string | null;
      /** null = global (só superadmin). Omitido = do tenant atual. */
      tenant_id?: string | null;
      version: number;
    }
  | { action: "update_draft"; id: string; name?: string; body?: string; required_variables?: string[]; notes?: string | null }
  | { action: "publish"; id: string };

/**
 * Templates: insere rascunho, edita rascunho ou publica (o trigger aposenta a
 * versão vigente e trava o body). RLS: admin nos do tenant, superadmin em qualquer.
 */
export function useSaveContractTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveContractTemplateInput) => {
      if (input.action === "create_draft") {
        const { action: _a, ...row } = input;
        const { data, error } = await supabase
          .from("contract_templates")
          .insert({ ...row, status: "draft" })
          .select("*")
          .single();
        if (error) throw error;
        return data as ContractTemplate;
      }
      if (input.action === "update_draft") {
        const { action: _a, id, ...patch } = input;
        const { data, error } = await supabase.from("contract_templates").update(patch).eq("id", id).eq("status", "draft").select("*").single();
        if (error) throw error;
        return data as ContractTemplate;
      }
      const { data, error } = await supabase
        .from("contract_templates")
        .update({ status: "published" })
        .eq("id", input.id)
        .eq("status", "draft")
        .select("*")
        .single();
      if (error) throw error;
      return data as ContractTemplate;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: intermediationKeys.contractTemplates });
      qc.invalidateQueries({ queryKey: ["intermediation", "contract-snapshot"] });
    },
  });
}

// ─── Entidade jurídica ──────────────────────────────────────────────────────

/** Upsert de `legal_entities` (admin do tenant / superadmin). Sem `id` insere. */
export function useSaveLegalEntity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LegalEntityInput) => {
      const clean = (v: string | null | undefined) => (typeof v === "string" ? v.trim() || null : v ?? null);
      const row = {
        legal_name: input.legal_name.trim(),
        trade_name: clean(input.trade_name),
        cnpj: clean(input.cnpj),
        address: clean(input.address),
        city_name: clean(input.city_name),
        state: clean(input.state)?.toUpperCase() ?? null,
        zip: clean(input.zip),
        phone: clean(input.phone),
        email: clean(input.email)?.toLowerCase() ?? null,
        signer_name: clean(input.signer_name),
        signer_cpf: clean(input.signer_cpf),
        signer_role: input.signer_role ?? null,
        contract_city: clean(input.contract_city),
        ...(input.is_default != null ? { is_default: input.is_default } : {}),
        ...(input.is_active != null ? { is_active: input.is_active } : {}),
      };
      if (!row.legal_name) throw new Error("Informe a razão social.");
      const q = input.id
        ? supabase.from("legal_entities").update(row).eq("id", input.id).select("*").single()
        : supabase.from("legal_entities").insert({ ...row, is_default: input.is_default ?? true }).select("*").single();
      const { data, error } = await q;
      if (error) throw error;
      return data as LegalEntity;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: intermediationKeys.legalEntities });
      qc.invalidateQueries({ queryKey: ["intermediation", "contract-snapshot"] });
    },
  });
}
