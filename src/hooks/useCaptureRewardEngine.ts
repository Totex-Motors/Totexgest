import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import type { CaptureLedgerStatus, CaptureRewardType, CaptureVehicleStatus } from "@/types/capture";

/**
 * Reward engine da captação (migration 20260911100000) — lado do GESTOR.
 *
 * Regras (capture_reward_rules) → CRUD direto (RLS: admin).
 * Ledger (capture_reward_ledger) → só leitura; mudança de status via RPC
 * `capture_ledger_set_status`. Ranking/ROI, fechamento do mês, campanha ativa,
 * jornada do veículo e invalidação de lead também via RPC.
 *
 * Dinheiro nasce SÓ no servidor — nada aqui cria saldo.
 */

export const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const formatCents = (cents: number | null | undefined) => BRL.format((Number(cents) || 0) / 100);

export type CaptureRuleEventType = "lead_validated" | "vehicle_captured" | "vehicle_sold" | "monthly_champion";
export type CaptureRulePeriod = "week" | "month";

export const RULE_EVENT_META: Record<CaptureRuleEventType, { label: string; hint: string }> = {
  lead_validated: {
    label: "Meta de leads válidos",
    hint: "Quando a promotora atinge N leads válidos (nome, telefone, veículo, ano, intenção e consentimento) na semana ou no mês.",
  },
  vehicle_captured: {
    label: "Veículo captado",
    hint: "Quando o carro captado entra pro estoque (status Captado — automático ao ganhar o deal ou manual no lead).",
  },
  vehicle_sold: {
    label: "Veículo vendido",
    hint: "Quando o carro captado é vendido (status Vendido).",
  },
  monthly_champion: {
    label: "Campeã do mês",
    hint: "Ao fechar o mês: melhor conversão (captados ÷ válidos) entre quem atingiu o mínimo de leads válidos.",
  },
};

export const REWARD_TYPE_LABEL: Record<CaptureRewardType, string> = {
  cash: "Dinheiro (R$)",
  voucher: "Voucher / brinde",
  badge: "Selo (sem valor)",
};

export interface CaptureRewardRule {
  id: string;
  tenant_id: string;
  campaign_id: string | null;
  name: string;
  event_type: CaptureRuleEventType;
  threshold: number | null;
  period_type: CaptureRulePeriod | null;
  reward_type: CaptureRewardType;
  amount_cents: number;
  voucher_label: string | null;
  reward_id: string | null;
  cap_per_period: number;
  min_valid_leads: number | null;
  /** Regra também vale pra promotora folgista? (default false — folgista fica fora dos incentivos) */
  include_folgista: boolean;
  active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export type CaptureRewardRuleInput = Omit<CaptureRewardRule, "id" | "tenant_id" | "created_at" | "updated_at" | "position"> & {
  id?: string;
  position?: number;
};

export interface CaptureLedgerEntry {
  id: string;
  promoter_id: string;
  rule_id: string | null;
  lead_id: string | null;
  reward_type: CaptureRewardType;
  amount_cents: number;
  voucher_label: string | null;
  reward_image_url: string | null;
  title: string;
  status: CaptureLedgerStatus;
  period_start: string | null;
  earned_at: string;
  approved_at: string | null;
  approved_by: string | null;
  paid_at: string | null;
  paid_by: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  note: string | null;
  promoter: { name: string } | null;
}

export interface CaptureLedgerFilters {
  status?: CaptureLedgerStatus | "all";
  promoterId?: string | null;
  limit?: number;
}

export interface CaptureRankingRow {
  member_id: string;
  name: string;
  submitted: number;
  valid: number;
  validity_rate: number;
  captured: number;
  sold: number;
  conv_captured: number;
  conv_sold: number;
  incentives_pending_cents: number;
  incentives_approved_cents: number;
  incentives_paid_cents: number;
  cost_per_captured_cents: number;
}

export interface CaptureCloseMonthResult {
  ok: boolean;
  month?: string;
  champion?: string;
  member_id?: string;
  valid?: number;
  captured?: number;
  ledger_id?: string | null;
  already?: boolean;
  reason?: string;
}

export interface CaptureCampaignFull {
  id: string;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  location_id: string | null;
  focus_phrase: string | null;
  objection_phrase: string | null;
  objection_answer: string | null;
  location: { id: string; name: string } | null;
}

export type CaptureCampaignInput = Omit<CaptureCampaignFull, "id" | "location"> & { id?: string };

export interface CaptureLocationLite {
  id: string;
  name: string;
  is_active: boolean;
}

/** Info de captação de um lead (pro card no detalhe do lead). */
export interface CaptureLeadInfo {
  lead_id: string;
  captured_by_member_id: string | null;
  captured_at: string | null;
  capture_valid: boolean;
  capture_validated_at: string | null;
  capture_invalid_reason: string | null;
  promoter: { id: string; name: string } | null;
  vehicle: {
    id: string;
    description: string | null;
    brand: string | null;
    model: string | null;
    year_model: number | null;
    km: number | null;
    status: CaptureVehicleStatus;
    status_changed_at: string | null;
    captured_at: string | null;
    sold_at: string | null;
    sold_price: number | null;
  } | null;
}

export const engineKeys = {
  all: ["capture", "engine"] as const,
  rules: ["capture", "engine", "rules"] as const,
  ledger: (f?: CaptureLedgerFilters) => ["capture", "engine", "ledger", f?.status ?? "all", f?.promoterId ?? "", f?.limit ?? 200] as const,
  ranking: (p: CaptureRulePeriod) => ["capture", "engine", "ranking", p] as const,
  campaign: ["capture", "campaign"] as const,
  locations: ["capture", "locations"] as const,
  leadInfo: (leadId: string) => ["capture", "engine", "lead", leadId] as const,
};

// ─── Regras ─────────────────────────────────────────────────────────────────

export function useCaptureRewardRules() {
  return useQuery({
    queryKey: engineKeys.rules,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_reward_rules")
        .select("*")
        .order("position")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as CaptureRewardRule[];
    },
  });
}

