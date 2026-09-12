import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/** Dados normalizados do veículo (promotora não recebe chassi/renavam). */
export interface PlateVehicle {
  marca: string | null;
  modelo: string | null;
  ano_fabricacao: number | null;
  ano_modelo: number | null;
  cor: string | null;
  combustivel: string | null;
  chassi?: string | null;
  renavam?: string | null;
  municipio: string | null;
  uf: string | null;
}

export interface PlateCaptured {
  lead_id: string;
  lead_name: string | null;
  vehicle_status: string | null;
  promoter_name: string | null;
  created_at: string | null;
}

export interface PlateLookupResult {
  ok: true;
  plate: string;
  cached: boolean;
  found: boolean;
  vehicle: PlateVehicle;
  warning?: string;
  already_captured: PlateCaptured | null;
}

/** Erro com status HTTP (412 = provedor não configurado, 429 = limite diário). */
export class PlateLookupError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "PlateLookupError";
  }
}

async function readInvokeError(error: unknown): Promise<{ status: number; message: string }> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    const status = ctx.status;
    try {
      const j = await ctx.clone().json();
      if (j && typeof j.error === "string") return { status, message: j.error };
    } catch { /* corpo não-JSON */ }
    return { status, message: `Erro ${status} ao consultar a placa` };
  }
  return { status: 0, message: error instanceof Error ? error.message : "Não consegui consultar a placa" };
}

/** Consulta o veículo por placa (edge fn vehicle-lookup). `force` ignora o cache. */
export function useVehicleLookup() {
  return useMutation<PlateLookupResult, PlateLookupError, { placa: string; lead_id?: string; force?: boolean }>({
    mutationFn: async ({ placa, lead_id, force }) => {
      const { data, error } = await supabase.functions.invoke("vehicle-lookup", {
        body: { placa, lead_id, force },
      });
      if (error) {
        const { status, message } = await readInvokeError(error);
        throw new PlateLookupError(status, message);
      }
      if (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string") {
        throw new PlateLookupError(400, (data as { error: string }).error);
      }
      return data as PlateLookupResult;
    },
  });
}
