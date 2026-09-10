import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Gamificação da captação: prêmios por meta (ex.: 40 leads na semana →
 * Voucher Outback). Admin gerencia em Configurações; promotora vê o
 * progresso e resgata quando bate a meta (validação no servidor).
 */

export type RewardGoalType = "leads_semana" | "pontos_semana" | "leads_mes";

export const GOAL_TYPE_LABEL: Record<RewardGoalType, { label: string; unit: string; period: string }> = {
  leads_semana: { label: "Leads captados na semana", unit: "leads", period: "na semana" },
  pontos_semana: { label: "Pontos na semana (10/lead + 20/quente)", unit: "pts", period: "na semana" },
  leads_mes: { label: "Leads captados no mês", unit: "leads", period: "no mês" },
};

export interface CaptureReward {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  goal_type: RewardGoalType;
  goal_value: number;
  stock: number | null;
  is_active: boolean;
  position: number;
  created_at: string;
}

export interface CaptureRewardProgress {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  goal_type: RewardGoalType;
  goal_value: number;
  stock: number | null;
  current_value: number;
  period_start: string;
  eligible: boolean;
  claim_id: string | null;
  claim_status: "pending" | "delivered" | "cancelled" | null;
}

export interface CaptureRewardClaim {
  id: string;
  reward_id: string;
  member_id: string;
  period_start: string;
  achieved_value: number | null;
  status: "pending" | "delivered" | "cancelled";
  created_at: string;
  delivered_at: string | null;
  reward: { name: string; image_url: string | null } | null;
  member: { name: string } | null;
}

const KEY = ["capture", "rewards"] as const;

/** Admin: todos os prêmios do tenant (ativos e inativos). */
export function useCaptureRewards() {
  return useQuery({
    queryKey: [...KEY, "all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_rewards")
        .select("*")
        .order("position")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as CaptureReward[];
    },
  });
}

export function useSaveCaptureReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<CaptureReward> & { name: string; goal_type: RewardGoalType; goal_value: number }) => {
      const { id, ...rest } = input;
      const q = id
        ? supabase.from("capture_rewards").update(rest).eq("id", id).select().single()
        : supabase.from("capture_rewards").insert(rest).select().single();
      const { data, error } = await q;
      if (error) throw error;
      return data as CaptureReward;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteCaptureReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("capture_rewards").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Upload da imagem do prêmio pro bucket público `capture-rewards`. */
export function useUploadRewardImage() {
  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (file: File) => {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${tenantId ?? "shared"}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from("capture-rewards").upload(path, file, {
        cacheControl: "31536000",
        upsert: false,
        contentType: file.type || undefined,
      });
      if (error) throw error;
      return supabase.storage.from("capture-rewards").getPublicUrl(path).data.publicUrl;
    },
  });
}

/** Promotora: prêmios ativos com o progresso dela. */
export function useCaptureRewardProgress(memberId?: string | null) {
  return useQuery({
    queryKey: [...KEY, "progress", memberId ?? ""],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("capture_reward_progress", { p_member_id: memberId ?? null });
      if (error) throw error;
      return (data ?? []) as CaptureRewardProgress[];
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useClaimCaptureReward() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rewardId: string) => {
      const { data, error } = await supabase.rpc("claim_capture_reward", { p_reward_id: rewardId });
      if (error) throw error;
      return data as { claim_id: string; status: string; already: boolean; reward?: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Admin: resgates do tenant (pendentes primeiro). */
export function useCaptureRewardClaims() {
  return useQuery({
    queryKey: [...KEY, "claims"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_reward_claims")
        .select("id, reward_id, member_id, period_start, achieved_value, status, created_at, delivered_at, reward:capture_rewards(name, image_url), member:team_members(name)")
        .order("status")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as CaptureRewardClaim[];
    },
  });
}

export function useMarkClaimDelivered() {
  const qc = useQueryClient();
  const { teamMember } = useAuth();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "delivered" | "cancelled" }) => {
      const { error } = await supabase
        .from("capture_reward_claims")
        .update({ status, delivered_at: status === "delivered" ? new Date().toISOString() : null, delivered_by: teamMember?.id ?? null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