export function useSaveCaptureRewardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CaptureRewardRuleInput) => {
      const { id, ...rest } = input;
      const q = id
        ? supabase.from("capture_reward_rules").update(rest).eq("id", id).select().single()
        : supabase.from("capture_reward_rules").insert(rest).select().single();
      const { data, error } = await q;
      if (error) throw error;
      return data as CaptureRewardRule;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: engineKeys.rules });
      qc.invalidateQueries({ queryKey: ["capture", "stats"] });
    },
  });
}

export function useDeleteCaptureRewardRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("capture_reward_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: engineKeys.rules }),
  });
}

// ─── Ledger (aprovações) ────────────────────────────────────────────────────

/** Admin: lançamentos do tenant. Pendentes primeiro, depois mais recentes. */
export function useCaptureLedger(filters?: CaptureLedgerFilters) {
  return useQuery({
    queryKey: engineKeys.ledger(filters),
    queryFn: async () => {
      let q = supabase
        .from("capture_reward_ledger")
        .select(
          "id, promoter_id, rule_id, lead_id, reward_type, amount_cents, voucher_label, reward_image_url, title, status, period_start, earned_at, approved_at, approved_by, paid_at, paid_by, cancelled_at, cancelled_by, cancel_reason, note, promoter:team_members(name)",
        )
        .order("earned_at", { ascending: false })
        .limit(filters?.limit ?? 200);
      if (filters?.status && filters.status !== "all") q = q.eq("status", filters.status);
      if (filters?.promoterId) q = q.eq("promoter_id", filters.promoterId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as unknown as CaptureLedgerEntry[];
      const rank: Record<CaptureLedgerStatus, number> = { pending: 0, approved: 1, paid: 2, cancelled: 3 };
      return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || b.earned_at.localeCompare(a.earned_at));
    },
    staleTime: 10_000,
  });
}

export function useSetLedgerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, reason }: { id: string; status: "approved" | "paid" | "cancelled"; reason?: string | null }) => {
      const { error } = await supabase.rpc("capture_ledger_set_status", { p_id: id, p_status: status, p_reason: reason ?? null });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: engineKeys.all });
      qc.invalidateQueries({ queryKey: ["capture", "rewards"] });
      qc.invalidateQueries({ queryKey: ["capture", "stats"] });
    },
  });
}

// ─── Ranking / ROI ──────────────────────────────────────────────────────────

export function useCaptureRanking(period: CaptureRulePeriod) {
  return useQuery({
    queryKey: engineKeys.ranking(period),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("capture_ranking", { p_period: period });
      if (error) throw error;
      const num = (v: unknown) => Number(v) || 0;
      return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        member_id: String(r.member_id),
        name: String(r.name ?? ""),
        submitted: num(r.submitted),
        valid: num(r.valid),
        validity_rate: num(r.validity_rate),
        captured: num(r.captured),
        sold: num(r.sold),
        conv_captured: num(r.conv_captured),
        conv_sold: num(r.conv_sold),
        incentives_pending_cents: num(r.incentives_pending_cents),
        incentives_approved_cents: num(r.incentives_approved_cents),
        incentives_paid_cents: num(r.incentives_paid_cents),
        cost_per_captured_cents: num(r.cost_per_captured_cents),
      })) satisfies CaptureRankingRow[];
    },
    staleTime: 30_000,
  });
}

