import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Janela de Oportunidades (soft) — hooks da tela.
 * Config em community_engagement; janelas em community_windows; demanda em
 * community_demand. Abrir/fechar na hora vai pela edge function community-window-tick.
 */

export interface WindowSlot { dow: number; time: string; duration_min?: number }

export interface CommunityConfig {
  id: string;
  tenant_id: string;
  instance_id: string;
  community_group_jid: string;
  timezone: string;
  windows: WindowSlot[];
  open_template: string;
  close_template: string;
  duration_default: number;
  ack_reaction: string;
  model: string;
  active: boolean;
}

export interface DemandRow {
  id: string;
  member_name: string | null;
  member_phone: string | null;
  raw_text: string | null;
  modelo: string | null;
  ano: string | null;
  faixa_min: number | null;
  faixa_max: number | null;
  observacao: string | null;
  status: "new" | "matched" | "contacted" | "descartado";
  matched_car: { modelo?: string; preco_final?: number } | null;
  created_at: string;
}

export interface WindowRow {
  id: string;
  opened_at: string;
  closes_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  opened_by: string;
  demand_count: number;
}

export function useCommunityConfig() {
  return useQuery({
    queryKey: ["community-config"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("community_engagement").select("*").order("created_at", { ascending: true }).limit(1);
      if (error) throw error;
      return (data?.[0] ?? null) as CommunityConfig | null;
    },
  });
}

export function useSaveCommunityConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: Partial<CommunityConfig> & { instance_id: string; community_group_jid: string }) => {
      const payload = {
        instance_id: cfg.instance_id,
        community_group_jid: cfg.community_group_jid,
        timezone: cfg.timezone ?? "America/Sao_Paulo",
        windows: cfg.windows ?? [],
        open_template: cfg.open_template ?? "",
        close_template: cfg.close_template ?? "",
        duration_default: cfg.duration_default ?? 30,
        ack_reaction: cfg.ack_reaction ?? "👍",
        active: cfg.active ?? true,
      };
      if (cfg.id) {
        const { error } = await supabase.from("community_engagement").update(payload).eq("id", cfg.id);
        if (error) throw error;
        return cfg.id;
      }
      const { data, error } = await supabase.from("community_engagement").insert(payload).select("id").single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["community-config"] }),
  });
}

async function invokeTick(action: "open" | "close", configId: string, durationMin?: number) {
  const { data, error } = await supabase.functions.invoke("community-window-tick", {
    body: { action, config_id: configId, duration_min: durationMin },
  });
  if (error) {
    let message = error.message || "Falha na ação";
    try { const ctx = await (error as any).context?.json?.(); if (ctx?.error) message = ctx.error; } catch { /* noop */ }
    throw new Error(message);
  }
  if (data && typeof data === "object" && "ok" in data && !(data as any).ok) {
    throw new Error((data as any).error || "Não foi possível concluir");
  }
  return data;
}

export function useOpenWindowNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId, durationMin }: { configId: string; durationMin?: number }) => invokeTick("open", configId, durationMin),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["community-windows"] }); },
  });
}

export function useCloseWindowNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configId }: { configId: string }) => invokeTick("close", configId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["community-windows"] }); },
  });
}

export function useCommunityWindows(limit = 10) {
  return useQuery({
    queryKey: ["community-windows", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("community_windows")
        .select("id, opened_at, closes_at, closed_at, status, opened_by, demand_count")
        .order("opened_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as WindowRow[];
    },
    refetchInterval: 30_000,
  });
}

export function useCommunityDemand(limit = 50) {
  return useQuery({
    queryKey: ["community-demand", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("community_demand")
        .select("id, member_name, member_phone, raw_text, modelo, ano, faixa_min, faixa_max, observacao, status, matched_car, created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as DemandRow[];
    },
    refetchInterval: 30_000,
  });
}

export function useUpdateDemandStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: DemandRow["status"] }) => {
      const { error } = await supabase.from("community_demand").update({ status }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["community-demand"] }),
  });
}
