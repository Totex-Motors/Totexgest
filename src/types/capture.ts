/**
 * Tipos da operação de CAPTAÇÃO (promotoras) — proprietário que quer vender/
 * intermediar o carro. Espelham a migration 20260910100000_captacao_promotoras_base.
 */

export type CaptureIntent = "vender" | "trocar" | "entender";
export type CapturePrazo = "agora" | "ate_30_dias" | "ate_90_dias" | "sem_prazo";
export type CaptureAceitaAvaliacao = "sim" | "talvez" | "nao";
export type CaptureTemperatura = "quente" | "morno" | "frio";
export type CaptureChannel = "presencial" | "whatsapp" | "indicacao" | "qr_code" | "online" | "outro";

export const INTENT_LABEL: Record<CaptureIntent, string> = {
  vender: "Vender",
  trocar: "Trocar",
  entender: "Quer entender",
};

export const PRAZO_LABEL: Record<CapturePrazo, string> = {
  agora: "Agora",
  ate_30_dias: "Até 30 dias",
  ate_90_dias: "Até 90 dias",
  sem_prazo: "Sem prazo",
};

export const MOTIVO_OPTIONS: { value: string; label: string }[] = [
  { value: "troca", label: "Vai trocar de carro" },
  { value: "liquidez", label: "Precisa do dinheiro" },
  { value: "mudanca", label: "Mudança / não usa mais" },
  { value: "custo", label: "Custo de manutenção" },
  { value: "oportunidade", label: "Achou uma oportunidade" },
  { value: "outro", label: "Outro" },
];

export const TEMP_META: Record<CaptureTemperatura, { label: string; cls: string; bar: string }> = {
  quente: { label: "Quente", cls: "bg-orange-100 text-orange-700 border-orange-200", bar: "bg-orange-500" },
  morno: { label: "Morno", cls: "bg-amber-100 text-amber-700 border-amber-200", bar: "bg-amber-500" },
  frio: { label: "Frio", cls: "bg-sky-100 text-sky-700 border-sky-200", bar: "bg-sky-500" },
};

/** leads.seller_qualification (jsonb) */
export interface SellerQualification {
  intent?: CaptureIntent;
  prazo_venda?: CapturePrazo;
  motivo?: string;
  is_owner?: boolean;
  aceita_avaliacao?: CaptureAceitaAvaliacao;
  autoriza_contato?: boolean;
  expectativa_valor?: number | string | null;
  observacao?: string;
  temperatura?: CaptureTemperatura;
  score?: number;
  qualificado_em?: string;
  origem?: string;
  versao?: number;
}

/** seller_vehicles */
export interface SellerVehicle {
  id: string;
  lead_id: string;
  description?: string | null;
  brand?: string | null;
  model?: string | null;
  version?: string | null;
  year_model?: number | null;
  km?: number | null;
  is_owner?: boolean | null;
  expected_price?: number | null;
  condition_notes?: string | null;
  created_at: string;
}

/** Linha devolvida por list_my_capture_leads */
export interface CaptureLead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  created_at: string;
  captured_at: string | null;
  lead_intent: string | null;
  sales_score: number | null;
  temperatura: CaptureTemperatura;
  seller_qualification: SellerQualification | null;
  stage_name: string | null;
  stage_position: number | null;
  stage_is_won: boolean;
  stage_is_lost: boolean;
  sales_rep_name: string | null;
  /** Fase 4: estado do handoff pro especialista */
  handoff_status: CaptureHandoffStatus | null;
  handoff_at: string | null;
  first_contact_at: string | null;
  vehicle: SellerVehicle | null;
}

export type CaptureHandoffStatus =
  | "pending" | "notified" | "contacted" | "sla_breached" | "escalated" | "unassigned" | "skipped";

export const HANDOFF_STATUS_LABEL: Record<CaptureHandoffStatus, string> = {
  pending: "Aguardando especialista",
  notified: "Especialista avisado",
  contacted: "Contatado",
  sla_breached: "Atrasado (SLA)",
  escalated: "Escalado pro gestor",
  unassigned: "Sem especialista",
  skipped: "Sem handoff",
};

