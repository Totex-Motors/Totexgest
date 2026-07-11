import { supabase } from "@/lib/supabase";

/**
 * Chama a edge function `uazapi-proxy` — o único caminho do frontend pra UAZAPI.
 * A api_key da instância NUNCA chega ao browser: a edge valida o acesso (RLS)
 * e usa as credenciais no servidor.
 *
 * Retorna { ok, status, data } com o JSON da UAZAPI repassado.
 * Lança erro só em falha de rede/auth da edge (erros da UAZAPI voltam ok:false).
 */
export interface UazapiProxyResult<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

export async function callUazapi<T = any>(
  action: string,
  instanceId: string | null | undefined,
  params: Record<string, unknown> = {},
): Promise<UazapiProxyResult<T>> {
  const { data, error } = await supabase.functions.invoke("uazapi-proxy", {
    body: { action, instance_id: instanceId || undefined, ...params },
  });
  if (error) {
    // Tenta extrair a mensagem do body da edge (403/400 viram FunctionsHttpError)
    let message = error.message || "Falha ao chamar o WhatsApp";
    try {
      const ctx = await (error as any).context?.json?.();
      if (ctx?.error) message = ctx.error;
    } catch { /* mantém a mensagem padrão */ }
    throw new Error(message);
  }
  if (data && typeof data === "object" && "error" in data && !("ok" in data)) {
    throw new Error((data as any).error);
  }
  return data as UazapiProxyResult<T>;
}
