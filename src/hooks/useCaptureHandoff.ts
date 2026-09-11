import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { captureKeys } from "./useCaptureLeads";

/**
 * Fase 4 da captação: configuração do handoff (gestor) e feed de retorno
 * pra promotora (capture_lead_events — RLS: promotora só vê os próprios).
 */

export interface CaptureHandoffConfig {
  tenant_id: string;
  enabled: boolean;
  specialist_member_ids: string[];
  last_assigned_member_id: string | null;
  sla_minutes_quente: number;
  sla_minutes_morno: number;
  escalate_to_member_id: string | null;
  notify_specialist: boolean;
  notify_group: boolean;
  whatsapp_instance_id: string | null;
  whatsapp_group_jid: string | null;
  /** Resumo da captação no grupo — horas (BRT) em que posta */
  summary_enabled: boolean;
  summary_hours: number[];
  /** Template Cloud API do aviso privado do especialista */
  specialist_template_name: string;
  /** Meta diária de leads válidos (null = meta semanal ÷ 5) */
  daily_goal: number | null;
  /** Loja no marketplace Totex — fonte de verdade do "Anunciado" (null = herda marketplace_store_mappings) */
  marketplace_store_id: string | null;
  /** Cron capture-listings (2×/dia) confere o estoque e move o carro pra Anunciado */
  listing_sync_enabled: boolean;
  listing_last_sync_at?: string | null;
  listing_last_sync_result?: string | null;
}

export const DEFAULT_HANDOFF_CONFIG: Omit<CaptureHandoffConfig, "tenant_id"> = {
  summary_enabled: true,
  summary_hours: [13, 19],
  specialist_template_name: "captacao_lead_especialista",
  daily_goal: null,
  marketplace_store_id: null,
  listing_sync_enabled: true,
  enabled: true,
  specialist_member_ids: [],
  last_assigned_member_id: null,
  sla_minutes_quente: 30,
  sla_minutes_morno: 240,
  escalate_to_member_id: null,
  notify_specialist: true,
  notify_group: true,
  whatsapp_instance_id: null,
  whatsapp_group_jid: null,
};

export type CaptureEventType = "handoff" | "contacted" | "stage" | "won" | "lost" | "reassigned" | "sla" | "info";

export interface CaptureLeadEvent {
  id: string;
  lead_id: string;
  event_type: CaptureEventType;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

export function useCaptureHandoffConfig() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ["capture-handoff-config", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_handoff_config")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return (data as CaptureHandoffConfig | null) ?? null;
    },
  });
}

export function useSaveCaptureHandoffConfig() {
  const qc = useQueryClient();
  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (cfg: Partial<CaptureHandoffConfig> & { last_summary_at?: string | null }) => {
      const { error } = await supabase
        .from("capture_handoff_config")
        .upsert({ ...cfg, tenant_id: tenantId }, { onConflict: "tenant_id" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["capture-handoff-config"] }),
  });
}

/** Lojas do marketplace Totex (via edge fn capture-listing-sync, modo dealerships). */
export interface MarketplaceDealership {
  id: string;
  name: string;
  vehicles: number;
}

export function useMarketplaceDealerships(enabled = true) {
  return useQuery({
    queryKey: ["capture", "marketplace-dealerships"],
    enabled,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("capture-listing-sync", { body: { mode: "dealerships" } });
      if (error) throw new Error(error.message || "Não consegui listar as lojas do marketplace");
      return ((data?.dealerships ?? []) as MarketplaceDealership[]);
    },
  });
}

/** Admin: roda o sync do estoque agora (mesmo que o cron 2×/dia faz). */
export interface CaptureListingSyncResult {
  tenant_id: string;
  result?: string;
  error?: string;
  vehicles?: number;
  anunciado?: number;
}

export function useSyncCaptureListings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("capture-listing-sync", { body: { mode: "listings", force: true } });
      if (error) throw new Error(error.message || "Erro ao sincronizar");
      const r = (data?.results ?? []) as CaptureListingSyncResult[];
      return r[0] ?? { tenant_id: "", result: data?.note ?? "nada a sincronizar" };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capture-handoff-config"] });
      qc.invalidateQueries({ queryKey: captureKeys.all });
    },
  });
}

/**
 * Admin: troca o perfil de captação de uma promotora (RPC set_capture_profile).
 * folgista = esporádica; fica fora dos valores em pecúnia/vouchers, salvo regra
 * marcada com include_folgista.
 */
export function useSetCaptureProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, profile }: { memberId: string; profile: "padrao" | "folgista" }) => {
      const { error } = await supabase.rpc("set_capture_profile", { p_member_id: memberId, p_profile: profile });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members-all"] });
      qc.invalidateQueries({ queryKey: ["team-members"] });
      qc.invalidateQueries({ queryKey: captureKeys.all });
    },
  });
}

/** Retornos da promotora logada (mais recentes primeiro). */
export function useCaptureEvents(opts?: { unreadOnly?: boolean; limit?: number }) {
  return useQuery({
    queryKey: ["capture", "events", opts?.unreadOnly ?? false, opts?.limit ?? 30],
    queryFn: async () => {
      let q = supabase
        .from("capture_lead_events")
        .select("id, lead_id, event_type, title, body, created_at, read_at")
        .order("created_at", { ascending: false })
        .limit(opts?.limit ?? 30);
      if (opts?.unreadOnly) q = q.is("read_at", null);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as CaptureLeadEvent[];
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

/** Linha do tempo de um lead específico. */
export function useLeadCaptureEvents(leadId: string | null | undefined) {
  return useQuery({
    queryKey: ["capture", "events", "lead", leadId],
    enabled: !!leadId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_lead_events")
        .select("id, lead_id, event_type, title, body, created_at, read_at")
        .eq("lead_id", leadId!)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CaptureLeadEvent[];
    },
  });
}

export function useMarkCaptureEventsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      const { data, error } = await supabase.rpc("mark_capture_events_read", { p_ids: ids ?? null });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capture", "events"] });
      qc.invalidateQueries({ queryKey: captureKeys.all });
    },
  });
}
