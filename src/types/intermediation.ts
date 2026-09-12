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

/** Fase 4 — forma de pagamento da venda (comprador). */
export type PaymentMethod = "cash" | "financing" | "mixed" | "consortium" | "other";
/** Fase 4 — status do Termo de Compra e Venda (mesma união do contrato de intermediação). */
export type SaleContractStatus = ContractStatus;
/** Fase 4 — status de uma proposta do comprador. */
export type ProposalStatus = "pending" | "accepted" | "rejected" | "countered" | "withdrawn" | "superseded";

/** Item de `intermediations.financial_concessions` (Fase 5 — concessão financeira aprovada). */
export interface FinancialConcession {
  amount: number;
  description: string;
  by?: string | null;
  at?: string | null;
}

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
  /** Fase 2: CPF/RG/endereço do proprietário (o que o lead não tinha). */
  owner_data: OwnerData;
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
  // fase 5: concessões financeiras excepcionais (alçada)
  financial_concessions: FinancialConcession[];
  concession_total: number;
  // fase 4: comprador + Termo de Compra e Venda + pagamento
  /** Dados do comprador (o que o lead do comprador não tem). */
  buyer_data: BuyerData;
  payment_method: PaymentMethod | null;
  down_payment: number | null;
  financed_amount: number | null;
  installments: number | null;
  paid_amount: number | null;
  payment_confirmed_at: string | null;
  payment_confirmed_by: string | null;
  payment_note: string | null;
  /** Documento SALE_CONTRACT vigente. */
  sale_document_id: string | null;
  sale_contract_status: SaleContractStatus;
  sale_signed_at: string | null;
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

export type LegalEntitySignerRole = "Administradora" | "Administrador" | "Procuradora" | "Procurador";

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
  /** Quem assina pela empresa (fase 5 troca por procurações). */
  signer_name: string | null;
  signer_cpf: string | null;
  signer_role: LegalEntitySignerRole | null;
  /** Fase 3: pra onde vai o convite de assinatura eletrônica de quem assina pela empresa. */
  signer_email: string | null;
  signer_phone: string | null;
  /** Cidade que aparece em "Local e data" do contrato (default: city_name). */
  contract_city: string | null;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Campos editáveis de `legal_entities` (upsert pela UI, admin). */
export type LegalEntityInput = Partial<
  Pick<
    LegalEntity,
    | "id"
    | "legal_name"
    | "trade_name"
    | "cnpj"
    | "address"
    | "city_name"
    | "state"
    | "zip"
    | "phone"
    | "email"
    | "signer_name"
    | "signer_cpf"
    | "signer_role"
    | "signer_email"
    | "signer_phone"
    | "contract_city"
    | "is_default"
    | "is_active"
  >
> & { legal_name: string };

// ─── Fase 2: documentos / contratos ─────────────────────────────────────────

export type ContractDocumentType =
  | "INTERMEDIATION_CONTRACT"
  | "PRICE_AUTHORIZATION"
  | "CUSTODY_TERM"
  | "TEST_DRIVE_TERM"
  | "BUYER_PROPOSAL"
  | "SALE_CONTRACT"
  | "DELIVERY_TERM"
  | "CANCELLATION_TERM";

export type ContractTemplateStatus = "draft" | "published" | "retired";

