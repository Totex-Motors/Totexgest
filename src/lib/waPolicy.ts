/**
 * REGRA INVIOLÁVEL — API NÃO OFICIAL (UAZAPI) SÓ FALA EM GRUPO/CANAL.
 *
 * Espelho no navegador da política do backend (`_shared/wa-policy.ts` +
 * `wa_target_allowed()` no banco). Conversa 1:1 é exclusiva da API oficial
 * (Cloud API). Use antes de qualquer envio direto pra UAZAPI a partir da UI.
 */
import { supabase } from "@/lib/supabase";

export const WA_POLICY_MESSAGE =
  "Bloqueado: o número não oficial (UAZAPI) só pode enviar em grupos/canais. Use o número oficial (API Cloud) para falar com clientes.";

export function isGroupOrChannelJid(target: string | null | undefined): boolean {
  const t = String(target || "").trim();
  if (!t) return false;
  return /@g\.us$/i.test(t) || /@newsletter$/i.test(t) || /^1203\d{11,}$/.test(t) || /^\d+-\d+$/.test(t);
}

/** Decide localmente quando já se conhece a instância. */
export function instanceCanSendTo(
  instance: { provider?: string | null; group_only?: boolean | null } | null | undefined,
  target: string | null | undefined,
): boolean {
  if (isGroupOrChannelJid(target)) return true;
  if (!instance) return true;
  if (instance.provider === "meta_cloud") return true;
  return instance.group_only === false; // uazapi: só se explicitamente liberada (o trigger do banco não deixa)
}

/** Consulta o banco (registra a tentativa bloqueada pra auditoria). */
export async function assertWaTargetAllowed(instanceId: string | null | undefined, target: string, source: string, preview?: string): Promise<void> {
  if (!instanceId || isGroupOrChannelJid(target)) return;
  const { data, error } = await supabase.rpc("wa_target_allowed", {
    p_instance_id: instanceId, p_target: target, p_source: source, p_preview: preview ?? null,
  });
  if (error || data !== true) throw new Error(WA_POLICY_MESSAGE);
}