export interface CaptureHandoffResult {
  assigned: boolean;
  specialist_id?: string;
  specialist_name?: string;
  task_id?: string;
  temperatura?: CaptureTemperatura;
  sla_minutes?: number;
  status?: CaptureHandoffStatus;
  reason?: string;
}

/** Payload do create_capture_lead (Quick Capture) */
export interface CreateCaptureLeadInput {
  name: string;
  phone: string;
  email?: string;
  intent: CaptureIntent;
  vehicle: {
    description: string;
    year_model: number;
    km?: number | null;
    brand?: string;
    model?: string;
  };
  qualification: Omit<SellerQualification, "score" | "temperatura" | "qualificado_em" | "origem" | "versao" | "intent">;
  location_id?: string | null;
  campaign_id?: string | null;
  channel?: CaptureChannel;
  city_name?: string;
  state?: string;
}

export interface CreateCaptureLeadResult {
  lead_id: string;
  duplicate: boolean;
  score: number;
  temperatura: CaptureTemperatura;
  handoff?: CaptureHandoffResult;
}

export interface CaptureHomeStats {
  hoje?: number;
  semana?: number;
  mes?: number;
  quentes_semana?: number;
  qualificados_hoje?: number;
  pendentes_complemento?: number;
  handoff_pendente?: number;
  em_atendimento?: number;
  contatados_semana?: number;
  captados_mes?: number;
  vendidos_mes?: number;
  retornos_nao_lidos?: number;
  /** Reward engine (migration 20260911100000): meta = leads VÁLIDOS da semana */
  validos_semana?: number;
  validos_hoje?: number;
  invalidos_semana?: number;
  /** motivo → quantidade, ex.: {"autorização de contato": 2, "ano do veículo": 1} */
  invalidos_motivos?: Record<string, number>;
  meta_semanal?: number;
  /** meta diária de leads válidos (config do tenant ou meta semanal ÷ 5) */
  meta_diaria?: number;
  meta_label?: string | null;
  wallet?: { pending_cents: number; earned_cents: number; vouchers_pending: number };
}

// ─── Reward engine (dinheiro nasce SÓ no servidor; o front só lê) ───────────

export type CaptureLedgerStatus = "pending" | "approved" | "paid" | "cancelled";
export type CaptureRewardType = "cash" | "voucher" | "badge";