/** Linha de `contract_templates` (jurídico, versionado; publicado é imutável). */
export interface ContractTemplate {
  id: string;
  /** null = global (Totex) — só superadmin edita. */
  tenant_id: string | null;
  document_type: ContractDocumentType;
  name: string;
  version: number;
  status: ContractTemplateStatus;
  body: string;
  required_variables: string[];
  signer_policy: { signers: string[] } | Record<string, unknown>;
  notes: string | null;
  effective_from: string | null;
  retired_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type ContractDocumentStatus =
  | "draft"
  | "generated"
  | "ready"
  | "sent"
  | "partial"
  | "completed"
  | "validated"
  | "declined"
  | "expired"
  | "cancelled"
  | "error"
  | "archived";

export type ContractSignerPartyType = "owner" | "company" | "buyer" | "witness";
export type ContractSignerStatus = "pending" | "sent" | "viewed" | "signed" | "declined";
/** Por onde o signatário recebe o convite. */
export type ContractSignerChannel = "email" | "whatsapp" | "sms";
/** Como o signatário prova quem é na hora de assinar. */
export type ContractSignerAuthMethod = "email" | "whatsapp" | "sms" | "pix";

/** Linha de `contract_signers` (signatários previstos de um documento). */
export interface ContractSigner {
  id: string;
  tenant_id: string;
  document_id: string;
  party_type: ContractSignerPartyType;
  party_id: string | null;
  name: string;
  cpf_cnpj: string | null;
  email: string | null;
  phone: string | null;
  signing_order: number;
  provider_signer_id: string | null;
  status: ContractSignerStatus;
  /** Fase 3 (assinatura eletrônica). */
  channel: ContractSignerChannel | null;
  auth_method: ContractSignerAuthMethod | null;
  sent_at: string | null;
  viewed_at: string | null;
  signed_at: string | null;
  refused_at: string | null;
  refusal_reason: string | null;
  provider_meta: Record<string, unknown>;
  created_at: string;
}

/** Status do envelope no provedor (Clicksign: draft|running|closed|canceled). */
export type ContractProviderStatus = "draft" | "running" | "closed" | "canceled" | string;

/** Linha de `contract_documents` (cada geração = uma versão; regenerar cancela a anterior). */
export interface ContractDocument {
  id: string;
  tenant_id: string;
  intermediation_id: string;
  document_type: ContractDocumentType;
  template_id: string | null;
  template_version: number | null;
  version: number;
  status: ContractDocumentStatus;
  snapshot_json: Record<string, unknown>;
  rendered_file_path: string | null;
  rendered_sha256: string | null;
  signed_file_path: string | null;
  signed_sha256: string | null;
  provider: string | null;
  provider_document_id: string | null;
  /** Fase 3: envelope no provedor + estado bruto lá. */
  provider_envelope_id: string | null;
  provider_status: ContractProviderStatus | null;
  provider_meta: Record<string, unknown>;
  /** Prazo pra assinar (ISO). */
  deadline_at: string | null;
  last_event_at: string | null;
  last_reconciled_at: string | null;
  /** Preenchido quando status = error (envio falhou). */
  error_message: string | null;
  generated_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  validated_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  generated_by: string | null;
  created_at: string;
  updated_at: string;
  /** Embed `contract_signers(*)`. */
  contract_signers?: ContractSigner[];
}

/** event_type normalizado de `contract_events`. */
export type ContractEventType =
  | "created"
  | "sent"
  | "viewed"
  | "signed"
  | "refused"
  | "completed"
  | "canceled"
  | "expired"
  | "error"
  | "info";

/** Linha de `contract_events` (trilha bruta do provedor; só leitura no front). */
export interface ContractEvent {
  id: string;
  tenant_id: string;
  document_id: string;
  provider: string;
  provider_event_id: string | null;
  event_type: ContractEventType | string;
  raw_event_name: string | null;
  /** provider_signer_id, e-mail ou telefone do signatário afetado. */
  signer_ref: string | null;
  payload: Record<string, unknown>;
  occurred_at: string | null;
  received_at: string;
  idempotency_key: string;
}

export type ContractMissingSource = "terms" | "contract_data.owner" | "contract_data.vehicle" | "legal_entity" | "other";

/** Item de `missing` do snapshot — a UI leva o usuário até o campo certo. */
export interface ContractMissing {
  key: string;
  label: string;
  source: ContractMissingSource;
}

/** Retorno de `intermediation_contract_snapshot(p_id, p_document_type)`. */
export interface ContractSnapshot {
  variables: Record<string, string | null>;
  missing: ContractMissing[];
  ready: boolean;
  template: { id: string; name: string; version: number; document_type: ContractDocumentType; global: boolean } | null;
  next_version: number;
  legal_entity_id: string | null;
}

/** `intermediations.owner_data` — dados do proprietário que o lead não tem. */
export interface OwnerData {
  cpf_cnpj?: string | null;
  rg?: string | null;
  address?: string | null;
  address_number?: string | null;
  complement?: string | null;
  district?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** `intermediations.buyer_data` — dados do comprador pro Termo de Compra e Venda. */
export interface BuyerData {
  name?: string | null;
  cpf_cnpj?: string | null;
  rg?: string | null;
  address?: string | null;
  address_number?: string | null;
  complement?: string | null;
  district?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Linha da tabela `intermediation_proposals` (histórico de propostas do comprador). */
export interface Proposal {
  id: string;
  tenant_id: string;
  intermediation_id: string;
  buyer_lead_id: string | null;
  buyer_name: string | null;
  amount: number;
  payment_method: PaymentMethod | null;
  down_payment: number | null;
  financed_amount: number | null;
  installments: number | null;
  notes: string | null;
  status: ProposalStatus;
  created_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/** p_data de `intermediation_add_proposal` (valores brutos; o servidor normaliza). */
export interface ProposalInput {
  buyer_name?: string | null;
  amount: number;
  payment_method?: PaymentMethod | null;
  down_payment?: number | null;
  financed_amount?: number | null;
  installments?: number | null;
  notes?: string | null;
  buyer_lead_id?: string | null;
}

/** `p_data.vehicle` de `intermediation_set_contract_data` (tudo string — o servidor normaliza). */
export interface ContractVehicleData {
  plate?: string | null;
  renavam?: string | null;
  chassis?: string | null;
  color?: string | null;
  fuel?: string | null;
  version?: string | null;
  brand?: string | null;
  model?: string | null;
  year_model?: string | null;
  km?: string | null;
  accessories?: string | null;
}

export interface ContractDataInput {
  owner?: OwnerData;
  vehicle?: ContractVehicleData;
}

export const DOCUMENT_TYPE_LABEL: Record<ContractDocumentType, string> = {
  INTERMEDIATION_CONTRACT: "Contrato de Intermediação",
  PRICE_AUTHORIZATION: "Autorização de preço",
  CUSTODY_TERM: "Termo de custódia",
  TEST_DRIVE_TERM: "Termo de test drive",
  BUYER_PROPOSAL: "Proposta do comprador",
  SALE_CONTRACT: "Contrato de compra e venda",
  DELIVERY_TERM: "Termo de entrega",
  CANCELLATION_TERM: "Termo de cancelamento",
};

export const CONTRACT_TEMPLATE_STATUS_LABEL: Record<ContractTemplateStatus, string> = {
  draft: "Rascunho",
  published: "Vigente",
  retired: "Aposentado",
};

export const CONTRACT_MISSING_SOURCE_LABEL: Record<ContractMissingSource, string> = {
  terms: "Condições comerciais",
  "contract_data.owner": "Dados do proprietário",
  "contract_data.vehicle": "Dados do veículo",
  legal_entity: "Entidade jurídica (Configurações)",
  other: "Outro",
};

export const SIGNER_PARTY_LABEL: Record<ContractSignerPartyType, string> = {
  owner: "Proprietário",
  company: "Empresa",
  buyer: "Comprador",
  witness: "Testemunha",
};

export const SIGNER_ROLE_OPTIONS: LegalEntitySignerRole[] = ["Administradora", "Administrador", "Procuradora", "Procurador"];

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

// ─── Painel de gestão (RPC `intermediation_dashboard`) ───────────────────────
// migration 20260914160000_intermediacao_painel. Uma chamada carrega o painel
// do gestor: KPIs, listas acionáveis, ranking de promotoras e prêmios.

export type IntermediationDashboardPeriod = "week" | "month" | "quarter" | "all";

/** KPIs do painel. Valores de comissão/venda são `numeric` em reais. */
export interface IntermediationDashboardKpis {
  ativas: number;
  vencendo: number;
  aguardando_contrato: number;
  aguardando_termo: number;
  aguardando_pagamento: number;
  prontas_concluir: number;
  vendidas_periodo: number;
  encerradas_periodo: number;
  valor_vendido_periodo: number;
  comissao_apurada: number;
  comissao_paga: number;
  comissao_pendente: number;
}

/** Campos comuns a toda linha das listas "precisa de atenção". */
interface DashboardAtencaoBase {
  intermediation_id: string;
  owner_lead_id: string;
  code: string;
  lead_name: string | null;
}

export interface DashboardPrazoItem extends DashboardAtencaoBase {
  ends_at: string | null;
  deadline_status: DeadlineStatus;
}

export interface DashboardContratoPendenteItem extends DashboardAtencaoBase {
  contract_status: ContractStatus;
}

export interface DashboardTermoPendenteItem extends DashboardAtencaoBase {
  sale_contract_status: SaleContractStatus;
  sale_price: number | null;
}

export interface DashboardPagamentoPendenteItem extends DashboardAtencaoBase {
  sale_price: number | null;
  payment_status: IntermediationPaymentStatus | null;
}

export interface DashboardProntaConcluirItem extends DashboardAtencaoBase {
  sale_price: number | null;
}

export interface IntermediationDashboardAtencao {
  prazos: DashboardPrazoItem[];
  contratos_pendentes: DashboardContratoPendenteItem[];
  termos_pendentes: DashboardTermoPendenteItem[];
  pagamentos_pendentes: DashboardPagamentoPendenteItem[];
  prontas_concluir: DashboardProntaConcluirItem[];
}

/** Linha do ranking de promotoras (prêmios em cents). */
export interface IntermediationDashboardRankingRow {
  member_id: string;
  name: string;
  captadas: number;
  vendidas: number;
  premios_cents: number;
}

/** Prêmios por status do ledger (valores em cents). */
export interface IntermediationDashboardPremios {
  pendente_cents: number;
  aprovado_cents: number;
  pago_cents: number;
  pendente_qtd: number;
}

/** Retorno de `intermediation_dashboard(p_period)`. */
export interface IntermediationDashboard {
  period: IntermediationDashboardPeriod;
  period_start: string;
  generated_at: string;
  kpis: IntermediationDashboardKpis;
  atencao: IntermediationDashboardAtencao;
  ranking: IntermediationDashboardRankingRow[];
  premios: IntermediationDashboardPremios;
}

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

/** Fase 4 — status do Termo de Compra e Venda (`intermediations.sale_contract_status`). */
export const SALE_CONTRACT_STATUS_META: Record<SaleContractStatus, BadgeMeta> = {
  none: { label: "—", cls: CLS.muted },
  generated: { label: "Gerado", cls: CLS.sky },
  sent: { label: "Enviado p/ assinatura", cls: CLS.sky },
  partial: { label: "Parcialmente assinado", cls: CLS.amber },
  signed: { label: "Assinado", cls: CLS.emerald },
  imported: { label: "Importado (papel)", cls: CLS.emerald },
  declined: { label: "Recusado", cls: CLS.red },
  expired: { label: "Expirado", cls: CLS.red },
  cancelled: { label: "Cancelado", cls: CLS.muted },
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "À vista",
  financing: "Financiamento",
  mixed: "Misto",
  consortium: "Consórcio/Carta",
  other: "A combinar",
};

export const PAYMENT_STATUS_META: Record<IntermediationPaymentStatus, BadgeMeta> = {
  pending: { label: "Pendente", cls: CLS.muted },
  partial: { label: "Parcial", cls: CLS.amber },
  satisfied: { label: "Pago", cls: CLS.emerald },
  failed: { label: "Falhou", cls: CLS.red },
  cancelled: { label: "Cancelado", cls: CLS.muted },
};

export const PROPOSAL_STATUS_META: Record<ProposalStatus, BadgeMeta> = {
  pending: { label: "Aguardando decisão", cls: CLS.amber },
  accepted: { label: "Aceita", cls: CLS.emerald },
  rejected: { label: "Recusada", cls: CLS.red },
  countered: { label: "Contraproposta", cls: CLS.sky },
  withdrawn: { label: "Retirada", cls: CLS.muted },
  superseded: { label: "Substituída", cls: CLS.muted },
};

export const CONTRACT_DOCUMENT_STATUS_META: Record<ContractDocumentStatus, BadgeMeta> = {
  draft: { label: "Rascunho", cls: CLS.muted },
  generated: { label: "Gerado · aguardando envio", cls: CLS.sky },
  ready: { label: "Pronto pra envio", cls: CLS.sky },
  sent: { label: "Enviado p/ assinatura", cls: CLS.sky },
  partial: { label: "Parcialmente assinado", cls: CLS.amber },
  completed: { label: "Assinado — conferindo PDF", cls: CLS.emerald },
  validated: { label: "Assinado e validado", cls: CLS.emeraldSolid },
  declined: { label: "Recusado", cls: CLS.red },
  expired: { label: "Prazo expirado", cls: CLS.red },
  cancelled: { label: "Cancelado", cls: CLS.muted },
  error: { label: "Erro no envio", cls: CLS.red },
  archived: { label: "Arquivado", cls: CLS.muted },
};

export const CONTRACT_SIGNER_STATUS_META: Record<ContractSignerStatus, BadgeMeta> = {
  pending: { label: "Aguardando envio", cls: CLS.muted },
  sent: { label: "Convite enviado", cls: CLS.sky },
  viewed: { label: "Visualizou", cls: CLS.amber },
  signed: { label: "Assinou", cls: CLS.emerald },
  declined: { label: "Recusou", cls: CLS.red },
};

export const SIGNER_CHANNEL_LABEL: Record<ContractSignerChannel, string> = {
  email: "E-mail",
  whatsapp: "WhatsApp",
  sms: "SMS",
};

export const SIGNER_AUTH_LABEL: Record<ContractSignerAuthMethod, string> = {
  email: "Token por e-mail",
  whatsapp: "Token por WhatsApp",
  sms: "Token por SMS",
  pix: "PIX (valida CPF)",
};

/** Label em PT dos event_type normalizados de `contract_events`. */
export const CONTRACT_EVENT_TYPE_LABEL: Record<ContractEventType, string> = {
  created: "Envelope criado",
  sent: "Convite enviado",
  viewed: "Documento visualizado",
  signed: "Assinatura registrada",
  refused: "Assinatura recusada",
  completed: "Todos assinaram",
  canceled: "Envio cancelado",
  expired: "Prazo expirado",
  error: "Erro no provedor",
  info: "Atualização do provedor",
};

/** Documento ainda pode ser enviado pro provedor (bate com `contract_document_mark_sent`). */
export const CONTRACT_SENDABLE_STATUSES: ContractDocumentStatus[] = ["generated", "ready", "error"];
/** Documento em trânsito no provedor (mostra chips, prazo, reenviar/verificar/cancelar). */
export const CONTRACT_IN_FLIGHT_STATUSES: ContractDocumentStatus[] = ["sent", "partial", "completed"];
/** Terminou sem assinatura — mostra motivo e libera "Enviar novamente"/"Regenerar". */
export const CONTRACT_FAILED_STATUSES: ContractDocumentStatus[] = ["declined", "expired", "cancelled", "error"];

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
  intermediation_contract_generated: "Contrato gerado (PDF)",
  intermediation_contract_sent: "Contrato enviado p/ assinatura eletrônica",
  contract_provider_event: "Atualização da assinatura eletrônica",
  contract_validated: "PDF assinado conferido (hash)",
  contract_document_cancelled: "Envio pra assinatura cancelado",
  contract_document_error: "Erro no envio pra assinatura",
  contract_document_ready: "Contrato pronto pra envio",
  contract_data_set: "Dados do contrato atualizados",
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
  approval_requested: "Aprovação solicitada",
  approval_approved: "Aprovação concedida",
  approval_rejected: "Aprovação recusada",
  approval_cancelled: "Pedido de aprovação cancelado",
  commission_changed: "Comissão alterada",
  financial_concession: "Concessão financeira",
  intermediation_document_generated: "Documento gerado (PDF)",
};

// ─── Fase 5: Representação (procurações) + Alçadas (aprovações) ───────────────
// migrations 20260915100000_intermediacao_procuracoes + 20260915140000_intermediacao_alcadas.
// Escrita SÓ via RPCs (`poa_*`, `approval_*`, `intermediation_*`); RLS bloqueia promotora.

/** Papel de quem assina/aprova (mesma união de legal_entities.signer_role). */
export type PoaRole = LegalEntitySignerRole;
export type PoaSignatureMode = "isolated" | "joint";
export type PoaStatus = "active" | "revoked" | "expired";

/** Linha de `powers_of_attorney` (representação: quem assina/aprova pela empresa). */
export interface PowerOfAttorney {
  id: string;
  tenant_id: string;
  /** null = vale pra qualquer entidade jurídica do tenant. */
  legal_entity_id: string | null;
  /** team_member correspondente (opcional). */
  member_id: string | null;
  signer_name: string;
  signer_cpf: string | null;
  signer_role: PoaRole;
  signature_mode: PoaSignatureMode;
  /** nº da procuração / ato societário. */
  doc_number: string | null;
  doc_url: string | null;
  /** document_types que pode assinar, ou ['*']. */
  scopes: string[];
  /** alçada de valor por ato (null = ilimitada). */
  max_value: number | null;
  /** decide exceções (alçadas) — administradora = true. */
  can_approve: boolean;
  valid_from: string | null;
  valid_until: string | null;
  is_default: boolean;
  status: PoaStatus;
  notes: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

/** `p_data` de `poa_upsert` (valores brutos; o servidor normaliza). */
export interface PowerOfAttorneyInput {
  id?: string | null;
  legal_entity_id?: string | null;
  member_id?: string | null;
  signer_name: string;
  signer_cpf?: string | null;
  signer_role?: PoaRole;
  signature_mode?: PoaSignatureMode;
  doc_number?: string | null;
  doc_url?: string | null;
  scopes?: string[];
  max_value?: number | null;
  can_approve?: boolean;
  valid_from?: string | null;
  valid_until?: string | null;
  notes?: string | null;
}

export const POA_ROLE: Record<PoaRole, string> = {
  Administradora: "Administradora",
  Administrador: "Administrador",
  Procuradora: "Procuradora",
  Procurador: "Procurador",
};

export const POA_SIGNATURE_MODE_LABEL: Record<PoaSignatureMode, string> = {
  isolated: "Assinatura isolada",
  joint: "Assinatura em conjunto",
};

export const POA_STATUS_META: Record<PoaStatus, BadgeMeta> = {
  active: { label: "Ativa", cls: CLS.emerald },
  revoked: { label: "Revogada", cls: CLS.red },
  expired: { label: "Expirada", cls: CLS.muted },
};

/** Atos que passam por alçada (aprovação de uma administradora). */
export type ApprovalKind =
  | "sell_below_minimum"
  | "commission_change"
  | "commission_waive"
  | "cancel_active"
  | "financial_concession";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

/** Linha de `approval_requests` (fila de aprovação). */
export interface ApprovalRequest {
  id: string;
  tenant_id: string;
  intermediation_id: string | null;
  kind: ApprovalKind;
  title: string | null;
  params: Record<string, unknown>;
  amount: number | null;
  status: ApprovalStatus;
  requested_by: string | null;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  applied_at: string | null;
  created_at: string;
  /** join opcional (`useApprovalRequests`). */
  intermediation?: { code: string; owner_lead_id: string } | null;
  /** nome do lead do proprietário (resolvido no hook). */
  lead_name?: string | null;
}

export const APPROVAL_KIND_LABEL: Record<ApprovalKind, string> = {
  sell_below_minimum: "Venda abaixo do mínimo",
  commission_change: "Alteração de comissão",
  commission_waive: "Renúncia de comissão",
  cancel_active: "Encerrar intermediação ativa",
  financial_concession: "Concessão financeira",
};

export const APPROVAL_STATUS_META: Record<ApprovalStatus, BadgeMeta> = {
  pending: { label: "Pendente", cls: CLS.amber },
  approved: { label: "Aprovado", cls: CLS.emerald },
  rejected: { label: "Recusado", cls: CLS.red },
  cancelled: { label: "Cancelado", cls: CLS.muted },
};

/**
 * Retorno das RPCs de domínio quando o ator não tem alçada: o pedido foi
 * enfileirado (NÃO é erro nem sucesso aplicado). A UI mostra "Enviado para
 * aprovação de uma administradora".
 */
export interface NeedsApproval {
  ok: false;
  needs_approval: true;
  request_id: string;
  kind: ApprovalKind;
}

/** true quando a RPC devolveu `{ ok:false, needs_approval:true, ... }`. */
export function isNeedsApproval(x: unknown): x is NeedsApproval {
  return !!x && typeof x === "object" && (x as { needs_approval?: unknown }).needs_approval === true;
}

/** Escopo de uma procuração em texto pt-BR (['*'] = todos os documentos). */
export function poaScopesLabel(scopes: string[] | null | undefined): string {
  if (!scopes || scopes.length === 0 || scopes.includes("*")) return "Todos os documentos";
  return scopes.map((s) => DOCUMENT_TYPE_LABEL[s as ContractDocumentType] ?? s).join(" · ");
}

/** Termos obrigatórios pra formalizar (preço pretendido + comissão + prazo final). */
export function missingTerms(i: Pick<Intermediation, "asking_price" | "commission_type" | "commission_value" | "ends_at">): string[] {
  const missing: string[] = [];
  if (i.asking_price == null) missing.push("preço");
  if (i.commission_type == null || i.commission_value == null) missing.push("comissão");
  if (!i.ends_at) missing.push("prazo");
  return missing;
}

export const isTermsComplete = (i: Parameters<typeof missingTerms>[0]) => missingTerms(i).length === 0;
