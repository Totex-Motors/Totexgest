// meta-campaign.ts — handler CIRÚRGICO pra eventos Meta ligados a campanhas de comentário.
//
// O branch Meta geral do instagram-webhook foi desabilitado (sujava dados vs uChat).
// Este módulo trata APENAS:
//   1. field=comments  → comentário novo em post COM campanha ativa → insere recipient
//   2. field=messages  → DM de um PSID que é recipient de campanha → marca replied,
//      cria lead, e (se reply_mode=agent) continua a conversa via agent-runner + Send API
//
// Qualquer evento fora desses dois casos é ignorado (return handled:false → skip geral).

import { getIntegrationKey } from "../_shared/config.ts";

const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const GRAPH = "https://graph.facebook.com/v20.0";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Supa = any;

// ==================== MULTI-TENANT (padrão B3) ====================
// Tenant resolvido pela ENTIDADE (a conta instagram_business_accounts tem
// tenant_id) e propagado por PARÂMETRO — nunca variável global module-level.
// Inserts via service role levam tenant_id EXPLÍCITO (o DEFAULT cairia no 0001).

export interface IgAccount {
  id: string;
  tenant_id: string;
  instagram_business_id: string | null;
  facebook_page_id: string | null;
  instagram_username: string | null;
  access_token: string | null;
  page_access_token: string | null;
  ig_login_token: string | null;
  ig_login_id: string | null;
}

export const ACCOUNT_FIELDS =
  "id, tenant_id, instagram_business_id, facebook_page_id, instagram_username, access_token, page_access_token, ig_login_token, ig_login_id";

/**
 * Endpoint de envio de DM da conta. A Meta tem DOIS flavors e a conta pode ter
 * só um deles:
 *  - NOVO ("Instagram API with Instagram Login", graph.instagram.com) →
 *    ig_login_token + ig_login_id. É o recomendado: Standard Access sem App Review.
 *  - ANTIGO (via Página do Facebook, graph.facebook.com) →
 *    page_access_token + facebook_page_id.
 * Retorna null quando a conta não tem NENHUM par completo (não dá pra enviar).
 */
export function resolveSendEndpoint(account: IgAccount): { url: string; token: string } | null {
  if (account.ig_login_token && account.ig_login_id) {
    return {
      url: `https://graph.instagram.com/v20.0/${account.ig_login_id}/messages`,
      token: account.ig_login_token,
    };
  }
  if (account.page_access_token && account.facebook_page_id) {
    return {
      url: `${GRAPH}/${account.facebook_page_id}/messages`,
      token: account.page_access_token,
    };
  }
  return null;
}

/** A conta consegue enviar DM (tem ao menos um par de credenciais completo)? */
export function canSendDm(account: IgAccount): boolean {
  return resolveSendEndpoint(account) !== null;
}

