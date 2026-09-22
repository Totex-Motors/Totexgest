import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { captureKeys } from "@/hooks/useCaptureLeads";

/**
 * Captação "Comprar" — a promotora, no totem, capta um COMPRADOR interessado num
 * carro do estoque de uma loja da rede. A edge function captar-comprador cria o
 * lead, distribui pro tenant da loja (agente/grupo dela atende) e dá crédito de
 * indicação à promotora (repasse).
 */

export type CaptarCompradorInput = {
  name: string;
  phone: string;
  target_tenant_id: string;
  vehicle_id?: string | null;
  loja?: string | null;
  marketplace_url?: string | null;
  titulo?: string | null;
  preco?: string | null;
};

export type CaptarCompradorResult = {
  ok: boolean;
  lead_id: string;
  distribuido: boolean;
  notified: boolean;
};

export function useCaptarComprador() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CaptarCompradorInput): Promise<CaptarCompradorResult> => {
      const { data, error } = await supabase.functions.invoke("captar-comprador", { body: input });
      if (error) {
        // FunctionsHttpError esconde o corpo — tenta ler a mensagem real da resposta.
        let msg = error.message;
        try {
          const body = await (error as { context?: Response }).context?.json?.();
          if (body?.error) msg = body.error;
        } catch { /* ignore */ }
        throw new Error(msg || "Não consegui enviar o comprador. Tenta de novo.");
      }
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error);
      return data as CaptarCompradorResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: captureKeys.all });
    },
  });
}
