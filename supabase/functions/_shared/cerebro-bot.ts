// ============================================================================
// SEGUNDO CÉREBRO — Bot no WhatsApp (grupo de gestão).
//
// Quando chega uma mensagem no GRUPO do cérebro começando com o gatilho
// ("cérebro …"), monta a foto da operação (mcp_bot_snapshot, service role),
// pede pra IA (Anthropic) responder curtinho e RESPONDE NO GRUPO via UAZAPI.
//
// Segurança: só age no grupo configurado (MCP_BOT_GROUP_JID) — que deve ter só
// gestores. Respeita a regra inviolável (alvo é grupo → permitido). Nunca derruba
// o fluxo do webhook (o chamador envolve em try/catch).
// ============================================================================

import { getIntegrationKey } from "./config.ts";
import { uazapiTargetAllowed } from "./wa-policy.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";

interface BrainArgs {
  instanceId: string;
  tenantId: string | null;
  groupJid: string;
  text: string;
  instanceApiUrl: string | null;
  instanceApiKey: string | null;
  senderName?: string | null;
}

function stripAccentsLower(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

async function sendGroupText(sb: Sb, instanceId: string, apiUrl: string, apiKey: string, groupJid: string, text: string) {
  const allowed = await uazapiTargetAllowed(sb, { id: instanceId, provider: "uazapi", group_only: true }, groupJid, "cerebro-bot", text);
  if (!allowed) return;
  await fetch(`${apiUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: apiKey },
    body: JSON.stringify({ number: groupJid, text }),
  }).catch((e) => console.error("[cerebro-bot] send erro:", (e as Error)?.message));
}

/** Retorna true se tratou a mensagem como pergunta ao cérebro (o webhook então PARA). */
export async function maybeBrainReply(sb: Sb, args: BrainArgs): Promise<boolean> {
  const text = String(args.text || "").trim();
  if (!text || !args.instanceApiUrl || !args.instanceApiKey || !args.tenantId) return false;

  // Config: grupo do bot + gatilho
  const { data: cfg } = await sb.from("config").select("key,value").in("key", ["MCP_BOT_GROUP_JID", "MCP_BOT_TRIGGER"]);
  const map: Record<string, string> = {};
  for (const row of (cfg || [])) map[row.key] = row.value;
  const botJid = (map["MCP_BOT_GROUP_JID"] || "").trim();
  const trigger = stripAccentsLower(map["MCP_BOT_TRIGGER"] || "cerebro");
  if (!botJid) return false;

  // Só o grupo configurado
  if (!args.groupJid || !args.groupJid.includes(botJid.replace("@g.us", ""))) return false;
  // Só se começar com o gatilho
  if (!stripAccentsLower(text).startsWith(trigger)) return false;

  const apiUrl = args.instanceApiUrl, apiKey = args.instanceApiKey, gid = args.groupJid;

  try {
    const { data: snap, error: snapErr } = await sb.rpc("mcp_bot_snapshot", { p_tenant: args.tenantId });
    if (snapErr || !snap) {
      await sendGroupText(sb, args.instanceId, apiUrl, apiKey, gid, "🤖 Não consegui puxar os dados da operação agora. Tenta de novo em instantes.");
      return true;
    }
    const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", args.tenantId);
    if (!anthropicKey) {
      await sendGroupText(sb, args.instanceId, apiUrl, apiKey, gid, "🤖 A IA ainda não está configurada (ANTHROPIC_API_KEY). Configure em Configurações → API Keys.");
      return true;
    }

    const system =
      "Você é o *Segundo Cérebro* da TotexMotors (venda e intermediação de veículos), respondendo NO WHATSAPP para o gestor. " +
      "Seja curto e escaneável: use *asterisco* pra negrito do WhatsApp, no máximo 2-3 emojis, listas curtas. " +
      "Responda à pergunta usando SOMENTE os dados do JSON fornecido. Se o dado não estiver lá, diga que não tem essa informação aqui. " +
      "Sempre traga um *próximo passo* prático no fim. Português do Brasil. Não exponha ids técnicos.";
    const userMsg = `Pergunta do gestor:\n"""${text}"""\n\nDados atuais da operação (JSON):\n${JSON.stringify(snap)}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages: [{ role: "user", content: userMsg }] }),
    });
    if (!res.ok) {
      console.error("[cerebro-bot] anthropic", res.status, (await res.text()).slice(0, 200));
      await sendGroupText(sb, args.instanceId, apiUrl, apiKey, gid, "🤖 Tive um problema pra pensar agora. Tenta de novo daqui a pouco.");
      return true;
    }
    const data = await res.json();
    const answer = String(data?.content?.[0]?.text ?? "").trim() || "🤖 Não consegui montar a resposta agora.";
    await sendGroupText(sb, args.instanceId, apiUrl, apiKey, gid, answer);
    return true;
  } catch (e) {
    console.error("[cerebro-bot] erro:", (e as Error)?.message);
    try { await sendGroupText(sb, args.instanceId, apiUrl, apiKey, gid, "🤖 Deu um erro aqui. Tenta de novo em instantes."); } catch { /* noop */ }
    return true;
  }
}