/** Conta IG conectada do TENANT (primeira, se houver mais de uma). */
export async function getConnectedAccount(supabase: Supa, tenantId: string): Promise<IgAccount | null> {
  const { data } = await supabase
    .from("instagram_business_accounts")
    .select(ACCOUNT_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("status", "connected")
    .limit(1);
  return data?.[0] || null;
}

/**
 * Resolve a conta a partir do dado que chega no EVENTO (entry.id do webhook =
 * instagram_business_id ou ig_login_id; alguns payloads trazem page id).
 * Sem match: se só existe 1 conta connected na instalação, usa ela (retro-
 * compatível com single-tenant). Com 2+ contas e sem match → null (não chuta).
 */
export async function resolveAccountFromEvent(supabase: Supa, eventId: string | null): Promise<IgAccount | null> {
  const { data } = await supabase
    .from("instagram_business_accounts")
    .select(ACCOUNT_FIELDS)
    .eq("status", "connected");
  const accounts: IgAccount[] = data || [];
  if (accounts.length === 0) return null;
  if (eventId) {
    const hit = accounts.find((a) =>
      a.instagram_business_id === eventId || a.ig_login_id === eventId || a.facebook_page_id === eventId
    );
    if (hit) return hit;
  }
  return accounts.length === 1 ? accounts[0] : null;
}

/**
 * Base do link de material padrão do tenant (config `ig_default_material_link`,
 * via Configurações → API Keys). Sem config → null e o link NÃO é injetado no
 * contexto do agente (o prompt já manda não inventar link).
 */
export async function getDefaultMaterialBase(supabase: Supa, tenantId: string | null): Promise<string | null> {
  try {
    const v = await getIntegrationKey(supabase, "ig_default_material_link", tenantId);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function matchesFilter(
  c: { keyword_mode: string; keywords: string[] | null; min_words: number | null },
  text: string,
): boolean {
  const t = (text || "").toLowerCase().trim();
  if (c.keyword_mode === "contains") {
    return (c.keywords || []).some((k: string) => t.includes(k.toLowerCase().trim()));
  }
  if (c.keyword_mode === "min_words") {
    return t.split(/\s+/).filter(Boolean).length >= (c.min_words || 1);
  }
  return true;
}

/**
 * Modo teste do agente: config `ig_agent_test_allowlist` = JSON array de usernames.
 * Lista NÃO-VAZIA → agente só conversa com esses usernames (resto vai pro inbox
 * humano, espelhado normal). Lista vazia/ausente → produção normal (todos).
 */
async function agentAllowlistBlocks(supabase: Supa, username: string | null, tenantId: string): Promise<boolean> {
  if (!username) return false;
  try {
    const raw = await getIntegrationKey(supabase, "ig_agent_test_allowlist", tenantId);
    if (!raw) return false;
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list) || list.length === 0) return false;
    const ok = list.some((u: string) =>
      String(u).replace(/^@/, "").toLowerCase() === username.toLowerCase());
    if (!ok) console.log("allowlist ativa — agente pulando:", username);
    return !ok;
  } catch {
    return false; // config quebrada nunca derruba produção
  }
}

/**
 * Contato marcado como "Ignorar" no inbox (instagram_conversations.is_ignored=true).
 * Uso típico: contatos próximos/família. O agente NÃO conversa no DM com eles.
 * (Comentário de campanha segue normal — a regra é "só comentário, não conversa".)
 */
async function isIgnoredContact(supabase: Supa, username: string | null, tenantId: string): Promise<boolean> {
  if (!username) return false;
  try {
    const { data } = await supabase
      .from("instagram_conversations")
      .select("is_ignored")
      .eq("tenant_id", tenantId)
      .eq("participant_username", username)
      .eq("is_ignored", true)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false; // erro nunca deve derrubar o fluxo
  }
}

/**
 * Agente pausado nessa conversa (instagram_conversations.agent_paused=true).
 * Setado quando o humano assume no inbox (manda msg manual) ou pausa no botão.
 * Despausar volta o agente COM o contexto (a sessão persiste).
 */
async function isAgentPaused(supabase: Supa, username: string | null, tenantId: string): Promise<boolean> {
  if (!username) return false;
  try {
    const { data } = await supabase
      .from("instagram_conversations")
      .select("agent_paused")
      .eq("tenant_id", tenantId)
      .eq("participant_username", username)
      .eq("agent_paused", true)
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false;
  }
}

// ==================== DETECÇÃO DE BOT (agente vs agente) ====================
// Mesma filosofia do WhatsApp (detectBotConversation): heurística por SCORE, barata,
// roda antes de responder. score >= 3 → é bot → pausa a conversa (agent_paused).
// Caso real: @lfautomatiza (bot de social selling) ficou 13min em ping-pong com o nosso.

const IG_BOT_PATTERNS: RegExp[] = [
  /como posso (te |lhe )?ajudar/i,
  /libera(r|ndo)?.*trial/i,
  /agend(o|ar|a).*(com )?(o |nosso )?(time|pessoal|especialista)/i,
  /me passa.*(nome e |seu )?e-?mail/i,
  /nome e e-?mail/i,
  /atendimento.*(focado|personalizado|dedicado)/i,
  /nosso (painel|processo|time de especialistas)/i,
  /reservad?o?.*hor[áa]rio/i,
  /seja (muito )?bem[- ]vindo/i,
  /para (facilitar|garantir).*atendimento/i,
  /trial para voc[êe] explorar/i,
];

const IG_QUALIFY_MIRROR: RegExp[] = [
  /onde (voc[êe]s?|vcs?).*(trava|dificuldade|foca)/i,
  /qual.*(objetivo|principal|meta).*(alcan[çc]ar|quer)/i,
  /gerar lead.*(atender|qualificar).*(fechar|venda)/i,
  /como (tem sido|est[áa])\??$/i,
  /me conta.*(dificuldade|desafio|onde)/i,
];

async function detectIgBotConversation(
  supabase: Supa,
  username: string | null,
  tenantId: string,
): Promise<{ isBot: boolean; score: number; reasons: string[] }> {
  const reasons: string[] = [];
  let score = 0;
  if (!username) return { isBot: false, score, reasons };
  try {
    const { data: conv } = await supabase
      .from("instagram_conversations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("participant_username", username)
      .order("last_message_at", { ascending: false })
      .limit(1).maybeSingle();
    if (!conv) return { isBot: false, score, reasons };

    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: msgs } = await supabase
      .from("instagram_messages")
      .select("content, is_from_me, created_at")
      .eq("conversation_id", conv.id)
      .eq("message_type", "text")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(40);
    if (!msgs || msgs.length < 6) return { isBot: false, score, reasons };

    const inbound = msgs.filter((m: { is_from_me: boolean }) => !m.is_from_me);
    const ours = msgs.filter((m: { is_from_me: boolean }) => m.is_from_me);

    // 1. Padrão de texto de bot no que a pessoa manda (+2)
    let botHits = 0;
    for (const m of inbound) if (IG_BOT_PATTERNS.some((p) => p.test(m.content || ""))) botHits++;
    if (botHits >= 2) { score += 2; reasons.push(`${botHits} msgs padrão bot`); }

    // 2. Qualificação-espelho: a pessoa devolve as MESMAS perguntas de qualificação (+2)
    let mirror = 0;
    for (const m of inbound) if (IG_QUALIFY_MIRROR.some((p) => p.test(m.content || ""))) mirror++;
    if (mirror >= 2) { score += 2; reasons.push(`${mirror} perguntas de qualificação de volta`); }

    // 3. Volume sem fechar: agente já mandou muita rajada e não fechou (+2)
    if (ours.length >= 12) { score += 2; reasons.push(`${ours.length} msgs nossas sem fechar`); }

    // 4. Rajada consistente do outro lado (padrão de bot que manda 3+ por turno) (+1)
    if (inbound.length >= 9) { score += 1; reasons.push(`${inbound.length} msgs inbound em rajada`); }

    // VOLUME NÃO É PROVA DE BOT — é prova de conversa boa.
    // Os 7 primeiros pauses foram TODOS falso positivo: bateram score 3 só com
    // (3)+(4), sem nenhum sinal real de robô. Estávamos pausando justamente o
    // lead mais engajado (caso estevamcduarte, dono de negócio de MDF).
    // Agora exige pelo menos UM sinal de verdade: texto de bot OU pergunta espelhada.
    const sinalReal = botHits >= 2 || mirror >= 2;
    if (!sinalReal) return { isBot: false, score, reasons };

    return { isBot: score >= 3, score, reasons };
  } catch {
    return { isBot: false, score: 0, reasons };
  }
}

/** Registra falha de envio com o erro CRU da Meta — console.error se perde, tabela não. */
async function logSendFailure(supabase: Supa, f: {
  tenantId: string;
  source: string;
  username?: string | null;
  commentId?: string | null;
  psid?: string | null;
  error: unknown;
  message?: string | null;
  attempt?: number;
}): Promise<void> {
  try {
    await supabase.from("instagram_send_failures").insert({
      tenant_id: f.tenantId,
      source: f.source,
      username: f.username || null,
      comment_id: f.commentId || null,
      recipient_psid: f.psid || null,
      error_raw: (typeof f.error === "string" ? f.error : JSON.stringify(f.error)).slice(0, 2000),
      message_text: (f.message || "").slice(0, 1000) || null,
      attempt: f.attempt ?? 1,
    });
  } catch { /* observabilidade nunca quebra o fluxo */ }
}

/**
 * Perfil do comentador: cache instagram_profiles → Business Discovery (Graph).
 * Nome + bio deixam o agente abrir com "Opaa Dra. Rosa!" e citar o negócio da
 * pessoa (regra "interessante antes de interessado"). Alimenta o cache pro
 * get_ig_context do agente achar nas próximas interações. Conta pessoal → null.
 */
async function fetchCommenterProfile(
  supabase: Supa,
  username: string,
  tenantId: string,
  accountIn?: IgAccount | null,
): Promise<{ name: string | null; bio: string | null }> {
  const sanitize = (n: string) => {
    const s = (n || "").split(/[|–]/)[0].replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
    return s && !/[\d@]/.test(s.replace(/\./g, "")) && s.length >= 2 && s.length <= 60 ? s : null;
  };
  try {
    const { data: cached } = await supabase.from("instagram_profiles")
      .select("full_name, biography")
      .eq("tenant_id", tenantId)
      .eq("username", username).maybeSingle();
    if (cached?.full_name || cached?.biography) {
      return { name: sanitize(cached.full_name || ""), bio: (cached.biography || "").slice(0, 300) || null };
    }
    const acct = accountIn || await getConnectedAccount(supabase, tenantId);
    if (!acct?.access_token || !acct?.instagram_business_id) return { name: null, bio: null };
    const r = await fetch(
      `${GRAPH}/${acct.instagram_business_id}?fields=business_discovery.username(${encodeURIComponent(username)})%7Bname,biography,followers_count%7D&access_token=${acct.access_token}`,
    );
    if (!r.ok) return { name: null, bio: null };
    const bd = (await r.json())?.business_discovery;
    if (!bd) return { name: null, bio: null };
    // UNIQUE real da tabela é (tenant_id, username) — ver baseline
    await supabase.from("instagram_profiles").upsert({
      tenant_id: tenantId,
      username,
      full_name: bd.name || null,
      biography: bd.biography || null,
      follower_count: bd.followers_count ?? null,
      last_scraped_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,username" });
    return { name: sanitize(bd.name || ""), bio: (bd.biography || "").slice(0, 300) || null };
  } catch {
    return { name: null, bio: null };
  }
}

/** SSE consumer do agent-runner (padrão whatsapp-webhook/agent-platform.ts) */
async function runAgent(args: {
  agentSlug: string;
  sessionId: string | null;
  message: string;
  userId: string;
  context: Record<string, unknown>;
}): Promise<{ text: string; sessionId: string | null }> {
  const res = await fetch(`${SUPA_URL}/functions/v1/agent-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    signal: AbortSignal.timeout(60_000), // agente pendurado não pode segurar o worker
    body: JSON.stringify({
      agent_slug: args.agentSlug,
      channel: "instagram_comment",
      session_id: args.sessionId,
      message: args.message,
      user_id: null, // agents_sessions.user_id é uuid — username vai no context
      context: args.context,
    }),
  });
  if (res.status === 204) return { text: "", sessionId: args.sessionId }; // follower do debounce — leader responde por todos
  if (!res.ok || !res.body) throw new Error(`agent-runner ${res.status}`);
  let fullText = "";
  let sessionId: string | null = args.sessionId;
  let streamError: string | null = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const evs = buf.split("\n\n");
    buf = evs.pop() || "";
    for (const ev of evs) {
      const dl = ev.split("\n").find((l) => l.startsWith("data:"));
      if (!dl) continue;
      try {
        const d = JSON.parse(dl.slice(5).trim());
        if (d.type === "text.delta") fullText += d.delta;
        if (d.type === "session.info" && d.session_id) sessionId = d.session_id;
        if (d.type === "error") streamError = d.message || d.error || "stream error";
      } catch { /* ignore */ }
    }
  }
  // Erro no meio do stream = texto parcial NÃO confiável → falha explícita
  if (streamError) throw new Error(`agent stream error: ${streamError}`);
  return { text: fullText.trim(), sessionId };
}

/**
 * Sessão ÚNICA do agente por PESSOA (não por campanha). Fonte da verdade:
 * instagram_conversations.agent_session_id. Reusar → o agente tem o histórico
 * inteiro → responde com contexto e NUNCA reabre frio numa 2ª campanha.
 */
export async function getPersonSession(supabase: Supa, username: string | null, tenantId: string): Promise<string | null> {
  if (!username) return null;
  const { data } = await supabase
    .from("instagram_conversations")
    .select("agent_session_id")
    .eq("tenant_id", tenantId)
    .eq("participant_username", username)
    .not("agent_session_id", "is", null)
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.agent_session_id || null;
}

/**
 * Monta o link do material padrão (LP) com UTM da campanha de origem, pro agente
 * convidar. utm_campaign = a palavra-chave do conteúdo que a pessoa interagiu OU
 * 'dm_direto' se veio sem campanha. O código monta (não o agente) → UTM nunca quebra.
 *
 * `base` vem de getDefaultMaterialBase(supabase, tenantId) (config
 * `ig_default_material_link`). Sem base configurada → retorna null e o caller
 * NÃO injeta o link no contexto do agente.
 */
export function buildAulaLink(
  base: string | null,
  campaign?: { keywords?: string[] | null; name?: string | null } | null,
  username?: string | null,
): string | null {
  if (!base) return null;
  let slug = "dm_direto";
  const kw = campaign?.keywords?.[0];
  if (kw && String(kw).trim()) {
    slug = String(kw).toLowerCase().replace(/[^a-z0-9]/g, "");
  } else if (campaign?.name) {
    slug = String(campaign.name).toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  }
  const sep = base.includes("?") ? "&" : "?";
  let url = `${base}${sep}utm_source=instagram&utm_medium=dm&utm_campaign=${slug || "dm_direto"}`;
  // @ do IG (sem o @) → a LP pré-preenche o Instagram sem a pessoa digitar
  const ig = (username || "").replace(/^@/, "").trim();
  if (ig) url += `&ig=${encodeURIComponent(ig)}`;
  return url;
}

/**
 * Gatilho de palavra-chave no DM/Story: quando a pessoa manda a palavra (ex: respondeu
 * um story do evento), o agente entra mesmo sem ela ter comentado em post. Retorna o
 * trigger ativo cuja keyword aparece no texto (senão null).
 */
export async function matchDmKeywordTrigger(supabase: Supa, text: string | null, tenantId: string): Promise<any | null> {
  if (!text) return null;
  // Normaliza: minúsculo, sem pontuação/emoji, trim. Dispara quando a mensagem É a
  // palavra (ou uma frase curta que a contém — resposta típica de story "quero call").
  // NÃO dispara quando a palavra aparece perdida numa frase longa (evita falso positivo,
  // ex: "vamos marcar uma call sobre o projeto" NÃO é pedido do evento).
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  try {
    const { data } = await supabase.from("ig_dm_keyword_triggers").select("*")
      .eq("tenant_id", tenantId).eq("active", true);
    if (!data) return null;
    return data.find((tr: { keyword: string }) => {
      const kw = String(tr.keyword || "").toLowerCase().trim();
      if (!kw) return false;
      return norm === kw || (norm.length <= kw.length + 14 && norm.includes(kw));
    }) || null;
  } catch {
    return null;
  }
}

/** Monta o link do trigger com UTM (source/medium/campaign) + @ pra pré-preencher a LP. */
function buildTriggerLink(trigger: { material_link: string; utm_medium?: string; utm_campaign?: string }, username?: string | null): string {
  let url = trigger.material_link;
  const sep = url.includes("?") ? "&" : "?";
  url += `${sep}utm_source=instagram&utm_medium=${encodeURIComponent(trigger.utm_medium || "story")}&utm_campaign=${encodeURIComponent(trigger.utm_campaign || "evento")}`;
  const ig = (username || "").replace(/^@/, "").trim();
  if (ig) url += `&ig=${encodeURIComponent(ig)}`;
  return url;
}

/** Fixa a sessão da pessoa na(s) conversa(s) dela (unifica linhas sem sessão). */
export async function savePersonSession(supabase: Supa, username: string | null, sessionId: string | null, tenantId: string): Promise<void> {
  if (!username || !sessionId) return;
  await supabase
    .from("instagram_conversations")
    .update({ agent_session_id: sessionId })
    .eq("tenant_id", tenantId)
    .eq("participant_username", username)
    .is("agent_session_id", null);
}

/**
 * Limpa a missão pendente (metadata.pending_mission/mission_at) das conversas da
 * pessoa — substitui a antiga RPC `limpar_missao_ig` (que não existe no schema
 * do template): update direto do jsonb, escopado por tenant.
 */
async function clearPendingMission(supabase: Supa, username: string, tenantId: string): Promise<void> {
  try {
    const { data: convs } = await supabase
      .from("instagram_conversations")
      .select("id, metadata")
      .eq("tenant_id", tenantId)
      .ilike("participant_username", username);
    for (const c of convs || []) {
      const meta = { ...((c.metadata as Record<string, unknown>) || {}) };
      if (!("pending_mission" in meta) && !("mission_at" in meta)) continue;
      delete meta.pending_mission;
      delete meta.mission_at;
      await supabase.from("instagram_conversations").update({ metadata: meta }).eq("id", c.id);
    }
  } catch { /* limpeza nunca quebra o fluxo */ }
}

/**
 * Gancho pro fluxo uChat: DM recebida de um username que é recipient de campanha.
 * (O webhook `messages` da Meta exige pages_messaging que o token não tem —
 *  então a RECEPÇÃO é via uChat e o ENVIO da resposta é via Send API com o PSID salvo.)
 * Chamar após processMessage no branch uChat. Fire-and-forget: nunca quebra o fluxo.
 */
// Debounce da fila do agente IG (mesmo padrão do ai-sales-agent: trigger→fila→cron).
const IG_DEBOUNCE_SECONDS = 15;

/**
 * ENQUEUE: DM recebida de quem o agente atende → enfileira pra responder quando
 * a pessoa ficar QUIETA por IG_DEBOUNCE_SECONDS. Cada msg cancela a pending anterior
 * e reagenda (trailing debounce). O cron (processIgAgentQueue) processa consolidado.
 * Rápido e sem sleep — o webhook devolve 200 na hora.
 */
export async function handleCampaignReplyByUsername(
  supabase: Supa,
  senderUsername: string | null,
  textIn: string,
  tenantId: string,
): Promise<void> {
  const text = textIn;
  if (!senderUsername || !text) return;
  if (await agentAllowlistBlocks(supabase, senderUsername, tenantId)) return;
  if (await isIgnoredContact(supabase, senderUsername, tenantId)) return; // contato interno/família — agente não conversa no DM
  if (await isAgentPaused(supabase, senderUsername, tenantId)) return; // humano assumiu / pausou no inbox

  // Escopo: só enfileira quem o agente atende (recipient de campanha OU tem sessão
  // universal). Rando que manda DM fria não entra — humano cuida.
  const { data: rec } = await supabase
    .from("instagram_comment_campaign_recipients")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("commenter_username", senderUsername)
    .eq("dm_status", "sent")
    .gte("dm_sent_at", new Date(Date.now() - SEVEN_DAYS_MS).toISOString())
    .limit(1).maybeSingle();
  if (!rec) {
    const { data: convU } = await supabase
      .from("instagram_conversations")
      .select("agent_session_id")
      .eq("tenant_id", tenantId)
      .eq("participant_username", senderUsername)
      .not("agent_session_id", "is", null)
      .limit(1).maybeSingle();
    if (!convU?.agent_session_id) {
      // Sem sessão: só entra se bater um gatilho de palavra-chave (ex: story do evento)
      const trig = await matchDmKeywordTrigger(supabase, text, tenantId);
      if (!trig) return; // agente nunca falou e sem gatilho → humano cuida
    }
  }

  // Cancela pending anterior + insere novo (trailing debounce). Só a última
  // msg "sobrevive" até a janela quieta fechar → cron processa tudo junto.
  await supabase.from("ig_agent_message_queue")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .eq("username", senderUsername).eq("status", "pending");
  await supabase.from("ig_agent_message_queue").insert({
    tenant_id: tenantId,
    username: senderUsername,
    content: text,
    scheduled_for: new Date(Date.now() + IG_DEBOUNCE_SECONDS * 1000).toISOString(),
    status: "pending",
  });
}

/**
 * CRON: processa a fila do agente IG. Pega itens due (janela quieta fechou),
 * agrupa por username, consolida as msgs pendentes e responde 1x. O status
 * 'processing' É o lock (item sendo processado não é repego; recovery >3min).
 */
export async function processIgAgentQueue(supabase: Supa): Promise<{ processed: number }> {
  // Recovery: itens travados em processing há >3min voltam pra pending
  await supabase.from("ig_agent_message_queue")
    .update({ status: "pending" })
    .eq("status", "processing")
    .lt("created_at", new Date(Date.now() - 3 * 60 * 1000).toISOString());

  // Pares (tenant, username) com item due — claim agrupa por tenant+username
  const { data: due } = await supabase
    .from("ig_agent_message_queue")
    .select("username, tenant_id")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .limit(50);
  const pairs = new Map<string, { username: string; tenantId: string }>();
  for (const d of (due || []) as { username: string; tenant_id: string }[]) {
    pairs.set(`${d.tenant_id}:${d.username}`, { username: d.username, tenantId: d.tenant_id });
  }

  let processed = 0;
  for (const { username, tenantId } of pairs.values()) {
    // Trava: pega TODOS os pending due dessa pessoa (nesse tenant) e marca processing.
    const { data: claimed } = await supabase
      .from("ig_agent_message_queue")
      .update({ status: "processing" })
      .eq("tenant_id", tenantId)
      .eq("username", username).eq("status", "pending")
      .lte("scheduled_for", new Date().toISOString())
      .select("id, content");
    if (!claimed || claimed.length === 0) continue;

    const text = claimed.map((c: { content: string }) => c.content).filter(Boolean).join("\n");
    const ids = claimed.map((c: { id: string }) => c.id);
    try {
      await runIgAgentReply(supabase, username, text, tenantId);
      await supabase.from("ig_agent_message_queue")
        .update({ status: "done", processed_at: new Date().toISOString() }).in("id", ids);
      processed++;
    } catch (e) {
      console.error("processIgAgentQueue error:", username, (e as Error).message);
      await supabase.from("ig_agent_message_queue")
        .update({ status: "failed", error_message: (e as Error).message.slice(0, 500) }).in("id", ids);
    }
  }
  return { processed };
}

/** Responde de fato (consolidado): recipient de campanha OU sessão universal. */
async function runIgAgentReply(supabase: Supa, senderUsername: string, text: string, tenantId: string): Promise<void> {
  {
    if (await isIgnoredContact(supabase, senderUsername, tenantId)) return; // contato interno/família — não conversa
    if (await isAgentPaused(supabase, senderUsername, tenantId)) return; // humano assumiu / pausou no inbox

    // CIRCUIT BREAKER: agente vs agente (bot). Detecta ping-pong de robô e PARA —
    // pausa a conversa (agent_paused) + registra pro admin ver no inbox.
    const bot = await detectIgBotConversation(supabase, senderUsername, tenantId);
    if (bot.isBot) {
      await supabase.from("instagram_conversations")
        .update({ agent_paused: true })
        .eq("tenant_id", tenantId)
        .eq("participant_username", senderUsername);
      await logSendFailure(supabase, {
        tenantId,
        source: "bot_detected",
        username: senderUsername,
        error: `possível BOT (score ${bot.score}): ${bot.reasons.join(", ")} — agente pausado`,
      });
      console.warn(`🤖 IG BOT detectado ${senderUsername} (score ${bot.score}): ${bot.reasons.join(", ")}`);
      return;
    }

    // Sessão ÚNICA da pessoa (fonte da verdade) — reusada em qualquer campanha/DM
    // pra o agente responder SEMPRE com o histórico completo (contexto).
    const personSession = await getPersonSession(supabase, senderUsername, tenantId);

    // Base do link de material padrão do tenant (null → link não é injetado)
    const materialBase = await getDefaultMaterialBase(supabase, tenantId);

    // MISSÃO PENDENTE — o dono da conta abordou essa pessoa pela fila de outbound e ela
    // está respondendo agora. A missão diz o que fazer (entregar o link do evento,
    // confirmar presença). Sem isso o agente responderia no vácuo, sem saber que
    // existe um convite em aberto.
    let pendingMission: string | null = null;
    try {
      const { data: cvM } = await supabase
        .from("instagram_conversations")
        .select("id, metadata")
        .eq("tenant_id", tenantId)
        .ilike("participant_username", senderUsername)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1);
      const meta = cvM?.[0]?.metadata as Record<string, unknown> | undefined;
      const m = meta?.pending_mission;
      if (typeof m === "string" && m.length > 10) {
        const at = Date.parse(String(meta?.mission_at || ""));
        // vale por 7 dias; depois disso o convite já perdeu o timing
        if (!at || Date.now() - at < 7 * 86400_000) pendingMission = m;
      }
    } catch { /* segue sem missão */ }

    // GATILHO DE PALAVRA-CHAVE (evento/story) — PRIORIDADE. Se a pessoa mandou a palavra
    // (ex: "Call" respondendo o story), entrega o link do evento — TENHA sessão ou não.
    // (Sem isso, quem já tem conversa fazia o agente interpretar "call" como reunião.)
    const trig = await matchDmKeywordTrigger(supabase, text, tenantId);
    if (trig) {
      const link = buildTriggerLink(trig, senderUsername);
      const runT = await runAgent({
        agentSlug: trig.agent_slug || "ig-primeiro-contato",
        sessionId: personSession, // usa a sessão existente (contexto) se houver
        message: text,
        userId: senderUsername,
        context: {
          interaction: "dm_reply",
          commenter_username: senderUsername,
          campaign_material: `Material do evento: ${trig.label} — ${trig.material_link}`,
          link_aula: link,
          contexto_especial: `A pessoa mandou a palavra "${trig.keyword}" — ela quer o LINK DO EVENTO (respondeu o story/CTA). Manda o link ${link} e convida pra o evento no teu tom. NÃO trate como pedido de reunião/call comercial nem peça pra comentar em post.`,
          recipient: senderUsername,
        },
      });
      if (runT.text && runT.text.length >= 2 && !runT.text.toUpperCase().startsWith("[SKIP")) {
        await sendDmToUsername(supabase, senderUsername, runT.text, tenantId);
        if (runT.sessionId) await savePersonSession(supabase, senderUsername, runT.sessionId, tenantId);
      }
      return;
    }

    const { data: rec } = await supabase
      .from("instagram_comment_campaign_recipients")
      .select("*, campaign:instagram_comment_campaigns(*)")
      .eq("tenant_id", tenantId)
      .eq("commenter_username", senderUsername)
      .eq("dm_status", "sent")
      .gte("dm_sent_at", new Date(Date.now() - SEVEN_DAYS_MS).toISOString())
      .order("dm_sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Sessão universal: conversa que o AGENTE iniciou (triagem sem campanha) também continua
    if (!rec) {
      const { data: convU } = await supabase
        .from("instagram_conversations")
        .select("id, agent_session_id")
        .eq("tenant_id", tenantId)
        .eq("participant_username", senderUsername)
        .not("agent_session_id", "is", null)
        .order("last_message_at", { ascending: false })
        .limit(1);
      const conv = convU?.[0];
      if (!conv?.agent_session_id) return; // agente nunca falou com essa pessoa → humano cuida

      const linkAula = buildAulaLink(materialBase, null, senderUsername); // sem campanha → dm_direto + @ pré-preenche a LP
      const run = await runAgent({
        agentSlug: "ig-primeiro-contato",
        sessionId: personSession || conv.agent_session_id,
        message: text,
        userId: senderUsername,
        context: {
          interaction: "dm_reply",
          commenter_username: senderUsername,
          ...(linkAula ? { link_aula: linkAula } : {}), // sem config → não injeta (prompt manda não inventar link)
          recipient: senderUsername, // jobs assíncronos entregam o resume pra cá
          ...(pendingMission ? { contexto_especial: pendingMission } : {}),
        },
      });
      if (run.sessionId) await savePersonSession(supabase, senderUsername, run.sessionId, tenantId);
      if (run.text && run.text.length >= 2 && !run.text.toUpperCase().startsWith("[SKIP")) {
        await sendDmToUsername(supabase, senderUsername, run.text, tenantId);
        // missão cumprida: se o agente entregou o link, não fica reoferecendo
        if (pendingMission && materialBase && run.text.includes(materialBase)) {
          await clearPendingMission(supabase, senderUsername, tenantId);
        }
      }
      return;
    }

    // Marca replied + vincula/cria lead
    let leadId = rec.lead_id;
    if (!leadId) {
      const { data: existing } = await supabase
        .from("leads").select("id")
        .eq("tenant_id", tenantId)
        .eq("instagram", senderUsername).maybeSingle();
      if (existing) {
        leadId = existing.id;
      } else {
        const { data: newLead } = await supabase.from("leads").insert({
          tenant_id: tenantId,
          name: senderUsername,
          phone: "",
          instagram: senderUsername,
          sales_stage: "new",
          utm_source: "instagram_comment_campaign",
        }).select("id").single();
        leadId = newLead?.id || null;
      }
    }
    // Pessoa respondeu → marca TODOS os recipients dela (todas as campanhas) como
    // replied. Assim nada fica "pendente" (nudge para) e a conversa é uma só.
    await supabase.from("instagram_comment_campaign_recipients")
      .update({ replied_at: new Date().toISOString(), lead_id: leadId })
      .eq("tenant_id", tenantId)
      .eq("commenter_username", senderUsername)
      .eq("dm_status", "sent")
      .is("replied_at", null);

    // Materiais ainda não entregues (outras campanhas que a pessoa comentou) —
    // vão pro contexto pra o agente não esquecer nenhum.
    const { data: pendRecs } = await supabase
      .from("instagram_comment_campaign_recipients")
      .select("campaign:instagram_comment_campaigns(name, dm_template)")
      .eq("tenant_id", tenantId)
      .eq("commenter_username", senderUsername)
      .eq("dm_status", "sent")
      .gte("dm_sent_at", new Date(Date.now() - SEVEN_DAYS_MS).toISOString());
    const pendingMaterials = (pendRecs || [])
      .map((r: any) => r.campaign?.dm_template).filter(Boolean);

    // Continua conversa com o agente (modo agent; sem PSID cai no envio por username)
    const c = rec.campaign;
    if (c?.reply_mode === "agent" && c?.agent_slug) {
      const linkAulaCamp = buildAulaLink(materialBase, c, senderUsername); // convite: UTM da campanha + @ pré-preenche a LP
      const run = await runAgent({
        agentSlug: c.agent_slug,
        sessionId: personSession || rec.agent_session_id, // sessão única → contexto
        message: text,
        userId: senderUsername,
        context: {
          interaction: "dm_reply",
          source: "instagram_comment_campaign_reply",
          campaign_id: c.id,
          campaign_name: c.name,
          lead_id: leadId,
          commenter_username: senderUsername,
          comment_text: rec.comment_text,
          campaign_material: c.dm_template, // material prometido — ENTREGAR na 1ª resposta
          pending_materials: pendingMaterials, // todos os materiais prometidos ainda não entregues
          ...(linkAulaCamp ? { link_aula: linkAulaCamp } : {}), // sem config → não injeta
          already_in_conversation: !!personSession, // já em papo → não reabrir frio
          recipient: senderUsername, // jobs assíncronos entregam o resume pra cá
        },
      });
      if (run.sessionId) await savePersonSession(supabase, senderUsername, run.sessionId, tenantId);
      if (run.text && run.text.length >= 2 && !run.text.toUpperCase().startsWith("[SKIP")) {
        // Sem PSID salvo (private reply antiga) → resolve pela conversa e envia por lá
        if (!rec.recipient_psid) {
          await sendDmToUsername(supabase, senderUsername, run.text, tenantId);
          if (run.sessionId && !rec.agent_session_id) {
            await supabase.from("instagram_comment_campaign_recipients")
              .update({ agent_session_id: run.sessionId }).eq("id", rec.id);
          }
          return;
        }
        const account = await getConnectedAccount(supabase, tenantId);
        if (account?.ig_login_token || account?.page_access_token) {
          // Flavor novo (graph.instagram.com) = Standard Access; velho = fallback
          const endpoint = resolveSendEndpoint(account);
          const url = endpoint?.url || "";
          const token = endpoint?.token || null;

          const sentParts = await sendSplitDm(async (part) => {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                recipient: { id: rec.recipient_psid },
                message: { text: part },
                access_token: token,
              }),
            });
            if (!r.ok) {
              const err = await r.json().catch(() => ({}));
              console.error("dm send failed (recipient):", JSON.stringify(err?.error || err).slice(0, 300));
              await logSendFailure(supabase, { tenantId, source: "dm_reply", username: senderUsername, psid: rec.recipient_psid, error: err?.error || err, message: part });
            }
            return r.ok;
          }, run.text);

          // Espelha as msgs do agente no inbox
          try {
            const { data: convs } = await supabase
              .from("instagram_conversations")
              .select("id, total_messages")
              .eq("account_id", account.id)
              .eq("participant_username", senderUsername)
              .order("last_message_at", { ascending: false })
              .limit(1);
            const conv = convs?.[0] || null;
            if (conv && sentParts.length > 0) {
              for (const part of sentParts) {
                await supabase.from("instagram_messages").insert({
                  tenant_id: tenantId,
                  conversation_id: conv.id,
                  instagram_message_id: `agent_${rec.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  content: part,
                  message_type: "text",
                  is_from_me: true,
                  sender_username: account.instagram_username || "",
                  status: "sent",
                  sent_at: new Date().toISOString(),
                });
              }
              await supabase.from("instagram_conversations").update({
                last_message: sentParts[sentParts.length - 1],
                last_message_at: new Date().toISOString(),
                last_agent_message_at: new Date().toISOString(),
                total_messages: (conv.total_messages || 0) + sentParts.length,
              }).eq("id", conv.id);
            }
          } catch (e) {
            console.error("mirror agent reply error:", (e as Error).message);
          }
        }
        if (run.sessionId && !rec.agent_session_id) {
          await supabase.from("instagram_comment_campaign_recipients")
            .update({ agent_session_id: run.sessionId }).eq("id", rec.id);
        }
      }
    }
  }
}

