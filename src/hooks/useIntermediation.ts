import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type {
  BuyerData,
  CommissionStatus,
  ContractDataInput,
  ContractDocument,
  ContractDocumentType,
  ContractEvent,
  ContractMissing,
  ContractSignerAuthMethod,
  ContractSignerChannel,
  ContractSnapshot,
  ContractStatus,
  ContractTemplate,
  DashboardContratoPendenteItem,
  DashboardPagamentoPendenteItem,
  DashboardPrazoItem,
  DashboardProntaConcluirItem,
  DashboardTermoPendenteItem,
  DeadlineStatus,
  Intermediation,
  IntermediationDashboard,
  IntermediationDashboardAtencao,
  IntermediationDashboardKpis,
  IntermediationDashboardPeriod,
  IntermediationDashboardPremios,
  IntermediationDashboardRankingRow,
  IntermediationEvent,
  IntermediationFunnel,
  IntermediationFunnelPeriod,
  IntermediationPaymentStatus,
  IntermediationStatusAction,
  IntermediationTermsInput,
  LegalEntity,
  LegalEntityInput,
  Proposal,
  ProposalInput,
  SaleContractStatus,
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
  dashboard: (period: IntermediationDashboardPeriod) => ["intermediation", "dashboard", period] as const,
  legalEntities: ["intermediation", "legal-entities"] as const,
  contractSnapshot: (id: string, type: ContractDocumentType) => ["intermediation", "contract-snapshot", id, type] as const,
  contractDocuments: (id: string) => ["intermediation", "contract-documents", id] as const,
  contractTemplates: ["intermediation", "contract-templates"] as const,
  contractEvents: (documentId: string) => ["intermediation", "contract-events", documentId] as const,
  proposals: (id: string) => ["intermediation", "proposals", id] as const,
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

// ─── Painel de gestão (RPC `intermediation_dashboard`) ───────────────────────

const num = (v: unknown) => Number(v) || 0;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const str = (v: unknown) => (v == null ? "" : String(v));
const strOrNull = (v: unknown) => (v == null ? null : String(v));

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function normalizeDashboard(raw: unknown): IntermediationDashboard {
  const r = (raw ?? {}) as Record<string, unknown>;
  const k = (r.kpis ?? {}) as Record<string, unknown>;
  const a = (r.atencao ?? {}) as Record<string, unknown>;
  const p = (r.premios ?? {}) as Record<string, unknown>;

  const kpis: IntermediationDashboardKpis = {
    ativas: num(k.ativas),
    vencendo: num(k.vencendo),
    aguardando_contrato: num(k.aguardando_contrato),
    aguardando_termo: num(k.aguardando_termo),
    aguardando_pagamento: num(k.aguardando_pagamento),
    prontas_concluir: num(k.prontas_concluir),
    vendidas_periodo: num(k.vendidas_periodo),
    encerradas_periodo: num(k.encerradas_periodo),
    valor_vendido_periodo: num(k.valor_vendido_periodo),
    comissao_apurada: num(k.comissao_apurada),
    comissao_paga: num(k.comissao_paga),
    comissao_pendente: num(k.comissao_pendente),
  };

  const atencao: IntermediationDashboardAtencao = {
    prazos: asArray(a.prazos).map((x): DashboardPrazoItem => ({
      intermediation_id: str(x.intermediation_id),
      owner_lead_id: str(x.owner_lead_id),
      code: str(x.code),
      lead_name: strOrNull(x.lead_name),
      ends_at: strOrNull(x.ends_at),
      deadline_status: (x.deadline_status as DeadlineStatus) ?? "ok",
    })),
    contratos_pendentes: asArray(a.contratos_pendentes).map((x): DashboardContratoPendenteItem => ({
      intermediation_id: str(x.intermediation_id),
      owner_lead_id: str(x.owner_lead_id),
      code: str(x.code),
      lead_name: strOrNull(x.lead_name),
      contract_status: (x.contract_status as ContractStatus) ?? "none",
    })),
    termos_pendentes: asArray(a.termos_pendentes).map((x): DashboardTermoPendenteItem => ({
      intermediation_id: str(x.intermediation_id),
      owner_lead_id: str(x.owner_lead_id),
      code: str(x.code),
      lead_name: strOrNull(x.lead_name),
      sale_contract_status: (x.sale_contract_status as SaleContractStatus) ?? "none",
      sale_price: numOrNull(x.sale_price),
    })),
    pagamentos_pendentes: asArray(a.pagamentos_pendentes).map((x): DashboardPagamentoPendenteItem => ({
      intermediation_id: str(x.intermediation_id),
      owner_lead_id: str(x.owner_lead_id),
      code: str(x.code),
      lead_name: strOrNull(x.lead_name),
      sale_price: numOrNull(x.sale_price),
      payment_status: (x.payment_status as IntermediationPaymentStatus | null) ?? null,
    })),
    prontas_concluir: asArray(a.prontas_concluir).map((x): DashboardProntaConcluirItem => ({
      intermediation_id: str(x.intermediation_id),
      owner_lead_id: str(x.owner_lead_id),
      code: str(x.code),
      lead_name: strOrNull(x.lead_name),
      sale_price: numOrNull(x.sale_price),
    })),
  };

  const ranking: IntermediationDashboardRankingRow[] = asArray(r.ranking).map((x) => ({
    member_id: str(x.member_id),
    name: str(x.name),
    captadas: num(x.captadas),
    vendidas: num(x.vendidas),
    premios_cents: num(x.premios_cents),
  }));

  const premios: IntermediationDashboardPremios = {
    pendente_cents: num(p.pendente_cents),
    aprovado_cents: num(p.aprovado_cents),
    pago_cents: num(p.pago_cents),
    pendente_qtd: num(p.pendente_qtd),
  };

  return {
    period: (r.period as IntermediationDashboardPeriod) ?? "month",
    period_start: str(r.period_start),
    generated_at: str(r.generated_at),
    kpis,
    atencao,
    ranking,
    premios,
  };
}

/**
 * Painel de gestão da intermediação: uma chamada agrega KPIs, listas
 * acionáveis, ranking de promotoras e prêmios. Só gestor (admin/comercial/
 * closer) — promotora recebe erro "Sem acesso" do RPC (SECURITY DEFINER).
 */
export function useIntermediationDashboard(period: IntermediationDashboardPeriod) {
  return useQuery({
    queryKey: intermediationKeys.dashboard(period),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("intermediation_dashboard", { p_period: period });
      if (error) throw error;
      return normalizeDashboard(data);
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
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

interface InvokeErrorInfo {
  message: string;
  status: number;
  body: Record<string, unknown> | null;
}

/**
 * Lê o erro do `functions.invoke`: FunctionsHttpError guarda a Response em `context`,
 * e as edge fns respondem `{error: "mensagem", ...}`. Se não for JSON, fica o fallback.
 */
async function readInvokeError(error: unknown, fallback: string): Promise<InvokeErrorInfo> {
  let message = (error as { message?: string })?.message || fallback;
  let status = 0;
  let body: Record<string, unknown> | null = null;
  const ctx = (error as { context?: unknown })?.context;
  if (typeof Response !== "undefined" && ctx instanceof Response) {
    status = ctx.status;
    try {
      const j: unknown = await ctx.clone().json();
      if (j && typeof j === "object") {
        body = j as Record<string, unknown>;
        if (typeof body.error === "string" && body.error) message = body.error;
        else if (typeof body.message === "string" && body.message) message = body.message;
      }
    } catch { /* corpo não é JSON — fica a mensagem padrão */ }
  }
  // Mensagens genéricas do supabase-js não ajudam o usuário
  if (/non-2xx status code/i.test(message)) message = fallback;
  return { message, status, body };
}

/** Traduz um erro do `functions.invoke` do `contract-render`. */
async function toRenderError(error: unknown, fallback: string): Promise<ContractRenderError> {
  const { message, status, body } = await readInvokeError(error, fallback);
  const missing = Array.isArray(body?.missing) ? (body!.missing as ContractMissing[]) : [];
  let msg = message;
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
    mutationFn: async ({ id, reason, documentType }: { id: string; leadId?: string | null; reason?: string | null; documentType?: ContractDocumentType }) => {
      const { data, error } = await supabase.functions.invoke("contract-render", {
        body: {
          intermediation_id: id,
          reason: reason?.trim() || undefined,
          ...(documentType ? { document_type: documentType } : {}),
        },
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
export async function openContractPreview(intermediationId: string, documentType?: ContractDocumentType): Promise<void> {
  // "noopener" faria window.open devolver null — abre em branco e corta o opener na mão
  const win = window.open("about:blank", "_blank");
  if (win) win.opener = null;
  try {
    const { data, error } = await supabase.functions.invoke("contract-render", {
      body: { preview: true, intermediation_id: intermediationId, ...(documentType ? { document_type: documentType } : {}) },
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

// ═══ Fase 3 — Assinatura eletrônica (migration 20260913100000 + edge fn contract-send) ═══

/** Eventos do provedor (Clicksign) de um documento — mais recente primeiro. */
export function useContractEvents(documentId: string | null | undefined) {
  return useQuery({
    queryKey: intermediationKeys.contractEvents(documentId ?? ""),
    enabled: !!documentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contract_events")
        .select("*")
        .eq("document_id", documentId!)
        .order("received_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as ContractEvent[];
    },
    staleTime: 15_000,
  });
}

/** Erro da edge fn `contract-send` (status HTTP + corpo JSON quando houver). */
export class ContractSendError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null = null) {
    super(message);
    this.name = "ContractSendError";
    this.status = status;
    this.body = body;
  }
}

/** Signatário como a UI manda pro `contract-send` (action `send`). */
export interface ContractSendSignerInput {
  signer_id: string;
  channel: ContractSignerChannel;
  auth_method: ContractSignerAuthMethod;
  /** Se vierem, a edge fn atualiza `contract_signers` antes de criar o envelope. */
  email?: string;
  phone?: string;
}

/**
 * Body aceito pela edge fn `contract-send` (verify_jwt; roles admin/comercial/closer).
 * Mantém 1:1 com a spec da fase 3 — se mudar lá, muda aqui.
 */
export type ContractSendBody =
  | { action: "send"; document_id: string; signers: ContractSendSignerInput[]; deadline_days: number; message?: string }
  | { action: "resend"; document_id: string; message?: string }
  | { action: "cancel"; document_id: string; reason: string }
  | { action: "status"; document_id: string }
  | { action: "register_webhook" }
  | { action: "test_connection" };

/** Chama `contract-send` e devolve o JSON; erros HTTP viram `ContractSendError` com a mensagem do servidor. */
async function invokeContractSend<T extends object>(body: ContractSendBody, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("contract-send", { body });
  if (error) {
    const { message, status, body: errBody } = await readInvokeError(error, fallback);
    throw new ContractSendError(message, status, errBody);
  }
  const r = (data ?? {}) as Record<string, unknown>;
  if (typeof r.error === "string" && r.error) throw new ContractSendError(r.error, 400, r);
  if (r.ok === false) throw new ContractSendError(typeof r.message === "string" ? r.message : fallback, 400, r);
  return r as T;
}

/** Resposta padrão das actions que devolvem o documento. */
export interface ContractSendDocumentResult {
  ok?: boolean;
  document: ContractDocument;
}

/** A edge fn pode devolver `{document}` ou o documento direto — normaliza. */
function pickDocument(r: Record<string, unknown>): ContractDocument | null {
  if (r.document && typeof r.document === "object") return r.document as ContractDocument;
  if (typeof r.id === "string" && typeof r.status === "string") return r as unknown as ContractDocument;
  return null;
}

/**
 * Envia o contrato gerado pra assinatura eletrônica (cria o envelope no provedor,
 * marca o doc como `sent`). Doc precisa estar em generated|ready|error.
 */
export function useContractSend() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ documentId, signers, deadlineDays, message }: {
      documentId: string;
      leadId?: string | null;
      signers: ContractSendSignerInput[];
      deadlineDays: number;
      message?: string | null;
    }) => {
      const days = Math.min(30, Math.max(1, Math.round(deadlineDays || 7)));
      const body: ContractSendBody = {
        action: "send",
        document_id: documentId,
        signers,
        deadline_days: days,
        ...(message?.trim() ? { message: message.trim() } : {}),
      };
      const r = await invokeContractSend<Record<string, unknown>>(body, "Não consegui enviar o contrato pra assinatura.");
      const document = pickDocument(r);
      if (!document) throw new ContractSendError("O envio não devolveu o documento atualizado.", 500, r);
      return { ok: r.ok !== false, document } satisfies ContractSendDocumentResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Reenvia os convites (notificação do envelope). Doc em sent|partial. */
export function useContractResend() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ documentId, message }: { documentId: string; leadId?: string | null; message?: string | null }) => {
      const body: ContractSendBody = {
        action: "resend",
        document_id: documentId,
        ...(message?.trim() ? { message: message.trim() } : {}),
      };
      return invokeContractSend<{ ok?: boolean; document?: ContractDocument }>(body, "Não consegui reenviar os convites.");
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Cancela o envio no provedor e marca o doc como `cancelled` (com motivo). */
export function useContractCancel() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ documentId, reason }: { documentId: string; leadId?: string | null; reason: string }) => {
      const clean = reason.trim();
      if (clean.length < 3) throw new ContractSendError("Descreva o motivo do cancelamento.", 400);
      const body: ContractSendBody = { action: "cancel", document_id: documentId, reason: clean };
      return invokeContractSend<{ ok?: boolean; document?: ContractDocument }>(body, "Não consegui cancelar o envio.");
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export interface ContractStatusResult {
  document: ContractDocument | null;
  /** Quantos eventos novos foram aplicados nessa conferência. */
  applied: number;
  /** true quando o PDF assinado foi baixado, conferido e a intermediação formalizada agora. */
  finalized: boolean;
}

/** "Verificar agora": consulta o provedor, aplica eventos pendentes e, se fechado, baixa/valida o PDF assinado. */
export function useContractStatus() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ documentId }: { documentId: string; leadId?: string | null }) => {
      const body: ContractSendBody = { action: "status", document_id: documentId };
      const r = await invokeContractSend<Record<string, unknown>>(body, "Não consegui consultar o status da assinatura.");
      return {
        document: pickDocument(r),
        applied: typeof r.applied === "number" ? r.applied : Array.isArray(r.applied) ? r.applied.length : r.applied === true ? 1 : 0,
        finalized: r.finalized === true,
      } satisfies ContractStatusResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export interface ClicksignRegisterWebhookResult {
  ok: boolean;
  webhook_id: string | null;
  endpoint: string | null;
}

/** Admin: registra o webhook `clicksign-webhook` na Clicksign e guarda o secret no servidor (nunca volta pra UI). */
export function useClicksignRegisterWebhook() {
  return useMutation({
    mutationFn: async () => {
      const r = await invokeContractSend<Record<string, unknown>>({ action: "register_webhook" }, "Não consegui registrar o webhook na Clicksign.");
      return {
        ok: r.ok !== false,
        webhook_id: typeof r.webhook_id === "string" ? r.webhook_id : null,
        endpoint: typeof r.endpoint === "string" ? r.endpoint : null,
      } satisfies ClicksignRegisterWebhookResult;
    },
  });
}

export interface ClicksignTestResult {
  ok: boolean;
  env: "sandbox" | "production" | string;
}

/** Faz um GET leve na Clicksign com a chave do tenant — confirma token + ambiente. */
export function useClicksignTest() {
  return useMutation({
    mutationFn: async () => {
      const r = await invokeContractSend<Record<string, unknown>>({ action: "test_connection" }, "Não consegui conectar na Clicksign.");
      return { ok: r.ok !== false, env: typeof r.env === "string" ? r.env : "sandbox" } satisfies ClicksignTestResult;
    },
  });
}

// ═══ Fase 4 — Comprador, propostas, pagamento e conclusão da venda ═══════════
// (migration 20260914100000 + edge fn contract-render/contract-send com document_type SALE_CONTRACT)

/** Propostas do comprador (mais recente primeiro). Promotora não tem acesso (RLS). */
export function useIntermediationProposals(intermediationId: string | null | undefined) {
  return useQuery({
    queryKey: intermediationKeys.proposals(intermediationId ?? ""),
    enabled: !!intermediationId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("intermediation_proposals")
        .select("*")
        .eq("intermediation_id", intermediationId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Proposal[];
    },
    staleTime: 15_000,
  });
}

/** Grava os dados do comprador (Termo de Compra e Venda). Bloqueado depois do termo assinado (menos admin). */
export function useSetBuyer() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, buyer, buyerLeadId }: { id: string; leadId?: string | null; buyer: BuyerData; buyerLeadId?: string | null }) => {
      const { data, error } = await supabase.rpc("intermediation_set_buyer", { p_id: id, p_buyer: buyer, p_buyer_lead_id: buyerLeadId ?? null });
      if (error) throw error;
      return (data ?? { ok: false }) as { ok: boolean };
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Registra uma proposta do comprador (histórico). Exige intermediação ativa. */
export function useAddProposal() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; leadId?: string | null; data: ProposalInput }) => {
      const { data: res, error } = await supabase.rpc("intermediation_add_proposal", { p_id: id, p_data: data });
      if (error) throw error;
      return (res ?? { ok: false }) as { ok: boolean; proposal_id?: string };
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Aceita/recusa uma proposta. Aceitar carimba a venda e move o funil pra Fechamento. */
export function useDecideProposal() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ proposalId, decision, note }: { proposalId: string; leadId?: string | null; decision: "accepted" | "rejected"; note?: string | null }) => {
      const { data, error } = await supabase.rpc("intermediation_decide_proposal", { p_proposal_id: proposalId, p_decision: decision, p_note: note ?? null });
      if (error) throw error;
      return (data ?? { ok: false, decision }) as { ok: boolean; decision: "accepted" | "rejected" };
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Confirma o pagamento do comprador (valor + observação). `full=false` marca pagamento parcial. */
export function useConfirmPayment() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, amount, note, full }: { id: string; leadId?: string | null; amount: number; note?: string | null; full?: boolean }) => {
      const { data, error } = await supabase.rpc("intermediation_confirm_payment", { p_id: id, p_amount: amount, p_note: note ?? null, p_full: full ?? true });
      if (error) throw error;
      return (data ?? { ok: false, payment_status: "pending" }) as { ok: boolean; payment_status: IntermediationPaymentStatus };
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

/** Conclui a venda (termo assinado + pagamento confirmado). Marca o carro vendido → R$ 50. */
export function useConcludeSale() {
  const invalidate = useInvalidateIntermediation();
  return useMutation({
    mutationFn: async ({ id, note }: { id: string; leadId?: string | null; note?: string | null }) => {
      const { data, error } = await supabase.rpc("intermediation_conclude_sale", { p_id: id, p_note: note ?? null });
      if (error) throw error;
      return (data ?? { ok: false }) as { ok: boolean; code?: string; status?: string; already?: boolean };
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
}

export interface ImportSaleContractResult {
  ok: boolean;
  code?: string;
  already?: boolean;
  sale_contract_status?: string;
  document_id?: string;
}

/**
 * Admin: importa o PDF do Termo de Compra e Venda assinado em papel. Mesmo padrão do
 * `useImportSignedContract` (upload no bucket privado, calcula sha256, chama a RPC).
 */
export function useImportSaleContract() {
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
      /** `intermediations.sale_document_id` — o PDF assinado desta versão gerada. */
      documentId?: string | null;
    }) => {
      if (!tenantId) throw new Error("Não consegui identificar sua empresa (tenant). Recarregue a página e tente de novo.");
      if (!isPdf(file)) throw new Error("O termo precisa ser um arquivo PDF.");
      if (file.size > 25 * 1024 * 1024) throw new Error("PDF muito grande — o limite é 25 MB.");
      if (reason.trim().length < 3) throw new Error("Informe o motivo/origem da importação (ex.: assinado em papel na loja).");

      const sha256 = await sha256Hex(file);
      const path = `${tenantId}/${id}/${Date.now()}-termo-venda.pdf`;

      const up = await supabase.storage.from(CONTRACTS_BUCKET).upload(path, file, { contentType: "application/pdf", upsert: false });
      if (up.error) throw new Error(`Não consegui enviar o PDF: ${up.error.message}`);

      const signedIso = /^\d{4}-\d{2}-\d{2}$/.test(signedAt) ? new Date(`${signedAt}T12:00:00`).toISOString() : new Date(signedAt).toISOString();
      const { data, error } = await supabase.rpc("intermediation_import_sale_contract", {
        p_id: id,
        p_file_path: path,
        p_sha256: sha256,
        p_signed_at: signedIso,
        p_reason: reason.trim(),
        p_document_id: documentId ?? null,
      });
      if (error) {
        await supabase.storage.from(CONTRACTS_BUCKET).remove([path]).catch(() => undefined);
        throw error;
      }
      return (data ?? { ok: false }) as ImportSaleContractResult;
    },
    onSuccess: (_d, { leadId }) => invalidate(leadId),
  });
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
        signer_email: clean(input.signer_email)?.toLowerCase() ?? null,
        signer_phone: clean(input.signer_phone),
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
