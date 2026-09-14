// ============================================================================
// REPASSE RELAY — núcleo compartilhado
//
// Pega o carro postado no grupo de repasse (texto e/ou foto), reescreve no tom
// da TOTEX com a margem embutida e reposta no grupo da comunidade via UAZAPI.
//
// Contas feitas AQUI (nunca pela IA):
//   preço final       = preço de venda de origem + margem
//   "abaixo da FIPE"   = valor original do desconto − margem
//                        (ou, sem esse número, FIPE − preço final)
//
// A IA só escreve o texto e marca os lugares com {{PRECO}} e {{ABAIXO}}, além de
// trocar o nome da loja de origem pela assinatura e remover telefone, @, autoria
// das fotos, forma de pagamento/faturamento etc.
//
// Regra inviolável respeitada: o alvo é SEMPRE um grupo (@g.us).
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
  messageType?: string;    // ImageMessage / VideoMessage / text ...
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
  precoOriginal: number | null;   // preço de VENDA de origem (não a FIPE)
  fipe: number | null;            // valor FIPE, se citado
  abaixoOriginal: number | null;  // "X abaixo da FIPE" citado (número), se houver
  post: string;                   // texto com tokens {{PRECO}} e {{ABAIXO}}
}

interface Rendered {
  orig: number | null;
  final: number | null;
  abaixoFinal: number | null;
  post: string;
}

const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

function isImage(messageType?: string): boolean {
  return /image/i.test(String(messageType || ""));
}

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
  abaixoFinal: number | null;
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
  const r = render(config, t);
  return {
    modelo: t.modelo,
    precoOriginal: r.orig,
    margem: Number(config.margin || 0),
    precoFinal: r.final,
    abaixoFinal: r.abaixoFinal,
    post: r.post,
    targetGroupJid: config.target_group_jid,
  };
}

async function relayOne(sb: Sb, config: RelayConfig, input: RelayInput): Promise<void> {
  const text = (input.text || "").trim();

  // 1) Ruído / mensagens curtas (imagem sem legenda também cai aqui)
  if (text.length < MIN_TEXT_LEN) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "texto/legenda muito curto" });
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

  // 5) Preço + filtros (conta feita no código)
  if (t.precoOriginal == null && !config.post_without_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "sem preço claro", modelo: t.modelo });
    return;
  }
  if (t.precoOriginal != null && config.min_source_price != null && t.precoOriginal < config.min_source_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "abaixo do preço mínimo", modelo: t.modelo, preco_original: t.precoOriginal });
    return;
  }
  if (t.precoOriginal != null && config.max_source_price != null && t.precoOriginal > config.max_source_price) {
    await logPost(sb, config, input, { status: "skipped", skip_reason: "acima do preço máximo", modelo: t.modelo, preco_original: t.precoOriginal });
    return;
  }

  const r = render(config, t);

  // 6) Política inviolável: alvo tem que ser grupo/canal
  const allowed = await uazapiTargetAllowed(
    sb,
    { id: instance.id, provider: instance.provider, group_only: instance.group_only },
    config.target_group_jid,
    "repasse-relay",
    r.post,
  );
  if (!allowed) throw new Error("política bloqueou o alvo (não é grupo/canal)");

  // 7) Posta no grupo da comunidade — com a FOTO REAL quando a origem for imagem
  let sentWithMedia = false;
  if (isImage(input.messageType)) {
    const link = await getMediaLink(apiUrl, instance.api_key, input.messageId);
    if (link) {
      const res = await fetch(`${apiUrl}/send/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token: instance.api_key },
        body: JSON.stringify({ number: config.target_group_jid, type: "image", file: link, text: r.post }),
      });
      if (res.ok) sentWithMedia = true;
      else console.warn("[repasse-relay] send/media falhou, caindo pra texto:", res.status);
    }
  }
  if (!sentWithMedia) {
    const res = await fetch(`${apiUrl}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token: instance.api_key },
      body: JSON.stringify({ number: config.target_group_jid, text: r.post }),
    });
    if (!res.ok) {
      const raw = await res.text();
      throw new Error(`UAZAPI ${res.status}: ${raw.slice(0, 200)}`);
    }
  }

  // 8) Log
  await logPost(sb, config, input, {
    status: "posted",
    modelo: t.modelo,
    preco_original: r.orig,
    margem: Number(config.margin || 0),
    preco_final: r.final,
    post_text: r.post,
  });
  console.log("[repasse-relay] postado:", t.modelo, r.final != null ? brl(r.final) : "(consultar)", sentWithMedia ? "(com foto)" : "(texto)");
}

