// ============================================================================
// REPASSE RELAY — núcleo compartilhado
//
// Pega o texto de um carro postado no grupo de repasse, reescreve no tom da
// TOTEX com a margem embutida (a conta do preço é feita AQUI, não pela IA) e
// posta no grupo da comunidade via UAZAPI.
//
// Regra inviolável respeitada: o alvo é SEMPRE um grupo (@g.us), então passa
// pela política group_only sem bloqueio (uazapiTargetAllowed).
//
// Uso (no webhook, para mensagens recebidas de um grupo):
//   import { maybeRelayRepasse } from "../_shared/repasse.ts";
//   const relayed = await maybeRelayRepasse(supabase, {
//     instanceId, tenantId, groupJid: remoteJid, messageId,
//     text: (payload.content?.text || payload.text || ""), senderName: pushName,
//   });
//   if (relayed) return; // não trata post de repasse como ticket de cliente
// ============================================================================

import { getIntegrationKey } from "./config.ts";
import { uazapiTargetAllowed } from "./wa-policy.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

const ANTHROPIC_VERSION = "2023-06-01";
const MIN_TEXT_LEN = 15; // ignora "boa tarde", figurinha, etc.

const VOICES: Record<string, string> = {
  equilibrado:
    "profissional mas caloroso, com um leve toque de urgência sem exagero. Passa segurança e ao mesmo tempo empolgação de bom negócio.",
  vendedor:
    "animado e empolgado, gera vontade de correr, usa urgência real ('vai rápido'), mais emojis, energia de vendedor de pátio — sem apelar.",
  consultor:
    "direto, confiável e profissional, foco no bom negócio e na credibilidade, poucos emojis, transmite seriedade.",
  descolado:
    "informal e próximo, papo de amigo que entende de carro, leve, sem gírias forçadas.",
};

export interface RelayInput {
  instanceId: string;
  tenantId: string | null;
  groupJid: string;        // grupo de ORIGEM (repasse) de onde veio a mensagem
  messageId: string;
  text: string;
  senderName?: string;
}

interface RelayConfig {
  id: string;
  tenant_id: string | null;
  instance_id: string;
  source_group_jid: string;
  target_group_jid: string;
  margin: number;
  voice: string;
  signature: string;
  model: string;
  min_source_price: number | null;
  max_source_price: number | null;
  post_without_price: boolean;
  active: boolean;
}

interface TransformResult {
  modelo: string | null;
  precoOriginal: number | null;
  post: string;
}

const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

/**
 * Retorna true se a mensagem veio de um grupo de repasse configurado (ou seja,
 * o webhook deve parar aqui e NÃO tratar como ticket). Retorna false se não há
 * config ativa pra esse grupo/instância — o fluxo normal segue.
 */
export async function maybeRelayRepasse(sb: Sb, input: RelayInput): Promise<boolean> {
  const jid = normalizeJid(input.groupJid);
  if (!jid) return false;

  const { data: configs, error } = await sb
    .from("repasse_relay_config")
    .select("*")
    .eq("instance_id", input.instanceId)
    .eq("active", true);
  if (error) {
    console.error("[repasse-relay] erro ao carregar config:", error.message);
    return false;
  }
  const config = (configs as RelayConfig[] | null)?.find(
    (c) => normalizeJid(c.source_group_jid) === jid,
  );
  if (!config) return false; // não é grupo de repasse monitorado

  // Daqui pra frente É repasse: qualquer saída retorna true pra o webhook parar.
  try {
    await relayOne(sb, config, input);
  } catch (e) {
    console.error("[repasse-relay] falha:", (e as Error).message);
    await logPost(sb, config, input, { status: "error", error: (e as Error).message });
  }
  return true;
}

/**
 * Gera o post SEM enviar nem gravar — pra um botão "Testar" na UI. Usa a config
 * ativa da instância + grupo de origem informados.
 */
export async function previewRepasse(
  sb: Sb,
  args: { instanceId: string; sourceGroupJid: string; text: string; tenantId?: string | null },
): Promise<{
  modelo: string | null;
  precoOriginal: number | null;
  margem: number;
  precoFinal: number | null;
  post: string;
  targetGroupJid: string;
}> {
  const jid = normalizeJid(args.sourceGroupJid);
  const { data: configs } = await sb
    .from("repasse_relay_config")
    .select("*")
    .eq("instance_id", args.instanceId)
    .eq("active", true);
  const config = (configs as RelayConfig[] | null)?.find((c) => normalizeJid(c.source_group_jid) === jid);
  if (!config) throw new Error("nenhuma config ativa pra essa instância + grupo de origem");

  const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", config.tenant_id ?? args.tenantId);
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY não configurada");

  const t = await transform(anthropicKey, config, (args.text || "").trim());
  const orig = typeof t.precoOriginal === "number" && t.precoOriginal > 0 ? t.precoOriginal : null;
  const final = orig != null ? orig + Number(config.margin || 0) : null;
  const post = t.post.replace(/\{\{\s*PRECO\s*\}\}/g, final != null ? brl(final) : "(consultar)");
  return {
    modelo: t.modelo,
    precoOriginal: orig,
    margem: Number(config.margin || 0),
    precoFinal: final,
    post,
    targetGroupJid: config.target_group_jid,
  };
}

