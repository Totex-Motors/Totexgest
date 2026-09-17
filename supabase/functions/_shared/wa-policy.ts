// ============================================================================
// REGRA INVIOLÁVEL — API NÃO OFICIAL (UAZAPI) SÓ FALA EM GRUPO/CANAL.
//
// Depois do banimento do número Totexcar (2026-09-10), toda mensagem que sai
// por uma instância não oficial (provider != meta_cloud) precisa ter como alvo
// um grupo (@g.us) ou canal (@newsletter). Conversa 1:1 é EXCLUSIVA da API
// oficial (Cloud API). Tentativas bloqueadas ficam em whatsapp_send_blocks.
//
// Uso (antes de QUALQUER fetch pra /send/*):
//   import { uazapiTargetAllowed } from "../_shared/wa-policy.ts";
//   if (!(await uazapiTargetAllowed(supabase, instance, number, "minha-funcao", text))) return;
//
// `instance` pode ser o id (uuid) ou o objeto da instância ({ id, provider, group_only }).
// FAIL-CLOSED: sem instância conhecida (id null) para envio a NÚMERO, a política
// bloqueia (não permite). Grupo/canal e Cloud API oficial seguem liberados.
// A decisão de número via UAZAPI é SEMPRE da rpc wa_target_allowed.
// ============================================================================

// deno-lint-ignore no-explicit-any
type Sb = any;
type InstanceLike = string | null | undefined | { id?: string | null; provider?: string | null; group_only?: boolean | null };

export function isGroupOrChannelJid(target: string | null | undefined): boolean {
  const t = String(target || "").trim();
  if (!t) return false;
  if (/@g\.us$/i.test(t) || /@newsletter$/i.test(t)) return true;
  if (/^1203\d{11,}$/.test(t)) return true;   // id de grupo sem sufixo
  if (/^\d+-\d+$/.test(t)) return true;         // grupos antigos (criador-timestamp)
  return false;
}

export async function uazapiTargetAllowed(
  sb: Sb,
  instance: InstanceLike,
  target: string | null | undefined,
  source: string,
  preview?: string | null,
): Promise<boolean> {
  // Grupo/canal são sempre permitidos — o banimento é sobre MENSAGEM PRIVADA.
  if (isGroupOrChannelJid(target)) return true;

  // Cloud API oficial (meta_cloud) pode falar com número — não é UAZAPI.
  if (instance && typeof instance === "object" && instance.provider === "meta_cloud") return true;

  // Daqui pra baixo é número (1:1) via instância NÃO oficial → a decisão é SEMPRE
  // da rpc wa_target_allowed (fail-closed). NUNCA decidimos "permitir" localmente
  // com base no flag group_only do objeto: ele pode estar desatualizado e era o
  // furo que deixava passar envio pra número particular. A rpc relê o provider do
  // banco e bloqueia número em instância uazapi.
  const instanceId = typeof instance === "string" ? instance : (instance?.id ?? null);
  if (!instanceId) {
    // Sem instância não dá pra julgar → fail-closed (bloqueia + audita).
    await logBlock(sb, null, target, source, preview);
    return false;
  }

  try {
    const { data, error } = await sb.rpc("wa_target_allowed", {
      p_instance_id: instanceId, p_target: String(target || ""), p_source: source, p_preview: preview ?? null,
    });
    if (error) { console.error("[wa-policy] rpc erro:", error.message); return false; } // em dúvida, bloqueia
    return data === true;
  } catch (e) {
    console.error("[wa-policy] erro:", (e as Error).message);
    return false;
  }
}

async function logBlock(sb: Sb, instanceId: string | null, target: string | null | undefined, source: string, preview?: string | null) {
  console.warn(`[wa-policy] BLOQUEADO envio privado via UAZAPI — ${source} → ${target}`);
  try {
    let tenantId: string | null = null;
    if (instanceId) {
      const { data } = await sb.from("whatsapp_instances").select("tenant_id").eq("id", instanceId).maybeSingle();
      tenantId = data?.tenant_id ?? null;
    }
    await sb.from("whatsapp_send_blocks").insert({
      tenant_id: tenantId, instance_id: instanceId, target: String(target || ""), source,
      preview: preview ? String(preview).slice(0, 120) : null,
    });
  } catch { /* auditoria não pode derrubar o fluxo */ }
}
