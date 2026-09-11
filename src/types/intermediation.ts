/**
 * INTERMEDIAÇÃO — entidade-mãe (migration 20260911200000_intermediacao_nucleo).
 *
 * Lead do proprietário, veículo (seller_vehicles), deal do funil, contrato,
 * prazo, estados alternativos e prêmios da promotora apontam pra ela.
 * Escrita SÓ via RPCs (`intermediation_*`) — ver src/hooks/useIntermediation.ts.
 */

export type IntermediationStatus =
  | "lead"
  | "contracting"
  | "active"
  | "completed"
  | "paused"
  | "cancelled_by_owner"
  | "refused_by_totex"
  | "lost"
  | "sold_outside"
  | "docs_pending";

export type IntermediationSource = "promotora" | "qr" | "indicacao" | "campanha" | "franqueado" | "manual" | "outro";
export type CommissionType = "fixed" | "percent";
export type CustodyMode = "owner" | "totex";
export type TestDrivePolicy = "accompanied" | "specific_authorization" | "not_allowed";

export type ContractStatus =
  | "none"
  | "generated"
  | "sent"
  | "partial"
  | "signed"
  | "imported"
  | "declined"
  | "expired"
  | "cancelled";

export type DeadlineStatus = "ok" | "expiring" | "expired";
export type IntermediationPaymentStatus = "pending" | "partial" | "satisfied" | "failed" | "cancelled";
export type TransferStatus = "pending" | "started" | "completed";
export type CommissionStatus = "pending" | "invoiced" | "paid" | "waived" | "disputed";

