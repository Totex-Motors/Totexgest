import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

// Consulta FIPE pela porta única `fipe-lookup` (cache → fipeX → dataset → FIPE oficial).
// Nunca chamar fipeX/FIPE direto do front. Valores sempre em centavos.

export interface FipeCandidato {
  label: string;
  model_slug: string | null;
  codigo_fipe: string | null;
  fuel_acronym: string | null;
  nome_marca: string | null;
  nome_modelo: string | null;
  ano_modelo: number | null;
  valor_centavos: number | null;
}

export interface FipeResult {
  ok: boolean;
  fonte: "cache" | "fipex" | "dataset" | "fipe_oficial" | null;
  precisa_confirmar_modelo: boolean;
  candidatos: FipeCandidato[];
  veiculo: {
    marca: string | null; modelo: string | null; ano_modelo: number | null;
    combustivel: string | null; codigo_fipe: string | null;
  } | null;
  preco: { valor_centavos: number | null; mes_referencia: string | null } | null;
  analise: {
    depreciacao_anual_pct: number | null;
    retencao_valor_pct: number | null;
    anomalia: string | null;
    ranking: { posicao: number; total: number } | null;
    volatilidade_pct: number | null;
  };
  historico: { ano: number; mes: number; valor_centavos: number }[];
  motivo?: string;
}

export interface FipeLookupInput {
  placa?: string;
  codigo_fipe?: string;
  modelo_slug?: string;
  marca?: string;
  modelo?: string;
  combustivel?: string;
  ano?: number | string;
  lead_id?: string;
  seller_vehicle_id?: string;
  confirmar?: {
    codigo_fipe?: string | null;
    model_slug?: string | null;
    fuel_acronym?: string | null;
    nome_modelo?: string | null;
  };
}

export function useFipeLookup() {
  return useMutation<FipeResult, Error, FipeLookupInput>({
    mutationFn: async (input) => {
      const body: Record<string, unknown> = { ...input };
      if (input.ano != null) body.ano = Number(input.ano);
      const { data, error } = await supabase.functions.invoke("fipe-lookup", { body });
      if (error) {
        const ctx = (error as { context?: unknown })?.context;
        if (ctx instanceof Response) {
          try { const j = await ctx.clone().json(); if (j?.error) throw new Error(j.error); } catch { /* noop */ }
        }
        throw new Error(error.message || "Não consegui consultar a FIPE.");
      }
      if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
        throw new Error((data as { error: string }).error);
      }
      return data as FipeResult;
    },
  });
}

/** Formata centavos em BRL. */
export function formatBRLCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

/** "2026-07" → "jul/2026" */
export function formatFipeRef(ref: string | null | undefined): string {
  if (!ref) return "";
  const [y, m] = ref.split("-");
  const meses = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  const mi = Number(m) - 1;
  return mi >= 0 && mi < 12 ? `${meses[mi]}/${y}` : ref;
}