// Aplica a margem e recalcula o "abaixo da FIPE"; substitui os tokens.
function render(config: RelayConfig, t: TransformResult): Rendered {
  const margin = Number(config.margin || 0);
  const orig = typeof t.precoOriginal === "number" && t.precoOriginal > 0 ? t.precoOriginal : null;
  const final = orig != null ? orig + margin : null;

  // "abaixo da FIPE": usa o número citado − margem; senão FIPE − preço final.
  let abaixoFinal: number | null = null;
  if (typeof t.abaixoOriginal === "number" && t.abaixoOriginal > 0) {
    abaixoFinal = Math.max(0, t.abaixoOriginal - margin);
  } else if (typeof t.fipe === "number" && t.fipe > 0 && final != null) {
    abaixoFinal = Math.max(0, t.fipe - final);
  }

  let post = t.post
    .replace(/\{\{\s*PRECO\s*\}\}/g, final != null ? brl(final) : "(consultar)")
    .replace(/\{\{\s*ABAIXO\s*\}\}/g, abaixoFinal != null ? brl(abaixoFinal) : "");
  // Limpa sobras se o token de abaixo ficou vazio (ex: "R$  ABAIXO" → some a linha)
  post = post.replace(/^.*\bABAIXO DA (FIPE|TABELA)\b.*$\n?/im, (line) =>
    /R\$\s*\d/.test(line) ? line : "");
  return { orig, final, abaixoFinal, post: post.trim() };
}

async function getMediaLink(apiUrl: string, token: string, messageId: string): Promise<string | null> {
  try {
    const res = await fetch(`${apiUrl}/message/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", token },
      body: JSON.stringify({ id: messageId, return_link: true }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return d.fileURL || d.FileURL || d.url || d.link || d.download_url || null;
  } catch {
    return null;
  }
}

async function transform(apiKey: string, config: RelayConfig, sourceText: string): Promise<TransformResult> {
  const voice = VOICES[config.voice] || VOICES.equilibrado;
  const system =
    `Você é o social media da ${config.signature}, uma revenda de carros. Recebo anúncios de um grupo de repasse e transformo cada um num post para a comunidade da loja.\n\n` +
    `REGRAS OBRIGATÓRIAS:\n` +
    `- O post é uma oportunidade da própria ${config.signature}. NÃO revele o preço original de repasse nem diga que veio de outro grupo.\n` +
    `- Troque QUALQUER nome/marca da loja de origem pela assinatura "${config.signature}" (ex.: "VALOR X MOTORS: ..." vira "VALOR ${config.signature}: {{PRECO}}").\n` +
    `- Onde entra o PREÇO DE VENDA final, escreva EXATAMENTE o token {{PRECO}} (uma vez, no destaque de preço).\n` +
    `- Se o anúncio disser algo como "X abaixo da FIPE/tabela", escreva o token {{ABAIXO}} no lugar desse número (o sistema recalcula, pois a margem reduz o desconto). Mantenha a palavra "ABAIXO DA FIPE"/"ABAIXO DA TABELA".\n` +
    `- REMOVA e NÃO inclua no post: número de telefone/WhatsApp, @arroba ou nome de contato, linha sobre autoria/edição das fotos (ex.: "fotos reais do veículo", "alterado o cenário", "padrão G5"), forma de pagamento (ex.: "paga na concessionária") e faturamento (ex.: "faturamento somente para PJ") — e qualquer linha parecida com essas.\n` +
    `- Mantenha os dados reais do carro (modelo, ano, km, opcionais, FIPE, laudo, localização). NÃO invente nada.\n` +
    `- Tom: ${voice}\n` +
    `- Formatação de WhatsApp: *asterisco* para negrito, emojis com moderação. Curto e escaneável.\n` +
    `- Termine com chamada pra ação e a assinatura: ${config.signature}. Português do Brasil.\n\n` +
    `Responda SOMENTE com um objeto JSON válido, sem texto fora dele:\n` +
    `{"modelo":"marca modelo ano","precoOriginal":<preço de VENDA pedido pela loja de origem, só dígitos em reais, ou null>,"fipe":<valor FIPE em reais ou null>,"abaixoOriginal":<número do "abaixo da fipe/tabela" citado, em reais, ou null>,"post":"o post com os tokens {{PRECO}} e (se houver) {{ABAIXO}}"}`;

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
    fipe: typeof parsed.fipe === "number" ? parsed.fipe : null,
    abaixoOriginal: typeof parsed.abaixoOriginal === "number" ? parsed.abaixoOriginal : null,
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