/**
 * Espelha QUALQUER comentário no inbox (conversa por username + msg post_comment).
 * Decisão de produto 13/07: todos os comentários visíveis no inbox, filtro na UI separa de DMs.
 */
export async function mirrorCommentToInbox(supabase: Supa, args: {
  commentId: string;
  postId: string;
  username: string | null;
  igId: string | null;
  text: string;
  parentId?: string | null;
}, account: IgAccount): Promise<{ inserted: boolean; convId: string | null }> {
  try {
    if (!args.username) return { inserted: false, convId: null };
    const tenantId = account.tenant_id;

    // Comentário da PRÓPRIA conta: se é REPLY a alguém, espelha como resposta NOSSA
    // na conversa do autor do comentário pai (histórico completo). Senão, ignora.
    if (args.username === account.instagram_username) {
      if (!args.parentId) return { inserted: false, convId: null };
      const { data: parentMsg } = await supabase
        .from("instagram_messages")
        .select("conversation_id")
        .eq("instagram_message_id", `comment_${args.parentId}`)
        .maybeSingle();
      if (!parentMsg?.conversation_id) return { inserted: false, convId: null };
      const { data: dup } = await supabase.from("instagram_messages")
        .select("id").eq("instagram_message_id", `comment_${args.commentId}`).maybeSingle();
      if (dup) return { inserted: false, convId: null };
      await supabase.from("instagram_messages").insert({
        tenant_id: tenantId,
        conversation_id: parentMsg.conversation_id,
        instagram_message_id: `comment_${args.commentId}`,
        content: args.text,
        message_type: "comment_reply",
        is_from_me: true,
        sender_username: account.instagram_username,
        status: "sent",
        sent_at: new Date().toISOString(),
      });
      await supabase.from("instagram_conversations").update({
        last_message: args.text,
        last_message_at: new Date().toISOString(),
        last_agent_message_at: new Date().toISOString(),
      }).eq("id", parentMsg.conversation_id);
      return { inserted: false, convId: parentMsg.conversation_id };
    }

    // Dedup (uChat legado + dispatcher usam mesmo formato comment_{id})
    const { data: dup } = await supabase.from("instagram_messages")
      .select("id").eq("instagram_message_id", `comment_${args.commentId}`).maybeSingle();
    if (dup) return { inserted: false, convId: null };

    // Conversa por username (mais recente se houver duplicadas do legado)
    const { data: convs } = await supabase
      .from("instagram_conversations")
      .select("id, total_messages")
      .eq("account_id", account.id)
      .eq("participant_username", args.username)
      .order("last_message_at", { ascending: false })
      .limit(1);
    let conv = convs?.[0] || null;

    if (!conv) {
      const { data: created } = await supabase
        .from("instagram_conversations")
        .insert({
          tenant_id: tenantId,
          account_id: account.id,
          thread_id: `comment_${args.username}`,
          participant_instagram_id: args.igId || args.username,
          participant_username: args.username,
          participant_name: args.username,
          last_message: args.text,
          last_message_at: new Date().toISOString(),
          total_messages: 1,
          status: "open",
          metadata: { source: "instagram_comment", post_id: args.postId },
        })
        .select("id, total_messages")
        .single();
      conv = created;
    } else {
      await supabase.from("instagram_conversations").update({
        last_message: args.text,
        last_message_at: new Date().toISOString(),
        total_messages: (conv.total_messages || 0) + 1,
      }).eq("id", conv.id);
    }
    if (!conv) return { inserted: false, convId: null };

    // Detalhes do post: campanha guarda; senão busca na Graph API (permalink+caption+thumb)
    const { data: camp } = await supabase.from("instagram_comment_campaigns")
      .select("post_permalink, post_caption, post_thumbnail_url")
      .eq("tenant_id", tenantId)
      .eq("post_id", args.postId).limit(1).maybeSingle();
    let permalink = camp?.post_permalink || null;
    let postCaption = camp?.post_caption || null;
    let postThumb = camp?.post_thumbnail_url || null;
    if (!permalink) {
      try {
        if (account.ig_login_token) {
          const mr = await fetch(
            `https://graph.instagram.com/v20.0/${args.postId}?fields=permalink,caption,thumbnail_url,media_url&access_token=${account.ig_login_token}`,
          );
          if (mr.ok) {
            const md = await mr.json();
            permalink = md?.permalink || null;
            postCaption = (md?.caption || "").slice(0, 300) || null;
            postThumb = md?.thumbnail_url || md?.media_url || null;
          }
        }
      } catch { /* segue sem detalhes */ }
    }

    await supabase.from("instagram_messages").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      instagram_message_id: `comment_${args.commentId}`,
      content: args.text,
      message_type: "post_comment",
      is_from_me: false,
      sender_username: args.username,
      reference_type: "post",
      reference_id: args.postId,
      reference_url: permalink,
      metadata: { post_caption: postCaption, post_thumbnail: postThumb, permalink },
      status: null,
      sent_at: new Date().toISOString(),
    });
    return { inserted: true, convId: conv.id };
  } catch (e) {
    console.error("mirrorCommentToInbox error:", (e as Error).message);
    return { inserted: false, convId: null };
  }
}

