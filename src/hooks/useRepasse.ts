import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// REPASSE POR INDICAÇÃO — hooks da promotora.
//
// A promotora entrega um cartão NFC (link /r/<code>). Quem confirma o WhatsApp
// fica atrelado a ela; se comprar um carro pela intermediação, ela ganha R$ 150.
// Meta diária de convites e acompanhamento das indicações vivem aqui.

export type RepasseReferralStatus = "confirmed" | "joined" | "converted" | "invalid";

export interface RepasseStats {
  code: string | null;
  group_link: string | null;
  daily_goal: number;
  hoje: number;
  total_periodo: number;
  entraram: number;
  converteram: number;
  ganho_cents: number;
}

export interface RepasseReferral {
  id: string;
  name: string | null;
  phone: string;
  status: RepasseReferralStatus;
  created_at: string;
  joined_at: string | null;
  converted_at: string | null;
}

export type RepassePeriod = "week" | "month" | "all";

const keys = {
  stats: (p: RepassePeriod) => ["repasse", "stats", p] as const,
  referrals: () => ["repasse", "referrals"] as const,
};

function num(v: unknown, d = 0): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : d;
}

/** Painel da promotora: código/link do cartão, meta diária, indicações e ganho. */
export function useRepasseStats(period: RepassePeriod = "week") {
  return useQuery({
    queryKey: keys.stats(period),
    queryFn: async (): Promise<RepasseStats> => {
      const { data, error } = await supabase.rpc("repasse_my_stats", { p_period: period });
      if (error) throw error;
      const r = (data ?? {}) as Record<string, unknown>;
      return {
        code: (r.code as string) ?? null,
        group_link: (r.group_link as string) ?? null,
        daily_goal: num(r.daily_goal, 5),
        hoje: num(r.hoje),
        total_periodo: num(r.total_periodo),
        entraram: num(r.entraram),
        converteram: num(r.converteram),
        ganho_cents: num(r.ganho_cents),
      };
    },
    staleTime: 30_000,
  });
}

/** Lista as indicações da promotora (RLS já filtra pelas dela). */
export function useMyReferrals() {
  return useQuery({
    queryKey: keys.referrals(),
    queryFn: async (): Promise<RepasseReferral[]> => {
      const { data, error } = await supabase
        .from("repasse_referrals")
        .select("id, name, phone, status, created_at, joined_at, converted_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as RepasseReferral[];
    },
    staleTime: 30_000,
  });
}

/** Gera (ou recupera) o código de repasse da promotora logada. */
export function useEnsureRepasseCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc("repasse_ensure_code");
      if (error) throw error;
      const r = (data ?? {}) as Record<string, unknown>;
      return (r.code as string) ?? null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["repasse"] });
    },
  });
}