export const LEDGER_STATUS_META: Record<CaptureLedgerStatus, { label: string; cls: string; dot: string }> = {
  pending: { label: "Pendente", cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", dot: "bg-amber-500" },
  approved: { label: "Aprovado", cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", dot: "bg-emerald-500" },
  paid: { label: "Pago", cls: "bg-emerald-600 text-white border-emerald-600", dot: "bg-emerald-600" },
  cancelled: { label: "Cancelado", cls: "bg-muted text-muted-foreground border-border", dot: "bg-muted-foreground" },
};

/** Item do extrato (capture_wallet().items) */
export interface CaptureWalletItem {
  id: string;
  title: string;
  reward_type: CaptureRewardType;
  amount_cents: number;
  voucher_label: string | null;
  image_url: string | null;
  status: CaptureLedgerStatus;
  earned_at: string;
  paid_at: string | null;
  cancel_reason: string | null;
  lead_id: string | null;
}

/** Retorno de capture_wallet() */
export interface CaptureWallet {
  pending_cents: number;
  approved_cents: number;
  paid_cents: number;
  earned_cents: number;
  vouchers_pending: number;
  vouchers_delivered: number;
  items: CaptureWalletItem[];
}

export type CaptureVehicleStatus =
  | "lead" | "avaliacao" | "captado" | "preparacao" | "anunciado" | "negociacao" | "vendido" | "perdido";

/** Etapas visíveis pra promotora na jornada do carro (ordem importa). */
export const VEHICLE_JOURNEY: { status: CaptureVehicleStatus; label: string; hint: string }[] = [
  { status: "avaliacao", label: "Avaliação", hint: "O especialista está avaliando o carro (fotos, estado, preço de mercado)." },
  { status: "captado", label: "Captado", hint: "O carro entrou pro estoque Totex. Seu prêmio de captação é gerado aqui." },
  { status: "anunciado", label: "Anunciado", hint: "Já está nos portais e nas redes. Agora é atrair comprador." },
  { status: "negociacao", label: "Negociação", hint: "Tem comprador interessado e proposta na mesa." },
  { status: "vendido", label: "Vendido", hint: "Fechou! Seu bônus de venda é gerado aqui." },
];

export const VEHICLE_STATUS_META: Record<CaptureVehicleStatus, { label: string; cls: string; step: number }> = {
  lead: { label: "Em contato", cls: "bg-muted text-muted-foreground border-border", step: -1 },
  avaliacao: { label: "Avaliação", cls: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900", step: 0 },
  captado: { label: "Captado", cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", step: 1 },
  preparacao: { label: "Em preparação", cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900", step: 1 },
  anunciado: { label: "Anunciado", cls: "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100", step: 2 },
  negociacao: { label: "Negociação", cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900", step: 3 },
  vendido: { label: "Vendido", cls: "bg-emerald-600 text-white border-emerald-600", step: 4 },
  perdido: { label: "Perdido", cls: "bg-muted text-muted-foreground border-border line-through", step: -1 },
};

/** Linha devolvida por list_my_capture_vehicles */
export interface MyCaptureVehicle {
  vehicle_id: string;
  lead_id: string;
  lead_name: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  year_model: number | null;
  km: number | null;
  status: CaptureVehicleStatus;
  status_changed_at: string | null;
  captured_at: string | null;
  sold_at: string | null;
  stage_name: string | null;
  sales_rep_name: string | null;
  reward_captured_cents: number | null;
  reward_sold_cents: number | null;
  ledger_captured_status: CaptureLedgerStatus | null;
  ledger_sold_status: CaptureLedgerStatus | null;
}

export function vehicleTitle(v: Pick<MyCaptureVehicle, "description" | "brand" | "model" | "year_model">) {
  const base = v.description?.trim() || [v.brand, v.model].filter(Boolean).join(" ") || "Veículo";
  return v.year_model ? `${base} ${v.year_model}` : base;
}

/** capture_campaigns (select direto) */
export interface CaptureCampaign {
  id: string;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  focus_phrase: string | null;
  objection_phrase: string | null;
  objection_answer: string | null;
}

export function formatBRL(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Espelho em TS da regra de score do banco (compute_capture_score) — pra preview ao vivo no form. */
export function computeCaptureScore(
  q: Partial<SellerQualification>,
  v: { description?: string; model?: string; year_model?: number | string | null; km?: number | string | null },
): number {
  let s = 0;
  if (q.prazo_venda === "agora" || q.prazo_venda === "ate_30_dias") s += 30;
  if (q.aceita_avaliacao === "sim") s += 20;
  if (q.autoriza_contato === true) s += 20;
  const hasVehicle = !!(v.description?.trim() || v.model?.trim());
  const hasYear = /^\d{4}$/.test(String(v.year_model ?? ""));
  const hasKm = /^\d+$/.test(String(v.km ?? ""));
  if (hasVehicle && hasYear && hasKm) s += 15;
  if (q.is_owner === true) s += 10;
  const exp = q.expectativa_valor;
  if ((q.observacao?.trim().length ?? 0) >= 10 || (exp != null && /^\d+(\.\d+)?$/.test(String(exp)))) s += 5;
  return Math.min(100, s);
}

export function temperatureFromScore(score: number): CaptureTemperatura {
  if (score >= 70) return "quente";
  if (score >= 45) return "morno";
  return "frio";
}