/** Linha da tabela `intermediations`. */
export interface Intermediation {
  id: string;
  tenant_id: string;
  code: string;
  legal_entity_id: string | null;
  location_id: string | null;
  // partes
  owner_lead_id: string;
  promoter_id: string | null;
  source: IntermediationSource;
  vehicle_id: string | null;
  buyer_lead_id: string | null;
  buyer_deal_id: string | null;
  // ciclo de vida
  status: IntermediationStatus;
  status_before_pause: IntermediationStatus | null;
  status_reason: string | null;
  activated_at: string | null;
  completed_at: string | null;
  closed_at: string | null;
  // condições comerciais
  asking_price: number | null;
  minimum_authorized_price: number | null;
  commission_type: CommissionType | null;
  commission_value: number | null;
  exclusive: boolean;
  starts_at: string | null; // 'YYYY-MM-DD'
  ends_at: string | null; // 'YYYY-MM-DD'
  custody_mode: CustodyMode;
  physical_display_authorized: boolean;
  test_drive_policy: TestDrivePolicy;
  terms_notes: string | null;
  terms_set_at: string | null;
  terms_set_by: string | null;
  // contrato
  contract_status: ContractStatus;
  contract_signed_at: string | null;
  contract_file_path: string | null;
  contract_sha256: string | null;
  contract_imported_by: string | null;
  contract_import_reason: string | null;
  contract_document_id: string | null;
  // prazo
  deadline_status: DeadlineStatus;
  deadline_alerted_at: string | null;
  // fechamento / financeiro
  sale_price: number | null;
  payment_status: IntermediationPaymentStatus;
  transfer_status: TransferStatus;
  delivered_at: string | null;
  commission_due: number | null;
  commission_status: CommissionStatus;
  commission_paid_at: string | null;
  // auditoria
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Linha da tabela `intermediation_events` (trilha de auditoria). */
export interface IntermediationEvent {
  id: string;
  tenant_id: string;
  intermediation_id: string;
  event_type: string;
  actor_member_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: string;
}

/** Linha da tabela `legal_entities` (razão social/CNPJ que assina o contrato). */
export interface LegalEntity {
  id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  cnpj: string | null;
  address: string | null;
  city_name: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  email: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Subconjunto aceito por `intermediation_set_terms(p_id, p_terms)`. */
export interface IntermediationTermsInput {
  asking_price?: number | null;
  minimum_authorized_price?: number | null;
  commission_type?: CommissionType | null;
  commission_value?: number | null;
  exclusive?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  custody_mode?: CustodyMode;
  physical_display_authorized?: boolean;
  test_drive_policy?: TestDrivePolicy;
  terms_notes?: string | null;
}

/** p_status aceito por `intermediation_set_status`. */
export type IntermediationStatusAction =
  | "paused"
  | "docs_pending"
  | "cancelled_by_owner"
  | "refused_by_totex"
  | "lost"
  | "sold_outside"
  | "reactivate";

/** Retorno de `intermediation_funnel(p_period)`. */
export interface IntermediationFunnel {
  period_start: string;
  captadas: number;
  validas: number;
  formalizadas: number;
  em_vitrine: number;
  com_proposta: number;
  vendidas: number;
  encerradas: number;
  ativas: number;
  vencendo: number;
  comissao_apurada: number;
  comissao_paga: number;
  dias_para_formalizar: number | null;
  dias_para_vender: number | null;
}

export type IntermediationFunnelPeriod = "week" | "month" | "all";

// ─── Labels / cores ──────────────────────────────────────────────────────────

interface BadgeMeta {
  label: string;
  cls: string;
}

const CLS = {
  muted: "bg-muted text-muted-foreground border-border",
  sky: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  orange: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900",
  amber: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  emeraldSolid: "bg-emerald-600 text-white border-emerald-600",
  red: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  purple: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-900",
  zinc: "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100",
};

export const INTERMEDIATION_STATUS_META: Record<IntermediationStatus, BadgeMeta & { closed: boolean }> = {
  lead: { label: "Captada", cls: CLS.muted, closed: false },
  contracting: { label: "Contratando", cls: CLS.orange, closed: false },
  active: { label: "Formalizada", cls: CLS.emerald, closed: false },
  completed: { label: "Concluída", cls: CLS.emeraldSolid, closed: true },
  paused: { label: "Pausada", cls: CLS.amber, closed: false },
  cancelled_by_owner: { label: "Cancelada pelo proprietário", cls: CLS.red, closed: true },
  refused_by_totex: { label: "Recusada pela Totex", cls: CLS.red, closed: true },
  lost: { label: "Perdida", cls: CLS.red, closed: true },
  sold_outside: { label: "Vendida por fora", cls: CLS.red, closed: true },
  docs_pending: { label: "Documentação pendente", cls: CLS.amber, closed: false },
};

export const CONTRACT_STATUS_META: Record<ContractStatus, BadgeMeta> = {
  none: { label: "Sem contrato", cls: CLS.muted },
  generated: { label: "Contrato gerado", cls: CLS.sky },
  sent: { label: "Enviado pra assinatura", cls: CLS.sky },
  partial: { label: "Parcialmente assinado", cls: CLS.amber },
  signed: { label: "Assinado", cls: CLS.emerald },
  imported: { label: "Assinado (importado)", cls: CLS.emerald },
  declined: { label: "Recusado", cls: CLS.red },
  expired: { label: "Expirado", cls: CLS.red },
  cancelled: { label: "Cancelado", cls: CLS.muted },
};

export const COMMISSION_STATUS_META: Record<CommissionStatus, BadgeMeta> = {
  pending: { label: "Pendente", cls: CLS.amber },
  invoiced: { label: "Faturada", cls: CLS.sky },
  paid: { label: "Paga", cls: CLS.emeraldSolid },
  waived: { label: "Dispensada", cls: CLS.muted },
  disputed: { label: "Em disputa", cls: CLS.red },
};

export const DEADLINE_STATUS_META: Record<DeadlineStatus, BadgeMeta> = {
  ok: { label: "No prazo", cls: CLS.muted },
  expiring: { label: "Vencendo", cls: CLS.amber },
  expired: { label: "Prazo venceu", cls: CLS.red },
};

export const CUSTODY_MODE_LABEL: Record<CustodyMode, string> = {
  owner: "Fica com o proprietário",
  totex: "Fica com a Totex",
};

export const TEST_DRIVE_POLICY_LABEL: Record<TestDrivePolicy, string> = {
  accompanied: "Permitido, acompanhado",
  specific_authorization: "Só com autorização específica",
  not_allowed: "Não permitido",
};

export const COMMISSION_TYPE_LABEL: Record<CommissionType, string> = {
  fixed: "Valor fixo (R$)",
  percent: "Percentual (%)",
};

export const INTERMEDIATION_SOURCE_LABEL: Record<IntermediationSource, string> = {
  promotora: "Promotora",
  qr: "QR Code",
  indicacao: "Indicação",
  campanha: "Campanha",
  franqueado: "Franqueado",
  manual: "Manual",
  outro: "Outro",
};

/** Label em PT dos event_type gravados em `intermediation_events`. */
export const INTERMEDIATION_EVENT_LABEL: Record<string, string> = {
  intermediation_lead_created: "Intermediação criada (lead captado)",
  intermediation_qualified: "1º contato feito",
  vehicle_registered: "Veículo cadastrado",
  commercial_terms_set: "Condições comerciais atualizadas",
  intermediation_contract_signed: "Contrato assinado",
  intermediation_activated: "Intermediação formalizada",
  vehicle_published: "Carro anunciado",
  buyer_linked: "Comprador interessado",
  intermediation_completed: "Intermediação concluída (venda)",
  intermediation_cancelled: "Intermediação encerrada",
  intermediation_paused: "Intermediação pausada",
  documentation_pending: "Documentação pendente",
  intermediation_reactivated: "Intermediação reativada",
  deadline_expiring: "Prazo vencendo",
  deadline_expired: "Prazo venceu",
  commission_paid: "Comissão paga",
  commission_invoiced: "Comissão faturada",
  commission_status_changed: "Status da comissão alterado",
};

/** Termos obrigatórios pra formalizar (preço pretendido + comissão + prazo final). */
export function missingTerms(i: Pick<Intermediation, "asking_price" | "commission_type" | "commission_value" | "ends_at">): string[] {
  const missing: string[] = [];
  if (i.asking_price == null) missing.push("preço");
  if (i.commission_type == null || i.commission_value == null) missing.push("comissão");
  if (!i.ends_at) missing.push("prazo");
  return missing;
}

export const isTermsComplete = (i: Parameters<typeof missingTerms>[0]) => missingTerms(i).length === 0;
