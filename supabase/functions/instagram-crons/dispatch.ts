// instagram-comments-dispatch — motor das campanhas "comentário → DM (Private Reply)".
//
// Roda via cron (1/min) e faz 2 fases por invocação:
//   FASE 1 (fetch): pra cada campanha ativa, puxa comentários novos do post
//     via Meta Graph API e insere recipients (status=pending, scheduled_at=now+delay).
//   FASE 2 (dispatch): pega recipients pending vencidos, gera a msg
//     (template com variáveis OU agente via agent-runner) e envia Private Reply
//     via POST /{FB_PAGE_ID}/messages com recipient.comment_id (page token).
//
// Regras Meta respeitadas: private reply 1x por comment_id (UNIQUE no banco),
// prazo 7 dias (filtra comment_at), cap ~60 envios/hora via MAX_SENDS_PER_RUN.
//
// Ver decisão de arquitetura na conversa 13/07/2026: uChat NÃO participa deste fluxo.

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  getPersonSession,
  savePersonSession,
  buildAulaLink,
  getDefaultMaterialBase,
  resolveSendEndpoint,
  canSendDm,
  ACCOUNT_FIELDS,
  type IgAccount,
} from "../instagram-webhook/meta-campaign.ts";
import { getIntegrationKey } from "../_shared/config.ts";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH = "https://graph.facebook.com/v20.0";

const MAX_SENDS_PER_RUN = 2; // cron 1/min → máx 120/h teórico; na prática fica ~60-80/h com delays
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Campaign = {
  id: string;
  name: string;
  post_id: string;
  post_caption: string | null;
  keyword_mode: "all" | "contains" | "min_words";
  keywords: string[];
  min_words: number;
  reply_mode: "template" | "agent";
  dm_template: string | null;
  agent_slug: string | null;
  delay_min_seconds: number;
  delay_max_seconds: number;
  once_per_user: boolean;
  process_existing: boolean;
  created_at: string;
};

function matchesFilter(c: Campaign, text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (c.keyword_mode === "contains") {
    return (c.keywords || []).some((k) => t.includes(k.toLowerCase().trim()));
  }
  if (c.keyword_mode === "min_words") {
    return t.split(/\s+/).filter(Boolean).length >= (c.min_words || 1);
  }
  return true; // 'all'
}

/** Caption pro contexto do agente: CTA mora no FINAL — janela início+fim ≤450
 * (renderAutoContext do runner corta valores em 500; truncar só o começo matava o CTA). */
function captionWindow(cap: string | null): string | null {
  const c = (cap || "").trim();
  if (!c) return null;
  return c.length <= 450 ? c : `${c.slice(0, 150)} […] ${c.slice(-280)}`;
}

/** Modo teste: config ig_agent_test_allowlist não-vazia → agente só fala com esses usernames. */
// deno-lint-ignore no-explicit-any
async function agentAllowlistBlocks(supabase: any, username: string | null, tenantId: string): Promise<boolean> {
  if (!username) return false;
  try {
    const raw = await getIntegrationKey(supabase, "ig_agent_test_allowlist", tenantId);
    if (!raw) return false;
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list) || list.length === 0) return false;
    return !list.some((u: string) => String(u).replace(/^@/, "").toLowerCase() === username.toLowerCase());
  } catch { return false; }
}

/** Registra falha de envio com o erro CRU da Meta (tabela instagram_send_failures). */
// deno-lint-ignore no-explicit-any
async function logSendFailure(supabase: any, f: {
  tenantId: string; source: string; username?: string | null; commentId?: string | null;
  error: unknown; message?: string | null; attempt?: number;
}): Promise<void> {
  try {
    await supabase.from("instagram_send_failures").insert({
      tenant_id: f.tenantId,
      source: f.source,
      username: f.username || null,
      comment_id: f.commentId || null,
      error_raw: (typeof f.error === "string" ? f.error : JSON.stringify(f.error)).slice(0, 2000),
      message_text: (f.message || "").slice(0, 1000) || null,
      attempt: f.attempt ?? 1,
    });
  } catch { /* observabilidade nunca quebra o fluxo */ }
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl
    .replaceAll("{nome}", vars.nome || vars.username || "")
    .replaceAll("{primeiro_nome}", (vars.nome || vars.username || "").split(" ")[0])
    .replaceAll("{username}", vars.username || "")
    .replaceAll("{comment_text}", vars.comment_text || "");
}