/**
 * Divide a resposta do agente em MENSAGENS SEPARADAS (estilo WhatsApp).
 * O agente escreve blocos separados por linha em branco; cada bloco vira 1 DM,
 * com pausa de 1.5-3s entre elas (parece digitação humana).
 */
/**
 * Contrato com o agente em comentários: 1º bloco pode vir como "PÚBLICO: ..."
 * → resposta pública curta ao comentário (postada no post); o resto é a DM.
 * Sem o marcador, tudo é DM (fallback seguro).
 */
export function extractPublicReply(text: string): { publicReply: string | null; dmText: string } {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length && /^p[úu]blico\s*:/i.test(blocks[0])) {
    const pub = blocks[0].replace(/^p[úu]blico\s*:\s*/i, "").trim();
    return { publicReply: pub || null, dmText: blocks.slice(1).join("\n\n").trim() };
  }
  return { publicReply: null, dmText: text };
}

/** Publica resposta ao comentário no post (como o dono da conta) + espelha no inbox aninhada. */
export async function postPublicCommentReply(
  supabase: Supa,
  commentId: string,
  message: string,
  tenantId: string,
  accountIn?: IgAccount | null,
): Promise<void> {
  if (!message || commentId.startsWith("sim_")) return; // simulação nunca posta
  try {
    const account = accountIn || await getConnectedAccount(supabase, tenantId);
    if (!account?.ig_login_token) return;

    const r = await fetch(`https://graph.instagram.com/v20.0/${commentId}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: account.ig_login_token }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("public comment reply failed:", d?.error?.message);
      await logSendFailure(supabase, { tenantId, source: "public_reply", commentId, error: d?.error || d, message });
      return;
    }

    // Espelha aninhada sob o comentário original no inbox
    const { data: parentMsg } = await supabase
      .from("instagram_messages")
      .select("conversation_id")
      .eq("instagram_message_id", `comment_${commentId}`)
      .maybeSingle();
    if (parentMsg?.conversation_id) {
      await supabase.from("instagram_messages").insert({
        tenant_id: tenantId,
        conversation_id: parentMsg.conversation_id,
        instagram_message_id: `comment_${d.id || `reply_${commentId}_${Date.now()}`}`,
        content: message,
        message_type: "comment_reply",
        is_from_me: true,
        sender_username: account.instagram_username,
        status: "sent",
        sent_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error("public comment reply error:", (e as Error).message);
  }
}

/**
 * CUTUCÃO PÚBLICO: quem comentou → recebeu a DM → NÃO respondeu.
 * Fora da janela 24h a Meta não deixa mandar DM de novo, então o único re-toque
 * é responder o COMENTÁRIO original com @menção (notifica forte, pode repetir).
 *
 * 2 retornos: 1º às +24h da DM (leve), 2º às +24h do 1º (~48h, última chamada).
 * Se a pessoa responder a DM (replied_at setado pelo webhook), sai da fila sozinha.
 * Tom informal do dono da conta, sem emoji, primeiro nome quando tem, texto variado por recipient.
 */
const NUDGE_MIN_HOURS = 24;         // 1º cutucão: DM enviada há +24h
const NUDGE2_MIN_HOURS = 24;        // 2º cutucão: +24h depois do 1º (~48h total)
const NUDGE_MAX = 2;
const NUDGE_PER_RUN = 6;            // teto por execução (anti-burst)

function pickVariant(seed: string, variants: string[]): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return variants[h % variants.length];
}

function buildNudgeText(stage: 1 | 2, username: string, firstName: string | null): string {
  const nm = firstName ? ` ${firstName}` : "";
  const v1 = [
    `@${username} opa${nm}, te mandei o material lá no direct.. deu uma olhada?`,
    `@${username} mandei tudo no teu direct${nm}.. passou lá pra ver?`,
    `@${username} deixei o material no direct pra ti${nm}.. chegou aí?`,
    `@${username} te respondi no direct${nm}.. corre lá que tá tudo lá`,
    `@${username} joguei o material no teu direct${nm}, viu?`,
    `@${username} mandei no direct${nm}.. dá um confere quando puder`,
  ];
  const v2 = [
    `@${username} só voltando aqui${nm}.. o material tá te esperando no direct, não deixa passar`,
    `@${username} passa lá no direct${nm}, deixei uma coisa boa e não quero que passe batido`,
    `@${username} última chamada${nm}.. tá tudo no teu direct, vale a pena abrir`,
    `@${username} não some não${nm}.. o material continua lá no direct te esperando`,
    `@${username} te mandei no direct${nm} e ainda tá fechado.. dá uma olhada que é rapidinho`,
  ];
  return pickVariant(`${username}:${stage}`, stage === 1 ? v1 : v2);
}

async function firstNameFor(supabase: Supa, username: string, tenantId: string, account?: IgAccount | null): Promise<string | null> {
  const p = await fetchCommenterProfile(supabase, username, tenantId, account);
  return p.name ? p.name.split(/\s+/)[0] : null;
}

export async function processCommentNudges(supabase: Supa): Promise<{ nudged: number }> {
  const now = Date.now();
  const nudge1Before = new Date(now - NUDGE_MIN_HOURS * 3600_000).toISOString();
  const nudge2Before = new Date(now - NUDGE2_MIN_HOURS * 3600_000).toISOString();

  // Só campanhas ativas, só quem recebeu DM ('sent') e não respondeu.
  // Cron: linhas de TODOS os tenants — cada linha carrega o tenant_id e a conta
  // é resolvida por tenant (cache local). Falha de um tenant não aborta os demais.
  const sel = "id, tenant_id, comment_id, commenter_username, nudge_count, campaign:instagram_comment_campaigns!inner(status)";

  // 1º cutucão: nudge_count=0, DM há +24h
  const { data: batch1 } = await supabase
    .from("instagram_comment_campaign_recipients")
    .select(sel)
    .eq("campaign.status", "active")
    .eq("dm_status", "sent")
    .is("replied_at", null)
    .eq("nudge_count", 0)
    .not("commenter_username", "is", null)
    .lt("dm_sent_at", nudge1Before)
    .order("dm_sent_at", { ascending: true })
    .limit(NUDGE_PER_RUN);

  // 2º cutucão: nudge_count=1, último cutucão há +24h
  const { data: batch2 } = await supabase
    .from("instagram_comment_campaign_recipients")
    .select(sel)
    .eq("campaign.status", "active")
    .eq("dm_status", "sent")
    .is("replied_at", null)
    .eq("nudge_count", 1)
    .not("commenter_username", "is", null)
    .lt("last_nudged_at", nudge2Before)
    .order("last_nudged_at", { ascending: true })
    .limit(NUDGE_PER_RUN);

  const rows = [...(batch1 || []), ...(batch2 || [])].slice(0, NUDGE_PER_RUN);
  let nudged = 0;
  const accountByTenant = new Map<string, IgAccount | null>();

  for (const r of rows) {
    const username: string = r.commenter_username;
    const commentId: string = r.comment_id;
    const tenantId: string = r.tenant_id;
    if (!username || !commentId || !tenantId || commentId.startsWith("sim_")) continue;

    try {
      if (await agentAllowlistBlocks(supabase, username, tenantId)) continue; // respeita modo teste

      if (!accountByTenant.has(tenantId)) {
        accountByTenant.set(tenantId, await getConnectedAccount(supabase, tenantId));
      }
      const account = accountByTenant.get(tenantId) || null;

      const stage: 1 | 2 = (r.nudge_count || 0) === 0 ? 1 : 2;
      const nome = await firstNameFor(supabase, username, tenantId, account);
      const text = buildNudgeText(stage, username, nome);

      await postPublicCommentReply(supabase, commentId, text, tenantId, account);
      await supabase.from("instagram_comment_campaign_recipients")
        .update({ nudge_count: stage, last_nudged_at: new Date().toISOString() })
        .eq("id", r.id);
      nudged++;
    } catch (e) {
      console.error("nudge error:", username, (e as Error).message);
      await logSendFailure(supabase, { tenantId, source: "nudge", username, commentId, error: (e as Error).message });
    }
    // jitter humano entre posts
    if (nudged < rows.length) await new Promise((res) => setTimeout(res, 1500 + Math.floor(Math.random() * 2000)));
  }

  return { nudged };
}

function splitAgentText(text: string, maxBlocks = 4): string[] {
  return text
    .split(/\n{2,}/)                     // blocos por linha em branco
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    // Defesa: bloco "PÚBLICO:" só faz sentido em resposta a comentário (extraído
    // antes); se o agente emitir o marcador num dm_reply, NUNCA vaza pro lead.
    .filter((b) => !/^p[úu]blico\s*:/i.test(b))
    .slice(0, maxBlocks);                 // máx N msgs por rajada (anti-spam)
}

async function sendSplitDm(
  sendOne: (text: string) => Promise<boolean>,
  fullText: string,
): Promise<string[]> {
  const parts = splitAgentText(fullText);
  const sent: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const delay = 1500 + Math.floor(Math.random() * 1500); // 1.5-3s entre msgs
      await new Promise((r) => setTimeout(r, delay));
    }
    const ok = await sendOne(parts[i]);
    if (!ok) break;
    sent.push(parts[i]);
  }
  return sent;
}

/** Envia DM pra pessoa via PSID salvo na conversa + espelha no inbox */
async function sendDmToUsername(supabase: Supa, username: string, text: string, tenantId: string): Promise<void> {
  const { data: convs } = await supabase
    .from("instagram_conversations")
    .select("id, participant_instagram_id")
    .eq("tenant_id", tenantId)
    .eq("participant_username", username)
    .order("last_message_at", { ascending: false })
    .limit(10);
  // deno-lint-ignore no-explicit-any
  const conv = (convs || []).find((c: any) => /^\d+$/.test(c.participant_instagram_id)) || convs?.[0];
  if (!conv || !/^\d+$/.test(conv.participant_instagram_id)) return;

  const account = await getConnectedAccount(supabase, tenantId);
  if (!account) return;
  const endpoint = resolveSendEndpoint(account);
  const url = endpoint?.url || "";
  const token = endpoint?.token || null;

  const sent = await sendSplitDm(async (part) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: conv.participant_instagram_id },
        message: { text: part },
        access_token: token,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error("dm send failed (username):", JSON.stringify(err?.error || err).slice(0, 300));
      await logSendFailure(supabase, { tenantId, source: "dm_reply", username, psid: conv.participant_instagram_id, error: err?.error || err, message: part });
    }
    return r.ok;
  }, text);
  if (sent.length === 0) return;

  for (const part of sent) {
    await supabase.from("instagram_messages").insert({
      tenant_id: tenantId,
      conversation_id: conv.id,
      instagram_message_id: `agent_u_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      content: part,
      message_type: "text",
      is_from_me: true,
      sender_username: account.instagram_username,
      status: "sent",
      sent_at: new Date().toISOString(),
    });
  }
  await supabase.from("instagram_conversations").update({
    last_message: sent[sent.length - 1],
    last_message_at: new Date().toISOString(),
    last_agent_message_at: new Date().toISOString(),
  }).eq("id", conv.id);
}

