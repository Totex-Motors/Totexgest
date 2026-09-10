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
  sales_rep_name: string | null;
  vehicle: SellerVehicle | null;
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
