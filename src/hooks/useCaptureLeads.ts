import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type {
  CaptureHomeStats,
  CaptureLead,
  CaptureTemperatura,
  CreateCaptureLeadInput,
  CreateCaptureLeadResult,
  SellerQualification,
} from "@/types/capture";

/**
 * Hooks da operação de captação (promotoras). Tudo passa por RPC SECURITY
 * DEFINER — a promotora não tem INSERT/UPDATE direto em leads (RLS restritiva).
 */

export const captureKeys = {
  all: ["capture"] as const,
  leads: (search?: string, temp?: CaptureTemperatura | null, memberId?: string | null) =>
    ["capture", "leads", search ?? "", temp ?? "", memberId ?? ""] as const,
  stats: (memberId?: string | null) => ["capture", "stats", memberId ?? ""] as const,
};

export function useCaptureLeads(opts?: {
  search?: string;
  temperatura?: CaptureTemperatura | null;
  memberId?: string | null;
}) {
  return useQuery({
    queryKey: captureKeys.leads(opts?.search, opts?.temperatura, opts?.memberId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("list_my_capture_leads", {
        p_search: opts?.search?.trim() || null,
        p_temperatura: opts?.temperatura ?? null,
        p_limit: 200,
        p_member_id: opts?.memberId ?? null,
      });
      if (error) throw error;
      return (data ?? []) as CaptureLead[];
    },
    staleTime: 15_000,
  });
}

export function useCaptureHomeStats(memberId?: string | null) {
  return useQuery({
    queryKey: captureKeys.stats(memberId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("capture_home_stats", {
        p_member_id: memberId ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as CaptureHomeStats;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useCreateCaptureLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCaptureLeadInput) => {
      const { data, error } = await supabase.rpc("create_capture_lead", {
        p_payload: input as unknown as Record<string, unknown>,
      });
      if (error) throw error;
      return data as CreateCaptureLeadResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: captureKeys.all });
      qc.invalidateQueries({ queryKey: ["sales-leads"] });
    },
  });
}

export function useUpdateMyCaptureLead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leadId,
      patch,
    }: {
      leadId: string;
      patch: {
        name?: string;
        email?: string;
        qualification?: Partial<SellerQualification>;
        vehicle?: { description?: string; year_model?: number; km?: number | null; condition_notes?: string };
      };
    }) => {
      const { data, error } = await supabase.rpc("update_my_capture_lead", {
        p_lead_id: leadId,
        p_patch: patch as unknown as Record<string, unknown>,
      });
      if (error) throw error;
      return data as { lead_id: string; score: number; temperatura: CaptureTemperatura };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: captureKeys.all });
    },
  });
}

/** Admin: cria o funil "Captação de Veículos" do tenant (idempotente). */
export function useEnsureCapturePipeline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("ensure_capture_pipeline");
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipelines"] });
      qc.invalidateQueries({ queryKey: ["sales-pipelines"] });
    },
  });
}