/**
 * Triagem de comentário SEM campanha pelo agente IG da conta:
 * o agente decide DM de abertura (abre janela 24h com pergunta), sugestão pública ou [SKIP].
 */
async function triageCommentWithAgent(supabase: Supa, args: {
  convId: string | null;
  commentId: string;
  username: string;
  text: string;
  postId: string;
}, account: IgAccount): Promise<void> {
  const tenantId = account.tenant_id;
  if (await agentAllowlistBlocks(supabase, args.username, tenantId)) return;

  // Detalhes do post pro contexto
  let postCaption: string | null = null;
  try {
    if (account.ig_login_token) {
      const mr = await fetch(`https://graph.instagram.com/v20.0/${args.postId}?fields=caption&access_token=${account.ig_login_token}`);
      if (mr.ok) {
        const cap = ((await mr.json())?.caption || "").trim();
        // CTA ("comenta X que te mando Y") mora no FINAL do caption — truncar só o
        // começo matava o CTA e o agente dava [SKIP] em comentário legítimo (bug 14/07).
        // Janela: início + final. Total ≤450 (renderAutoContext corta valores em 500).
        postCaption = !cap ? null : cap.length <= 450 ? cap : `${cap.slice(0, 150)} […] ${cap.slice(-280)}`;
      }
    }
  } catch { /* segue sem caption */ }

  // Sessão universal por pessoa (memória contínua) + dedup de abertura:
  // quem recebeu msg do agente nas últimas 12h NÃO ganha nova abertura
  // (caso Monique: 2 comentários em 9s = 2 private replies duplicadas).
  let sessionId: string | null = null;
  if (args.convId) {
    const { data: conv } = await supabase.from("instagram_conversations")
      .select("agent_session_id, last_agent_message_at").eq("id", args.convId).maybeSingle();
    sessionId = conv?.agent_session_id || null;
    if (conv?.last_agent_message_at &&
        Date.now() - new Date(conv.last_agent_message_at).getTime() < 12 * 60 * 60 * 1000) {
      console.log("triage dedup: abertura recente, pulando", args.username);
      return;
    }
  }

  // Lock por pessoa (mesmo do reply handler): comentários em rajada não geram
  // 2 triagens concorrentes — a 1ª ainda não gravou last_agent_message_at
  const triageLock = `agentlock_${tenantId}_${args.username}`;
  const { error: tlErr } = await supabase.from("instagram_processed_mids").insert({ mid: triageLock });
  if (tlErr) {
    const { data: lockRow } = await supabase.from("instagram_processed_mids")
      .select("seen_at").eq("mid", triageLock).maybeSingle();
    if (lockRow && Date.now() - new Date(lockRow.seen_at).getTime() < 90_000) {
      console.log("triage lock ativo, pulando comentário em rajada:", args.username);
      return;
    }
    await supabase.from("instagram_processed_mids")
      .update({ seen_at: new Date().toISOString() }).eq("mid", triageLock);
  }

  try {
  // Nome real + bio (cache → Business Discovery) — "Opaa Dra. Rosa!" + contexto do negócio
  const profile = await fetchCommenterProfile(supabase, args.username, tenantId, account);

  const run = await runAgent({
    agentSlug: "ig-primeiro-contato",
    sessionId,
    message: `[COMENTÁRIO no post] ${args.text}`,
    userId: args.username,
    context: {
      interaction: "comment_triage",
      comment_real_id: args.commentId,
      commenter_username: args.username,
      commenter_real_name: profile.name,
      commenter_bio: profile.bio,
      comment_text: args.text,
      post_caption: postCaption,
      campaign: null,
    },
  });

  // Persiste sessão na conversa (memória por pessoa)
  if (run.sessionId && args.convId && !sessionId) {
    await supabase.from("instagram_conversations")
      .update({ agent_session_id: run.sessionId }).eq("id", args.convId);
  }

  const rawText = (run.text || "").trim();
  if (!rawText || rawText.toUpperCase().startsWith("[SKIP")) return;

  // Bloco PÚBLICO: → responde o comentário no post; resto → DM
  const { publicReply, dmText } = extractPublicReply(rawText);
  if (publicReply) await postPublicCommentReply(supabase, args.commentId, publicReply, tenantId, account);
  const text = dmText;
  if (!text) return;

  // Envia como Private Reply (abre a janela)
  if (!account?.page_access_token) {
    console.error("triage: sem page_access_token — private reply impossível, DM não enviada");
    return;
  }

  // REGRA INSTA: pós-comentário só vale a Private Reply (1 única msg por comment_id).
  // A janela de 24h ainda NÃO abriu — msgs extras por PSID não entregam.
  // Então a 1ª DM vai INTEIRA numa mensagem só; o split fica pras respostas (janela aberta).
  const fullDm = splitAgentText(text, Infinity).join("\n\n");
  const sendPrivateReply = () =>
    fetch(`${GRAPH}/${account.facebook_page_id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { comment_id: args.commentId },
        message: { text: fullDm },
        access_token: account.page_access_token,
      }),
    });
  let sendRes = await sendPrivateReply();
  if (!sendRes.ok) {
    // Erro transiente da Meta é comum (caso Lucas 14/07) — 1 retry após 3s
    const firstErr = (await sendRes.json().catch(() => ({})))?.error?.message || `${sendRes.status}`;
    console.error("triage private reply failed (tentativa 1):", firstErr);
    await logSendFailure(supabase, { tenantId, source: "triage_private_reply", username: args.username, commentId: args.commentId, error: firstErr, message: fullDm, attempt: 1 });
    await new Promise((r) => setTimeout(r, 3000));
    sendRes = await sendPrivateReply();
  }
  if (!sendRes.ok) {
    const err = (await sendRes.json().catch(() => ({})))?.error?.message || `${sendRes.status}`;
    console.error("triage private reply failed (final):", err);
    await logSendFailure(supabase, { tenantId, source: "triage_private_reply", username: args.username, commentId: args.commentId, error: err, message: fullDm, attempt: 2 });
    // FALHA VISÍVEL: a pública já prometeu o direct — o admin precisa ver no inbox
    if (args.convId) {
      await supabase.from("instagram_messages").insert({
        tenant_id: tenantId,
        conversation_id: args.convId,
        instagram_message_id: `pr_fail_${args.commentId}`,
        content: `⚠️ DM NÃO ENVIADA (${err.slice(0, 120)}) — mandar manual:\n\n${fullDm}`,
        message_type: "text",
        is_from_me: true,
        sender_username: account.instagram_username,
        status: "failed",
        sent_at: new Date().toISOString(),
      });
      await supabase.from("instagram_conversations").update({
        last_message: "⚠️ DM do agente falhou — enviar manual",
        last_message_at: new Date().toISOString(),
      }).eq("id", args.convId);
    }
    return;
  }
  const sendData = await sendRes.json().catch(() => ({}));
  const psid = sendData?.recipient_id ? String(sendData.recipient_id) : null;
  const sentParts = [fullDm];

  // Espelha as DMs no inbox + guarda PSID na conversa
  if (args.convId) {
    for (let i = 0; i < sentParts.length; i++) {
      await supabase.from("instagram_messages").insert({
        tenant_id: tenantId,
        conversation_id: args.convId,
        instagram_message_id: i === 0 ? `pr_${args.commentId}` : `pr_${args.commentId}_${i}`,
        content: sentParts[i],
        message_type: "text",
        is_from_me: true,
        sender_username: account.instagram_username,
        status: "sent",
        sent_at: new Date().toISOString(),
      });
    }
    const patch: Record<string, unknown> = {
      last_message: sentParts[sentParts.length - 1],
      last_message_at: new Date().toISOString(),
      last_agent_message_at: new Date().toISOString(),
    };
    if (psid) patch.participant_instagram_id = psid;
    await supabase.from("instagram_conversations").update(patch).eq("id", args.convId);
  }
  } finally {
    await supabase.from("instagram_processed_mids").delete().eq("mid", triageLock);
  }
}

/**
 * Processa payload Meta (object=instagram). Retorna quantos eventos de campanha tratou.
 * Eventos fora de campanha são ignorados silenciosamente.
 */
// deno-lint-ignore no-explicit-any
export async function handleMetaCampaignEvents(supabase: Supa, body: any): Promise<{ handled: number }> {
  let handled = 0;

  for (const entry of body.entry || []) {
    // Conta resolvida pelo DADO DO EVENTO (entry.id = instagram_business_id /
    // ig_login_id). Sem match e com 2+ contas → pula a entry (não chuta tenant).
    const account = await resolveAccountFromEvent(supabase, entry?.id ? String(entry.id) : null);
    if (!account) {
      console.warn("handleMetaCampaignEvents: conta não resolvida pro entry", entry?.id);
      continue;
    }
    const tenantId = account.tenant_id;
    const ownUsername = account.instagram_username || null;

    try {
    // ── field=comments (changes) ──
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;
      const v = change.value || {};
      const postId = v.media?.id ? String(v.media.id) : null;
      const commentId = v.id ? String(v.id) : null;
      if (!postId || !commentId) continue;

      // DEDUP ATÔMICO por comment_id (mesma classe do flood de DM): Meta re-entrega
      // eventos de comments também. Só quem inserir o claim primeiro processa.
      const { data: claimed, error: claimErr } = await supabase
        .from("instagram_processed_mids")
        .insert({ mid: `comment_${commentId}` })
        .select("mid")
        .maybeSingle();
      if (claimErr && claimErr.code !== "23505") {
        console.error("comment claim error:", claimErr.message); // falha real ≠ duplicado
      } else if (!claimed) {
        continue; // retry do Meta — já processado
      }

      // TODO comentário vai pro inbox (decisão de produto 13/07) — com ou sem campanha.
      // Skip comentários da própria conta (respostas nossas nos posts).
      const mirror = await mirrorCommentToInbox(supabase, {
        commentId,
        postId,
        username: v.from?.username || null,
        igId: v.from?.id ? String(v.from.id) : null,
        text: v.text || "",
        parentId: v.parent_id ? String(v.parent_id) : null,
      }, account);

      const { data: campaigns } = await supabase
        .from("instagram_comment_campaigns")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .eq("post_id", postId);

      // ── TRIAGEM INTELIGENTE (agente IG da conta) ──
      // Roda quando o comentário NÃO bate nenhuma keyword de campanha ativa:
      //  - post sem campanha → sempre
      //  - post COM campanha → só comentário que não é a keyword (pergunta real,
      //    ex: betobove perguntou do Claude num post de "reels"). Keyword vai pro
      //    dispatcher; pergunta/interesse o agente responde; elogio/spam → [SKIP].
      const triageText = v.text || "";
      const matchesAnyCampaign = (campaigns || []).some((c: { keyword_mode: string; keywords: string[] | null; min_words: number | null }) => matchesFilter(c, triageText));
      if (
        mirror.inserted && !matchesAnyCampaign &&
        v.from?.username && v.from.username !== ownUsername
      ) {
        // waitUntil: promise flutuante pós-response pode ser morta pelo runtime
        const triageWork = triageCommentWithAgent(supabase, {
          convId: mirror.convId,
          commentId,
          username: v.from.username,
          text: v.text || "",
          postId,
        }, account).catch((e) => console.error("triage error:", (e as Error).message));
        // deno-lint-ignore no-explicit-any
        const rt = (globalThis as any).EdgeRuntime;
        if (rt?.waitUntil) rt.waitUntil(triageWork);
        else await triageWork;
        handled++;
      }

      for (const c of campaigns || []) {
        const text = v.text || "";
        const username = v.from?.username || null;
        // Comentário da PRÓPRIA conta nunca vira recipient (ex: dono da conta responde no post)
        if (username && ownUsername && username === ownUsername) continue;
        const status = matchesFilter(c, text) ? "pending" : "skipped_keyword";

        // once_per_user dedup
        if (status === "pending" && c.once_per_user && username) {
          const { data: dup } = await supabase
            .from("instagram_comment_campaign_recipients")
            .select("id").eq("campaign_id", c.id).eq("commenter_username", username).limit(1);
          if (dup && dup.length > 0) continue;
        }

        const delayS = c.delay_min_seconds +
          Math.floor(Math.random() * Math.max(1, c.delay_max_seconds - c.delay_min_seconds));

        await supabase.from("instagram_comment_campaign_recipients").upsert({
          tenant_id: tenantId,
          campaign_id: c.id,
          comment_id: commentId,
          commenter_username: username,
          commenter_ig_id: v.from?.id ? String(v.from.id) : null,
          comment_text: text,
          comment_at: new Date().toISOString(),
          dm_status: status,
          scheduled_at: new Date(Date.now() + delayS * 1000).toISOString(),
        }, { onConflict: "campaign_id,comment_id", ignoreDuplicates: true });
        handled++;
      }
    }

    // NOTA (14/07/2026): o bloco `entry.messaging` que vivia aqui foi REMOVIDO.
    // Ele duplicava a resposta do agente — index.ts já chama handleCampaignReplyByUsername
    // pra cada DM recebida (recipient de campanha + sessão universal, com material,
    // split e criação de lead). Dois handlers = 2 respostas por mensagem (flood alexandrerosis).
    } catch (e) {
      // try/catch por entry/conta: falha de um tenant não aborta os demais
      console.error("handleMetaCampaignEvents entry error:", (e as Error).message);
    }
  }

  return { handled };
}