/** Fecha o mês (default = mês anterior) e gera o prêmio "Campeã do mês". Idempotente. */
export function useCloseCaptureMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (month?: string | null) => {
      const { data, error } = await supabase.rpc("capture_close_month", { p_month: month ?? null });
      if (error) throw error;
      return (data ?? { ok: false }) as CaptureCloseMonthResult;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: engineKeys.all }),
  });
}

// ─── Campanha ───────────────────────────────────────────────────────────────

/** Admin: campanha ativa mais recente (com local) pra edição. */
export function useCaptureCampaignForEdit() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: [...engineKeys.campaign, "edit", tenantId ?? ""],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_campaigns")
        .select("id, name, is_active, starts_at, ends_at, location_id, focus_phrase, objection_phrase, objection_answer, location:capture_locations(id, name)")
        .eq("is_active", true)
        .order("starts_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return ((data ?? [])[0] as unknown as CaptureCampaignFull | undefined) ?? null;
    },
  });
}

export function useCaptureLocations() {
  return useQuery({
    queryKey: engineKeys.locations,
    queryFn: async () => {
      const { data, error } = await supabase.from("capture_locations").select("id, name, is_active").order("name");
      if (error) throw error;
      return (data ?? []) as CaptureLocationLite[];
    },
  });
}

export function useSaveCaptureCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CaptureCampaignInput) => {
      const { id, ...rest } = input;
      const q = id
        ? supabase.from("capture_campaigns").update(rest).eq("id", id).select("id").single()
        : supabase.from("capture_campaigns").insert(rest).select("id").single();
      const { data, error } = await q;
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: engineKeys.campaign }),
  });
}

// ─── Lead captado (detalhe do lead) ─────────────────────────────────────────

export function useCaptureLeadInfo(leadId: string | null | undefined) {
  return useQuery({
    queryKey: engineKeys.leadInfo(leadId ?? ""),
    enabled: !!leadId,
    queryFn: async (): Promise<CaptureLeadInfo | null> => {
      const { data: lead, error } = await supabase
        .from("leads")
        .select("id, captured_by_member_id, captured_at, capture_valid, capture_validated_at, capture_invalid_reason")
        .eq("id", leadId!)
        .maybeSingle();
      if (error) throw error;
      if (!lead || !lead.captured_by_member_id) return null;

      const [{ data: promoter }, { data: vehicles }] = await Promise.all([
        supabase.from("team_members").select("id, name").eq("id", lead.captured_by_member_id).maybeSingle(),
        supabase
          .from("seller_vehicles")
          .select("id, description, brand, model, year_model, km, status, status_changed_at, captured_at, sold_at, sold_price")
          .eq("lead_id", leadId!)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);

      return {
        lead_id: lead.id,
        captured_by_member_id: lead.captured_by_member_id,
        captured_at: lead.captured_at ?? null,
        capture_valid: !!lead.capture_valid,
        capture_validated_at: lead.capture_validated_at ?? null,
        capture_invalid_reason: lead.capture_invalid_reason ?? null,
        promoter: (promoter as { id: string; name: string } | null) ?? null,
        vehicle: ((vehicles ?? [])[0] as CaptureLeadInfo["vehicle"] | undefined) ?? null,
      };
    },
  });
}

export function useSetSellerVehicleStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ vehicleId, status, soldPrice, soldDealId, soldNote }: {
      vehicleId: string;
      status: CaptureVehicleStatus;
      soldPrice?: number | null;
      /** Vendido: negócio do COMPRADOR (evidência) — ou soldNote descrevendo a venda */
      soldDealId?: string | null;
      soldNote?: string | null;
    }) => {
      const { error } = await supabase.rpc("set_seller_vehicle_status", {
        p_vehicle_id: vehicleId,
        p_status: status,
        p_sold_price: soldPrice ?? null,
        p_sold_deal_id: soldDealId ?? null,
        p_sold_note: soldNote ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: engineKeys.all });
      qc.invalidateQueries({ queryKey: ["capture"] });
    },
  });
}

export function useInvalidateCaptureLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ leadId, reason }: { leadId: string; reason: string }) => {
      const { error } = await supabase.rpc("capture_invalidate_lead", { p_lead_id: leadId, p_reason: reason });
      if (error) throw error;
    },
    onSuccess: (_d, { leadId }) => {
      qc.invalidateQueries({ queryKey: engineKeys.all });
      qc.invalidateQueries({ queryKey: ["capture"] });
      qc.invalidateQueries({ queryKey: ["sales-lead", leadId] });
    },
  });
}