/** Chama agent-runner e concatena o SSE (mesmo padrão do whatsapp-webhook/agent-platform.ts) */
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
    signal: AbortSignal.timeout(45_000), // agente pendurado não pode segurar a run
    body: JSON.stringify({
      agent_slug: args.agentSlug,
      channel: "instagram_comment",
      session_id: args.sessionId,
      message: args.message,
      user_id: null, // agents_sessions.user_id é uuid — username vai no context
      context: args.context,
    }),
  });
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
  if (streamError) throw new Error(`agent stream error: ${streamError}`);
  return { text: fullText.trim(), sessionId };
}

/**
 * Espelha comentário do lead + DM enviada no inbox (instagram_conversations/messages).
 * Mesmo padrão do log-social-selling-action. Dedup por instagram_message_id:
 * comentário usa `comment_{id}` (mesmo formato do uChat → não duplica se uChat também mandar).
 */
// deno-lint-ignore no-explicit-any
async function mirrorToInbox(supabase: any, args: {
  tenantId: string;
  accountId: string;
  accountUsername: string;
  leadId?: string | null;
  username: string;
  commentId: string;
  commentText: string;
  commentAt: string | null;
  dmText: string;
}) {
  try {
    // limit(1) + order: pode haver conversas duplicadas do mesmo username (legado uChat)
    const { data: convs } = await supabase
      .from("instagram_conversations")
      .select("id, total_messages")
      .eq("account_id", args.accountId)
      .eq("participant_username", args.username)
      .order("last_message_at", { ascending: false })
      .limit(1);
    let conv = convs?.[0] || null;

    if (!conv) {
      const { data: created } = await supabase
        .from("instagram_conversations")
        .insert({
          tenant_id: args.tenantId,
          account_id: args.accountId,
          lead_id: args.leadId || null,
          thread_id: `comment_campaign_${args.username}`,
          participant_instagram_id: args.username,
          participant_username: args.username,
          participant_name: args.username,
          last_message: args.dmText,
          last_message_at: new Date().toISOString(),
          last_agent_message_at: new Date().toISOString(),
          total_messages: 2,
          status: "open",
          metadata: { source: "instagram_comment_campaign" },
        })
        .select("id, total_messages")
        .single();
      conv = created;
    } else {
      await supabase.from("instagram_conversations").update({
        last_message: args.dmText,
        last_message_at: new Date().toISOString(),
        last_agent_message_at: new Date().toISOString(),
        total_messages: (conv.total_messages || 0) + 2,
      }).eq("id", conv.id);
    }
    if (!conv) return;

    // 1. Comentário do lead (dedup: uChat usa mesmo formato comment_{id})
    const { data: dupC } = await supabase.from("instagram_messages")
      .select("id").eq("instagram_message_id", `comment_${args.commentId}`).maybeSingle();
    if (!dupC) {
      await supabase.from("instagram_messages").insert({
        tenant_id: args.tenantId,
        conversation_id: conv.id,
        instagram_message_id: `comment_${args.commentId}`,
        content: args.commentText,
        message_type: "post_comment",
        is_from_me: false,
        sender_username: args.username,
        status: null, // CHECK só aceita sending/sent/delivered/read/failed; null = msg recebida
        sent_at: args.commentAt || new Date().toISOString(),
      });
    }
    // 2. Nossa DM (private reply)
    await supabase.from("instagram_messages").insert({
      tenant_id: args.tenantId,
      conversation_id: conv.id,
      instagram_message_id: `pr_${args.commentId}`,
      content: args.dmText,
      message_type: "text",
      is_from_me: true,
      sender_username: args.accountUsername,
      status: "sent",
      sent_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("mirrorToInbox error:", (e as Error).message);
  }
}

/** Espelha só o comentário (sem DM) — usado pra TODO comment aparecer no inbox */
// deno-lint-ignore no-explicit-any
async function mirrorCommentOnly(supabase: any, args: {
  tenantId: string;
  accountId: string;
  commentId: string;
  username: string;
  igId: string | null;
  text: string;
  commentAt: string;
  postPermalink?: string | null;
  postCaption?: string | null;
  postThumb?: string | null;
}) {
  try {
    const { data: dup } = await supabase.from("instagram_messages")
      .select("id").eq("instagram_message_id", `comment_${args.commentId}`).maybeSingle();
    if (dup) return;

    const { data: convs } = await supabase
      .from("instagram_conversations")
      .select("id, total_messages")
      .eq("account_id", args.accountId)
      .eq("participant_username", args.username)
      .order("last_message_at", { ascending: false })
      .limit(1);
    let conv = convs?.[0] || null;

    if (!conv) {
      const { data: created } = await supabase
        .from("instagram_conversations")
        .insert({
          tenant_id: args.tenantId,
          account_id: args.accountId,
          thread_id: `comment_${args.username}`,
          participant_instagram_id: args.igId || args.username,
          participant_username: args.username,
          participant_name: args.username,
          last_message: args.text,
          last_message_at: args.commentAt,
          total_messages: 1,
          status: "open",
          metadata: { source: "instagram_comment" },
        })
        .select("id, total_messages")
        .single();
      conv = created;
    } else {
      await supabase.from("instagram_conversations").update({
        last_message: args.text,
        last_message_at: args.commentAt,
        total_messages: (conv.total_messages || 0) + 1,
      }).eq("id", conv.id);
    }
    if (!conv) return;

    await supabase.from("instagram_messages").insert({
      tenant_id: args.tenantId,
      conversation_id: conv.id,
      instagram_message_id: `comment_${args.commentId}`,
      content: args.text,
      message_type: "post_comment",
      is_from_me: false,
      sender_username: args.username,
      reference_type: "post",
      reference_url: args.postPermalink || null,
      metadata: { post_caption: args.postCaption || null, post_thumbnail: args.postThumb || null, permalink: args.postPermalink || null },
      status: null,
      sent_at: args.commentAt,
    });
  } catch (e) {
    console.error("mirrorCommentOnly error:", (e as Error).message);
  }
}

type Report = { fetched: number; inserted: number; sent: number; failed: number; skipped: number; errors: string[] };

export async function handleDispatch(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabase = createClient(SUPA_URL, SERVICE_KEY);
  const report: Report = { fetched: 0, inserted: 0, sent: 0, failed: 0, skipped: 0, errors: [] };

  try {
    // Cron multi-tenant: itera TODAS as contas connected e particiona pelo
    // tenant_id da conta. Try/catch por conta — falha de uma não aborta as demais.
    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select(ACCOUNT_FIELDS)
      .eq("status", "connected");
    // Aceita os DOIS flavors da Meta (IG Login novo ou Página antiga) — exigir
    // page_access_token deixava morto quem conectou pelo caminho recomendado.
    const usable = ((accounts || []) as IgAccount[]).filter(canSendDm);
    if (usable.length === 0) {
      return json({
        error: "Nenhuma conta IG conectada com credencial de envio. Cadastre " +
          "ig_login_token + ig_login_id (recomendado) ou page_access_token + " +
          "facebook_page_id em Configurações → Instagram Oficial.",
      }, 500);
    }

    for (const account of usable) {
      try {
        await processAccount(supabase, account, report);
      } catch (e) {
        report.errors.push(`conta @${account.instagram_username || account.id}: ${(e as Error).message}`);
      }
    }

    return json({ success: true, ...report });
  } catch (e) {
    return json({ error: (e as Error).message, ...report }, 500);
  }
}

// deno-lint-ignore no-explicit-any
async function processAccount(supabase: any, account: IgAccount, report: Report): Promise<void> {
  {
    const tenantId = account.tenant_id;
    // Leitura tambem muda com o flavor: IG Login le em graph.instagram.com.
    // Chamar graph.facebook.com com token do IG Login devolve 400.
    const useIgLogin = !!account.ig_login_token;
    const readToken = useIgLogin
      ? account.ig_login_token
      : (account.access_token || account.page_access_token);
    const readBase = useIgLogin ? "https://graph.instagram.com/v20.0" : GRAPH;
    // Endpoint de envio conforme o flavor da conta (IG Login novo / Página antiga).
    // canSendDm() já garantiu que existe — o "!" é seguro aqui.
    const send = resolveSendEndpoint(account)!;
    // Base do link de material padrão do tenant (null → link_aula não é injetado)
    const materialBase = await getDefaultMaterialBase(supabase, tenantId);

    const { data: campaigns } = await supabase
      .from("instagram_comment_campaigns")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "active");

    // ══════════ FASE 1: fetch comentários novos ══════════
    for (const c of (campaigns || []) as Campaign[]) {
      try {
        // Até 3 páginas (150 comentários) por run — post viral não perde a cauda
        let comments: any[] = [];
        let pageUrl: string | null =
          `${readBase}/${c.post_id}/comments?fields=id,text,timestamp,username,from&limit=50&access_token=${readToken}`;
        for (let page = 0; page < 3 && pageUrl; page++) {
          const r: Response = await fetch(pageUrl);
          if (!r.ok) {
            if (page === 0) report.errors.push(`fetch ${c.name}: ${r.status}`);
            break;
          }
          const data: { data?: any[]; paging?: { next?: string } } = await r.json();
          comments = comments.concat(data?.data || []);
          pageUrl = data?.paging?.next || null;
        }
        if (comments.length === 0 && report.errors.some((e) => e.startsWith(`fetch ${c.name}`))) continue;
        report.fetched += comments.length;

        for (const cm of comments) {
          const commentAt = cm.timestamp ? new Date(cm.timestamp) : new Date();
          const usernameEarly = cm.username || cm.from?.username || null;

          // TODO comentário vai pro inbox (decisão de produto 13/07) — independente de keyword/idade
          if (usernameEarly && usernameEarly !== account.instagram_username) {
            await mirrorCommentOnly(supabase, {
              tenantId,
              accountId: account.id,
              commentId: cm.id,
              username: usernameEarly,
              igId: cm.from?.id || null,
              text: cm.text || "",
              commentAt: commentAt.toISOString(),
              postPermalink: (c as any).post_permalink || null,
              postCaption: (c as any).post_caption || null,
              postThumb: (c as any).post_thumbnail_url || null,
            });
          }

          // Private reply só funciona até 7 dias — não adianta enfileirar velho
          if (Date.now() - commentAt.getTime() > SEVEN_DAYS_MS) continue;
          // process_existing=false → só comentários feitos DEPOIS da campanha existir
          if (!c.process_existing && commentAt < new Date(c.created_at)) continue;

          const username = usernameEarly;
          // Própria conta comentando/respondendo no post NUNCA vira recipient
          if (username && username === account.instagram_username) continue;
          const status = matchesFilter(c, cm.text || "") ? "pending" : "skipped_keyword";

          // once_per_user: só considera duplicado quem JÁ RECEBEU (ou está a caminho).
          // Antes contava QUALQUER linha — então se o 1º envio falhava, todo comentário
          // seguinte virava skipped_dedup e a pessoa NUNCA recebia o material que pediu
          // (caso lotusmiranda: comentou 5x "Alfredo", não recebeu nada).
          if (status === "pending" && c.once_per_user && username) {
            const { data: dup } = await supabase
              .from("instagram_comment_campaign_recipients")
              .select("id")
              .eq("campaign_id", c.id)
              .eq("commenter_username", username)
              .in("dm_status", ["sent", "pending", "processing"])
              .limit(1);
            if (dup && dup.length > 0) {
              await supabase.from("instagram_comment_campaign_recipients").upsert({
                tenant_id: tenantId,
                campaign_id: c.id,
                comment_id: cm.id,
                commenter_username: username,
                commenter_ig_id: cm.from?.id || null,
                comment_text: cm.text || "",
                comment_at: commentAt.toISOString(),
                dm_status: "skipped_dedup",
              }, { onConflict: "campaign_id,comment_id", ignoreDuplicates: true });
              continue;
            }
          }

          const delayS = c.delay_min_seconds +
            Math.floor(Math.random() * Math.max(1, c.delay_max_seconds - c.delay_min_seconds));

          const { error: insErr, data: ins } = await supabase
            .from("instagram_comment_campaign_recipients")
            .upsert({
              tenant_id: tenantId,
              campaign_id: c.id,
              comment_id: cm.id,
              commenter_username: username,
              commenter_ig_id: cm.from?.id || null,
              comment_text: cm.text || "",
              comment_at: commentAt.toISOString(),
              dm_status: status,
              scheduled_at: new Date(Date.now() + delayS * 1000).toISOString(),
            }, { ignoreDuplicates: true })
            .select("id");
          if (!insErr && ins && ins.length > 0) report.inserted++;
        }
      } catch (e) {
        report.errors.push(`fetch ${c.name}: ${(e as Error).message}`);
      }
    }

    // ══════════ FASE 2: dispatch pendentes vencidos ══════════
    // Recupera zombies: edge morta entre o lock e o update final deixa 'processing'
    // preso pra sempre. >10min em processing (scheduled_at é imutável) = volta pra fila.
    await supabase
      .from("instagram_comment_campaign_recipients")
      .update({ dm_status: "pending" })
      .eq("tenant_id", tenantId)
      .eq("dm_status", "processing")
      .lt("scheduled_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

    const { data: due } = await supabase
      .from("instagram_comment_campaign_recipients")
      .select("*, campaign:instagram_comment_campaigns(*)")
      .eq("tenant_id", tenantId)
      .eq("dm_status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      // Ordem simples de fila. Cada linha carrega o comment_id que a originou,
      // e a resposta publica vai NESSE comentario — o que disparou a campanha.
      // Sem heuristica de "mais recente": com once_per_user a pessoa recebe
      // uma resposta publica + uma DM, ancoradas no comentario que pediu.
      .order("scheduled_at")
      .limit(MAX_SENDS_PER_RUN);

    outer:
    for (const rec of due || []) {
      const c = rec.campaign as Campaign;
      if (!c || (c as any).status !== "active") continue;

      // Lock otimista: pending → processing (evita corrida entre 2 crons)
      const { data: locked } = await supabase
        .from("instagram_comment_campaign_recipients")
        .update({ dm_status: "processing" })
        .eq("id", rec.id)
        .eq("dm_status", "pending")
        .select("id");
      if (!locked || locked.length === 0) continue;

      let agentSessionId: string | null = null;
      // Hoisted: o catch (fallback de comentário apagado) reusa a DM montada no try
      let fullDm = "";
      try {
        // 0. Resolve nome REAL + BIO do comentador (cache → Business Discovery → Graph from.name)
        //    Nome abre a DM ("Opaa Dra. Rosa!"); bio dá o contexto do negócio pro agente.
        let realName = rec.commenter_username || "";
        let commenterBio: string | null = null;
        if (rec.commenter_username) {
          const { data: prof } = await supabase
            .from("instagram_profiles")
            .select("full_name, biography")
            .eq("tenant_id", tenantId)
            .eq("username", rec.commenter_username)
            .maybeSingle();
          let fn = prof?.full_name || "";
          commenterBio = (prof?.biography || "").slice(0, 300) || null;
          if (!fn) {
            // Business Discovery: nome + bio de contas business/creator (pessoal falha silencioso)
            try {
              const bdr = await fetch(
                `${GRAPH}/${account.instagram_business_id}?fields=business_discovery.username(${encodeURIComponent(rec.commenter_username)})%7Bname,biography,followers_count%7D&access_token=${account.access_token}`,
              );
              const bd = bdr.ok ? (await bdr.json())?.business_discovery : null;
              if (bd) {
                fn = bd.name || "";
                commenterBio = (bd.biography || "").slice(0, 300) || null;
                // UNIQUE real: (tenant_id, username) — ver baseline
                await supabase.from("instagram_profiles").upsert({
                  tenant_id: tenantId,
                  username: rec.commenter_username,
                  full_name: bd.name || null,
                  biography: bd.biography || null,
                  follower_count: bd.followers_count ?? null,
                  last_scraped_at: new Date().toISOString(),
                }, { onConflict: "tenant_id,username" });
              }
            } catch { /* segue */ }
          }
          if (!fn) {
            try {
              const pr = await fetch(
                `https://graph.facebook.com/v20.0/${rec.comment_id}?fields=from{id,username,name}&access_token=${readToken}`,
              );
              if (pr.ok) fn = (await pr.json())?.from?.name || "";
            } catch { /* segue com username */ }
          }
          // Sanitiza: corta no | ou - (padrão bio "Nome | Título"), remove emojis, valida
          fn = fn.split(/[|\-–]/)[0].replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim();
          if (fn && !/[\d@]/.test(fn) && fn.length >= 2 && fn.length <= 60) realName = fn;
        }

        // 1. Gera a mensagem
        let dmText = "";

        if (c.reply_mode === "agent" && c.agent_slug) {
          // Modo teste: username fora da allowlist não recebe DM do agente
          if (await agentAllowlistBlocks(supabase, rec.commenter_username, tenantId)) {
            await supabase.from("instagram_comment_campaign_recipients").update({
              dm_status: "skipped_test",
            }).eq("id", rec.id);
            report.skipped++;
            continue;
          }
          // Sessão ÚNICA da pessoa: se ela JÁ está em conversa (comentou em outro
          // post antes), reusa a sessão → o agente tem o histórico e responde com
          // contexto em vez de reabrir frio ("posso te mandar?"). Senão, nova.
          const personSession = await getPersonSession(supabase, rec.commenter_username, tenantId);
          const linkAula = buildAulaLink(materialBase, c, rec.commenter_username); // UTM da campanha + @ pré-preenche a LP
          const run = await runAgent({
            agentSlug: c.agent_slug,
            sessionId: personSession,
            // A sessão do agente é POR PESSOA, então o comentário entra na MESMA
            // thread do direct. Mandar só o texto ("lead") faz o modelo ler como
            // resposta à última pergunta que ele fez no DM — e ele responde
            // "eu tava perguntando outra coisa" em vez de fazer a triagem.
            // A mensagem precisa se auto-identificar; campo de contexto sozinho
            // perde pro fluxo natural da conversa.
            message:
              `[NOVO COMENTÁRIO NO POST — não é resposta no direct]\n` +
              `"${rec.comment_text || "(sem texto)"}"`,
            userId: rec.commenter_username || rec.comment_id,
            context: {
              interaction: "comment_triage",
              source: "instagram_comment_campaign",
              campaign_id: c.id,
              campaign_name: c.name,
              post_caption: captionWindow(c.post_caption),
              comment_real_id: rec.comment_id,
              commenter_username: rec.commenter_username,
              commenter_real_name: realName,
              commenter_bio: commenterBio,
              comment_text: rec.comment_text,
              campaign_material: c.dm_template, // material/link que a campanha promete — entregar SÓ depois que a pessoa responder
              ...(linkAula ? { link_aula: linkAula } : {}), // sem config ig_default_material_link → não injeta
              already_in_conversation: !!personSession, // já em papo → não reabrir frio, continuar com contexto
            },
          });
          dmText = run.text;
          agentSessionId = run.sessionId;

          // [SKIP] = decisão do agente de NÃO mandar DM (comentário social/spam).
          // Respeitar — NÃO cair no fallback template (era o buraco: "[SKIP]" tem
          // 6 chars, passava no guard e ia como DM pro lead).
          if ((dmText || "").trim().toUpperCase().startsWith("[SKIP")) {
            await supabase.from("instagram_comment_campaign_recipients").update({
              dm_status: "skipped_agent",
              agent_session_id: agentSessionId,
            }).eq("id", rec.id);
            report.skipped++;
            continue;
          }

          // Bloco "PÚBLICO: ..." do agente → responde o comentário no post (como o dono da conta)
          const pubBlocks = (dmText || "").split(/\n{2,}/).map((b: string) => b.trim()).filter(Boolean);
          if (pubBlocks.length && /^p[úu]blico\s*:/i.test(pubBlocks[0])) {
            const publicReply = pubBlocks[0].replace(/^p[úu]blico\s*:\s*/i, "").trim();
            dmText = pubBlocks.slice(1).join("\n\n").trim();
            // Flag anti-duplicata: retry pós-zombie NÃO pode repostar a reply pública
            if (publicReply && account.ig_login_token && !rec.public_replied_at) {
              await supabase.from("instagram_comment_campaign_recipients")
                .update({ public_replied_at: new Date().toISOString() }).eq("id", rec.id);
              try {
                const pr = await fetch(`https://graph.instagram.com/v20.0/${rec.comment_id}/replies`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ message: publicReply, access_token: account.ig_login_token }),
                });
                const pd = await pr.json().catch(() => ({}));
                if (!pr.ok) {
                  console.error("public reply failed:", pd?.error?.message);
                  await logSendFailure(supabase, { tenantId, source: "public_reply", username: rec.commenter_username, commentId: rec.comment_id, error: pd?.error || pd });
                }
                else {
                  // Espelha aninhada sob o comentário no inbox
                  const { data: parentMsg } = await supabase
                    .from("instagram_messages")
                    .select("conversation_id")
                    .eq("instagram_message_id", `comment_${rec.comment_id}`)
                    .maybeSingle();
                  if (parentMsg?.conversation_id) {
                    await supabase.from("instagram_messages").insert({
                      tenant_id: tenantId,
                      conversation_id: parentMsg.conversation_id,
                      instagram_message_id: `comment_${pd.id || `reply_${rec.comment_id}_${Date.now()}`}`,
                      content: publicReply,
                      message_type: "comment_reply",
                      is_from_me: true,
                      sender_username: account.instagram_username,
                      status: "sent",
                      sent_at: new Date().toISOString(),
                    });
                  }
                }
              } catch (e) {
                console.error("public reply error:", (e as Error).message);
              }
            }

            // PÚBLICO sem DM = decisão do agente de responder SÓ no post (elogio etc.)
            // NÃO cair no fallback template (reencenaria o caso gabimelodigital).
            if (!dmText) {
              await supabase.from("instagram_comment_campaign_recipients").update({
                dm_status: "sent_public_only",
                agent_session_id: agentSessionId,
              }).eq("id", rec.id);
              report.skipped++;
              continue;
            }
          }

          // Guard: agente vazio/curto/gigante.
          // Fallback template SÓ quando a campanha tem filtro de keyword — com
          // keyword_mode=all o template mandaria material pra QUALQUER comentário
          // (foi o caso gabimelodigital). Sem filtro → falha explícita (failed+retry).
          if (!dmText || dmText.length < 5 || dmText.length > 900) {
            if (c.dm_template && c.keyword_mode !== "all") {
              dmText = renderTemplate(c.dm_template, {
                username: rec.commenter_username || "",
                nome: realName,
                comment_text: rec.comment_text || "",
              });
            } else {
              throw new Error(`agente retornou msg inválida (${(dmText || "").length} chars)`);
            }
          }
        } else {
          if (!c.dm_template) throw new Error("campanha template sem dm_template");
          // Template exige filtro de keyword. Com keyword_mode=all o material iria
          // pra QUALQUER comentário — inclusive elogio e emoji (erro caro em produção:
          // material entregue pra quem só comentou "top demais"). Só o agente pode
          // triar comentário livre; template não tria nada.
          if (c.keyword_mode === "all") {
            await supabase.from("instagram_comment_campaign_recipients").update({
              dm_status: "skipped_keyword",
              dm_error: "campanha em modo template com filtro 'qualquer comentário' — exige palavra-chave ou modo agente",
            }).eq("id", rec.id);
            report.skipped++;
            continue;
          }
          dmText = renderTemplate(c.dm_template, {
            username: rec.commenter_username || "",
            nome: realName,
            comment_text: rec.comment_text || "",
          });
        }

        // 2. REGRA INSTA: pós-comentário só vale a Private Reply (1 única msg por
        //    comment_id) — a janela de 24h ainda não abriu, msgs extras por PSID
        //    não entregam. 1ª DM vai INTEIRA; split fica pras respostas.
        fullDm = dmText.split(/\n{2,}/).map((b: string) => b.trim()).filter(Boolean).slice(0, 4).join("\n\n");
        const sendRes = await fetch(send.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { comment_id: rec.comment_id },
            message: { text: fullDm },
            access_token: send.token,
          }),
        });
        const sendData = await sendRes.json();
        if (!sendRes.ok) {
          throw new Error(sendData?.error?.message || `send ${sendRes.status}`);
        }

        await supabase.from("instagram_comment_campaign_recipients").update({
          dm_status: "sent",
          dm_message: fullDm,
          dm_sent_at: new Date().toISOString(),
          recipient_psid: sendData.recipient_id || null,
          agent_session_id: agentSessionId,
        }).eq("id", rec.id);
        // Fixa a sessão na conversa da pessoa → próxima campanha reusa (contexto).
        if (agentSessionId) await savePersonSession(supabase, rec.commenter_username, agentSessionId, tenantId);
        report.sent++;

        // Espelha comentário + DM no inbox unificado
        if (rec.commenter_username) {
          await mirrorToInbox(supabase, {
            tenantId,
            accountId: account.id,
            accountUsername: account.instagram_username || "",
            leadId: rec.lead_id,
            username: rec.commenter_username,
            commentId: rec.comment_id,
            commentText: rec.comment_text || "",
            commentAt: rec.comment_at,
            dmText: fullDm,
          });
        }
      } catch (e) {
        let errMsg = (e as Error).message;

        // COMENTÁRIO APAGADO — causa nº1 de falha (confirmado 10/08).
        // O filtro anti-spam do IG derruba comentário repetido ("Ferramentas" 2x)
        // e o private reply fica sem âncora. Retry não adianta: o comentário não volta.
        // Mas a pessoa costuma ter OUTRO comentário vivo — usa ele como âncora.
        if (/invalid parameter|does not exist/i.test(errMsg) && rec.commenter_username) {
          try {
            const { data: outros } = await supabase
              .from("instagram_comment_campaign_recipients")
              .select("comment_id")
              .eq("tenant_id", tenantId)
              .ilike("commenter_username", rec.commenter_username)
              .neq("comment_id", rec.comment_id)
              .gte("comment_at", new Date(Date.now() - 6.5 * 86400_000).toISOString()) // dentro dos 7d da Meta
              .order("comment_at", { ascending: false })
              .limit(5);

            for (const alt of outros || []) {
              const chk = await fetch(`${GRAPH}/${alt.comment_id}?fields=id&access_token=${readToken}`);
              if (!chk.ok) continue;  // esse também sumiu
              const r2 = await fetch(send.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  recipient: { comment_id: alt.comment_id },
                  message: { text: fullDm },
                  access_token: send.token,
                }),
              });
              const d2 = await r2.json();
              if (r2.ok && d2.recipient_id) {
                await supabase.from("instagram_comment_campaign_recipients").update({
                  dm_status: "sent",
                  dm_message: fullDm,
                  dm_sent_at: new Date().toISOString(),
                  recipient_psid: d2.recipient_id,
                  agent_session_id: agentSessionId,
                  dm_error: `entregue via comentário alternativo ${alt.comment_id} (o original sumiu)`,
                }).eq("id", rec.id);
                report.sent++;
                console.log(`↩️ ${rec.commenter_username}: original apagado, entregue pelo comentário ${alt.comment_id}`);
                continue outer;
              }
            }
            errMsg = `${errMsg} (comentário apagado e nenhum alternativo vivo)`;
          } catch (e2) {
            console.warn("[fallback comentário] falhou:", e2);
          }
        }

        await logSendFailure(supabase, {
          tenantId,
          source: "campaign_private_reply",
          username: rec.commenter_username,
          commentId: rec.comment_id,
          error: errMsg,
          attempt: (rec.retry_count || 0) + 1,
        });
        // Erro de política Meta (private reply já usada, janela, permissão) = terminal.
        // Resto (timeout, 5xx do runner, rede) = transiente → re-agenda até 3x.
        const isMetaPolicy = /\(#|janela|access token|permission/i.test(errMsg);
        const retries = (rec.retry_count || 0) + 1;
        if (!isMetaPolicy && retries <= 3) {
          await supabase.from("instagram_comment_campaign_recipients").update({
            dm_status: "pending",
            retry_count: retries,
            dm_error: `retry ${retries}/3: ${errMsg.slice(0, 400)}`,
            scheduled_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            agent_session_id: agentSessionId,
          }).eq("id", rec.id);
        } else {
          await supabase.from("instagram_comment_campaign_recipients").update({
            dm_status: "failed",
            dm_error: errMsg.slice(0, 500),
            agent_session_id: agentSessionId,
          }).eq("id", rec.id);
        }
        report.failed++;
        report.errors.push(`send @${rec.commenter_username}: ${errMsg}`);
      }
    }

    // ══════════ Atualiza stats das campanhas tocadas ══════════
    for (const c of (campaigns || []) as Campaign[]) {
      const { data: agg } = await supabase.rpc("instagram_campaign_stats", { p_campaign_id: c.id }).maybeSingle?.() ?? { data: null };
      if (agg) {
        await supabase.from("instagram_comment_campaigns").update({ stats: agg, updated_at: new Date().toISOString() }).eq("id", c.id);
      }
    }
  }
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