async function relayOne(sb: Sb, config: RelayConfig, input: RelayInput): Promise<void> {
  const text = (input.text || "").trim();

  // 1) Ruído / mensagens curtas
  if (text.length < MIN_TEXT_LEN) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "texto muito curto" });
    return;
  }

  // 2) Idempotência (não reposta a mesma mensagem)
  const { data: existing } = await sb
    .from("repasse_relay_posts")
    .select("id")
    .eq("config_id", config.id)
    .eq("source_message_id", input.messageId)
    .maybeSingle();
  if (existing) {
    console.log("[repasse-relay] já processado:", input.messageId);
    return;
  }

  // 3) Instância (credenciais + política)
  const { data: instance, error: instErr } = await sb
    .from("whatsapp_instances")
    .select("id, api_url, api_key, provider, group_only, tenant_id")
    .eq("id", config.instance_id)
    .single();
  if (instErr || !instance) throw new Error("instância não encontrada");
  const apiUrl = String(instance.api_url || "").replace(/\/$/, "");
  if (!apiUrl || !instance.api_key) throw new Error("instância sem credenciais UAZAPI");

  // 4) Transforma com o Claude
  const anthropicKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", config.tenant_id ?? input.tenantId);
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY não configurada");
  const t = await transform(anthropicKey, config, text);

  // 5) Preço + filtros (conta feita no código, nunca pela IA)
  const orig = typeof t.precoOriginal === "number" && t.precoOriginal > 0 ? t.precoOriginal : null;

  if (orig == null && !config.post_without_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "sem preço claro", modelo: t.modelo });
    return;
  }
  if (orig != null && config.min_source_price != null && orig < config.min_source_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "abaixo do preço mínimo", modelo: t.modelo, preco_original: orig });
    return;
  }
  if (orig != null && config.max_source_price != null && orig > config.max_source_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "acima do preço máximo", modelo: t.modelo, preco_original: orig });
    return;
  }

  const final = orig != null ? orig + Number(config.margin || 0) : null;
  const post = t.post.replace(/\{\{\s*PRECO\s*\}\}/g, final != null ? brl(final) : "(consultar)");

  // 6) Política inviolável: alvo tem que ser grupo/canal
  const allowed = await uazapiTargetAllowed(
    sb,
    { id: instance.id, provider: instance.provider, group_only: instance.group_only },
    config.target_group_jid,
    "repasse-relay",
    post,
  );
  if (!allowed) throw new Error("política bloqueou o alvo (não é grupo/canal)");

  // 7) Posta no grupo da comunidade
  const res = await fetch(`${apiUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: instance.api_key },
    body: JSON.stringify({ number: config.target_group_jid, text: post }),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`UAZAPI ${res.status}: ${raw.slice(0, 200)}`);
  }

  // 8) Log
  await logPost(sb, config, input, {
    status: "posted",
    modelo: t.modelo,
    preco_original: orig,
    margem: Number(config.margin || 0),
    preco_final: final,
    post_text: post,
  });
  console.log("[repasse-relay] postado:", t.modelo, final != null ? brl(final) : "(consultar)");
}

async function transform(apiKey: string, config: RelayConfig, sourceText: string): Promise<TransformResult> {
  const voice = VOICES[config.voice] || VOICES.equilibrado;
  const system =
    `Você é o social media da ${config.signature}, uma revenda de carros. Recebo anúncios de um grupo de repasse e transformo cada um num post para a comunidade da loja.\n\n` +
    `REGRAS OBRIGATÓRIAS:\n` +
    `- NÃO revele o preço original do repasse, nem cite que veio de repasse ou de outro grupo. O post é uma oportunidade da própria loja.\n` +
    `- Onde o preço final deve aparecer, escreva EXATAMENTE o token {{PRECO}} (o sistema substitui pelo valor certo). Use o token só uma vez, no destaque de preço.\n` +
    `- Tom: ${voice}\n` +
    `- Formatação de WhatsApp: use *asterisco* para negrito. Emojis com moderação.\n` +
    `- Seja fiel aos dados (modelo, ano, km, opcionais, estado). NÃO invente nada que não esteja no texto.\n` +
    `- Curto e escaneável (4 a 7 linhas). Termine com chamada pra ação e a assinatura: ${config.signature}.\n` +
    `- Português do Brasil.\n\n` +
    `Responda SOMENTE com um objeto JSON válido, sem texto fora dele:\n` +
    `{"modelo":"marca modelo ano","precoOriginal":<número do preço pedido, só dígitos em reais, ou null>,"post":"o post com o token {{PRECO}}"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-6",
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: `TEXTO DO REPASSE:\n"""\n${sourceText}\n"""` }],
    }),
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Anthropic ${res.status}: ${raw.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = data?.content?.[0]?.text ?? "";
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed.post !== "string") {
    throw new Error("resposta da IA sem JSON válido");
  }
  return {
    modelo: typeof parsed.modelo === "string" ? parsed.modelo : null,
    precoOriginal: typeof parsed.precoOriginal === "number" ? parsed.precoOriginal : null,
    post: parsed.post,
  };
}

// Extrai o primeiro objeto JSON do texto (tolerante a cercas de código / prosa).
function extractJson(raw: string): any | null {
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeJid(jid: string | null | undefined): string {
  return String(jid || "").trim().toLowerCase();
}

async function logPost(
  sb: Sb,
  config: RelayConfig,
  input: RelayInput,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("repasse_relay_posts").upsert(
      {
        tenant_id: config.tenant_id ?? input.tenantId ?? null,
        config_id: config.id,
        instance_id: config.instance_id,
        source_message_id: input.messageId,
        source_text: (input.text || "").slice(0, 4000),
        target_group_jid: config.target_group_jid,
        ...fields,
      },
      { onConflict: "config_id,source_message_id" },
    );
  } catch (e) {
    console.warn("[repasse-relay] log falhou:", (e as Error).message);
  }
}
