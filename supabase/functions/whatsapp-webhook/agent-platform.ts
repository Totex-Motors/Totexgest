/**
 * agent-platform.ts — roteia mensagens UAZAPI pra Plataforma de Agentes V2.
 *
 * Espelha o telegram-webhook: lookup deployment (instância + palavra-chave) → autorização
 * (access_mode + whitelist) → chama agent-runner (lê o SSE) → envia resposta via UAZAPI.
 *
 * Retorna true se a mensagem FOI tratada pela V2 (o caller NÃO segue o fluxo legado).
 * Retorna false se não tratou (segue legado ai-sales-agent intacto).
 *
 * GATED pela flag config.agent_platform_v2_enabled — off = sempre false = legado.
 * Instâncias SEM deployment V2 ativo nunca casam → legado intacto.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

interface InstanceLike {
  id: string;
  api_url?: string | null;
  api_key?: string | null;
}

export async function tryHandleViaAgentPlatform(args: {
  supabase: any;
  instance: InstanceLike;
  senderPhone: string;
  text: string;
  messageId: string | null;
  leadId?: string | null;
  /** Loja dona da instância (whatsapp_instances.tenant_id). Escopa o roteamento + o runner. */
  tenantId?: string | null;
}): Promise<boolean> {
  const { supabase, instance, senderPhone, text, messageId, leadId, tenantId } = args;
  if (!text || !text.trim()) return false;
  // Ignora placeholders de mídia que não viraram texto/transcrição
  if (text === "[Mídia]") return false;

  // Multi-tenant: sem o tenant da instância não roteamos (senão casaria deployment
  // de outra loja na mesma instância / agente errado).
  if (!tenantId) { console.error("[wpp-v2] sem tenantId da instância — pula V2"); return false; }

  // 1. Flag global — off = legado (config.value é TEXT, precisa parse)
  const { data: cfgRow } = await supabase
    .from("config").select("value").eq("key", "agent_platform_v2_enabled").maybeSingle();
  let v2Enabled = false;
  try { v2Enabled = JSON.parse(cfgRow?.value ?? "{}").enabled === true; } catch { /* off */ }
  if (!v2Enabled) return false;

  // 2. Lookup deployment (instância + palavra-chave via agent_route_lookup), escopado ao tenant
  const { data: routeRows, error: routeErr } = await supabase.rpc("agent_route_lookup", {
    p_channel: "whatsapp",
    p_instance_id: instance.id,
    p_ctx: { text },
    p_tenant_id: tenantId,
  });
  if (routeErr) { console.error("[wpp-v2] route err:", routeErr.message); return false; }
  const match = Array.isArray(routeRows) ? routeRows[0] : routeRows;
  if (!match || !match.agent_slug) return false; // nenhum agente V2 nessa instância → legado

  // 3. Config do deployment → autorização
  const { data: dep } = await supabase
    .from("agents_deployments").select("config").eq("id", match.deployment_id).maybeSingle();
  const cfg = (dep?.config || {}) as Record<string, any>;
  const accessMode: string = cfg.access_mode || "open";
  const senderDigits = onlyDigits(senderPhone);

  // Marca a origem do lead (ex: deployment do stand → source='stand') já na 1ª mensagem,
  // pra ele aparecer na aba dedicada. Genérico: qualquer deployment pode definir lead_source.
  if (cfg.lead_source && leadId) {
    await supabase.from("leads").update({ source: String(cfg.lead_source) }).eq("id", leadId);
  }

  // Resolve host (api_url) + token da instância pra enviar via UAZAPI (genérico: qualquer host)
  let inst = instance;
  if (!inst.api_url || !inst.api_key) {
    const { data: row } = await supabase
      .from("whatsapp_instances").select("api_url, api_key").eq("id", instance.id).maybeSingle();
    inst = { id: instance.id, api_url: instance.api_url || row?.api_url, api_key: instance.api_key || row?.api_key };
  }

  if (accessMode === "private") {
    const authorized: string[] = (cfg.authorized_numbers || []).map((n: string) => onlyDigits(String(n))).filter(Boolean);
    const ok = authorized.some((a) => a && (senderDigits.endsWith(a) || a.endsWith(senderDigits)));
    if (!ok) {
      // Não autorizado: manda msg padrão (se configurada) e marca como TRATADO (não cai no legado)
      if (cfg.unauthorized_message) await sendUazapi(inst, senderDigits, String(cfg.unauthorized_message));
      console.log(`[wpp-v2] número ${senderDigits} não autorizado (agente ${match.agent_slug}, modo private)`);
      return true;
    }
  }

  // 4. Sessão (1 por número + agente)
  const sessionKey = `whatsapp:${senderDigits}`;
  let sessionId: string | undefined;
  const { data: existing } = await supabase
    .from("agents_sessions").select("id")
    .eq("agent_id", match.agent_id).eq("channel", "whatsapp")
    .contains("provider_state", { external_session_key: sessionKey })
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  sessionId = existing?.id;
  if (!sessionId) {
    const { data: ns } = await supabase
      .from("agents_sessions").insert({
        tenant_id: tenantId,
        agent_id: match.agent_id, channel: "whatsapp",
        title: `WhatsApp ${senderDigits}`,
        provider_state: { external_session_key: sessionKey, whatsapp_phone: senderDigits, whatsapp_instance_id: instance.id },
      }).select("id").single();
    sessionId = ns?.id;
  }

  // 4.5 Debounce via banco (latest-wins): agrupa as mensagens rápidas do cliente numa
  //     resposta só. Sem isso, cada mensagem chega como uma invocação SEPARADA do webhook
  //     (isolates diferentes) → 3 msgs = 3 respostas robotizadas. O debounce in-memory do
  //     runner não resolve (não compartilha estado entre isolates) — daí ser via banco.
  let messageToSend = text;
  if (leadId) {
    const deb = await debounceInbound(supabase, leadId, messageId, sessionId);
    if (!deb) {
      console.log("[wpp-v2] follower (debounce DB) — msg mais nova assumiu, sem resposta");
      return true; // não sou o líder → a última mensagem da janela responde por todas
    }
    if (deb.combinedText) messageToSend = deb.combinedText;
  }

  // 5. Chama agent-runner e lê o SSE (igual telegram-webhook)
  let fullText = "";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
      body: JSON.stringify({
        agent_slug: match.agent_slug,
        channel: "whatsapp",
        session_id: sessionId,
        message: messageToSend,
        user_id: null,
        tenant_id: tenantId,
        context: {
          instance_id: instance.id,
          whatsapp_phone: senderDigits,
          recipient: senderDigits,
          message_id: messageId,
          lead_id: leadId || null,  // lead já criado pelo webhook — agente usa pra agendar/qualificar
        },
      }),
    });
    // Follower do debounce: outra invocação (leader) vai responder por todas as msgs
    // da janela. Aqui não enviamos NADA (senão o lead recebe resposta duplicada).
    if (res.status === 204) {
      console.log("[wpp-v2] follower (debounce) — sem resposta nesta msg");
      return true;
    }
    if (!res.ok || !res.body) throw new Error(`agent-runner ${res.status}`);

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
        try { const d = JSON.parse(dl.slice(5).trim()); if (d.type === "text.delta") fullText += d.delta; } catch { /* ignore */ }
      }
    }
  } catch (e) {
    console.error("[wpp-v2] agent-runner err:", (e as Error).message);
    await sendUazapi(inst, senderDigits, "⚠️ Tive um problema técnico. Tenta de novo daqui a pouco?");
    return true;
  }

  // 5.5 A geração pode demorar (tool calls). Se nesse meio tempo chegou mensagem mais nova,
  //     ABORTA o envio — a invocação dela responde por todas. Evita duas respostas saindo
  //     ao mesmo tempo e intercalando as bolhas (o sintoma que o cliente via).
  if (leadId && await hasNewerInbound(supabase, leadId, messageId)) {
    console.log("[wpp-v2] msg mais nova durante a geração — aborta envio (evita intercalar)");
    return true;
  }

  // 6. Envia resposta via UAZAPI quebrada em bolhas curtas (mais natural no WhatsApp),
  //    com um pequeno delay entre elas. Remove antes o raciocínio interno (<thinking>)
  //    que o modelo às vezes emite no texto antes de chamar uma tool.
  const finalText = stripThinking(fullText) || "Desculpa, não consegui processar agora.";
  const parts = splitForWhatsApp(finalText, 280);
  for (let i = 0; i < parts.length; i++) {
    await sendUazapi(inst, senderDigits, parts[i]);
    if (i < parts.length - 1) await sleep(700 + Math.floor(Math.random() * 900));
  }
  // Marca o piso do próximo debounce — só as msgs DEPOIS desta resposta serão reagrupadas.
  await markReplied(supabase, sessionId);
  return true;
}

/** Segundos de espera do debounce — junta as mensagens rápidas do cliente numa só. */
const DEBOUNCE_SECONDS = 8;

/**
 * Debounce via banco (latest-wins) p/ WhatsApp. Espera DEBOUNCE_SECONDS; se nesse meio
 * tempo chegou uma mensagem MAIS NOVA deste lead, esta invocação não é a líder → retorna
 * null (não responde). A líder junta todas as mensagens do cliente ainda não respondidas
 * (desde a última resposta do bot) num texto único, mandado de uma vez pro agente.
 * Ordenação por `created_at` (monotônico por insert) — `sent_at` é por segundo do provider
 * e empata. Apoia-se na `whatsapp_messages`, que grava todo inbound antes do roteador V2.
 */
async function debounceInbound(
  supabase: any,
  leadId: string,
  messageId: string | null,
  sessionId: string | undefined,
): Promise<{ combinedText: string } | null> {
  await sleep(DEBOUNCE_SECONDS * 1000);
  if (await hasNewerInbound(supabase, leadId, messageId)) return null; // não sou líder

  // Piso = última resposta do bot (provider_state.last_reply_at); se null, abre na criação
  // da sessão (-60s de folga) — pega o burst inteiro sem capturar mensagens de antes dela.
  let floor: string | null = null;
  if (sessionId) {
    const { data: sess } = await supabase
      .from("agents_sessions").select("provider_state, created_at").eq("id", sessionId).maybeSingle();
    floor = (sess?.provider_state as any)?.last_reply_at
      || (sess?.created_at ? new Date(new Date(sess.created_at).getTime() - 60000).toISOString() : null);
  }

  let q = supabase
    .from("whatsapp_messages")
    .select("content")
    .eq("lead_id", leadId).eq("is_from_me", false)
    .order("created_at", { ascending: true });
  if (floor) q = q.gt("created_at", floor);
  const { data: rows } = await q;
  const contents = (rows || [])
    .map((r: any) => String(r.content || "").trim())
    .filter((c: string) => c && c !== "[Mídia]");
  return { combinedText: contents.join("\n") };
}

/** True se já existe um inbound deste lead MAIS NOVO que `messageId` (não sou o líder). */
async function hasNewerInbound(supabase: any, leadId: string, messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const { data: latest } = await supabase
    .from("whatsapp_messages")
    .select("message_id")
    .eq("lead_id", leadId).eq("is_from_me", false)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return !!(latest?.message_id && latest.message_id !== messageId);
}

/** Grava o instante da resposta no provider_state (merge) — piso do próximo debounce. */
async function markReplied(supabase: any, sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  const { data: sess } = await supabase
    .from("agents_sessions").select("provider_state").eq("id", sessionId).maybeSingle();
  const ps = (sess?.provider_state || {}) as Record<string, any>;
  ps.last_reply_at = new Date().toISOString();
  await supabase.from("agents_sessions").update({ provider_state: ps }).eq("id", sessionId);
}

function onlyDigits(s: string): string { return String(s).replace(/\D/g, ""); }

async function sendUazapi(instance: InstanceLike, number: string, text: string): Promise<void> {
  // api_url vem da tabela de instâncias — NUNCA hardcode de URL UAZAPI (regra do projeto)
  const base = (instance.api_url || "").replace(/\/$/, "");
  if (!base) {
    console.error("[wpp-v2] sendUazapi: instance.api_url vazio — configure a URL da instância");
    return;
  }
  try {
    await fetch(`${base}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": instance.api_key || "" },
      body: JSON.stringify({ number: onlyDigits(number), text }),
    });
  } catch (e) { console.error("[wpp-v2] sendUazapi err:", (e as Error).message); }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Remove o raciocínio interno do modelo (<thinking>...</thinking> e variações) que às vezes
 * vaza no texto antes de uma tool call — NUNCA deve ir pro cliente. Trata bloco fechado,
 * bloco aberto sem fechar (stream que termina dentro do raciocínio) e tags soltas.
 */
function stripThinking(text: string): string {
  return String(text || "")
    .replace(/<(thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, "") // bloco fechado
    .replace(/<(thinking|thought|reasoning)>[\s\S]*$/gi, "")        // aberto e não fechado
    .replace(/<\/?(thinking|thought|reasoning)>/gi, "")             // tag solta residual
    .trim();
}

/**
 * Quebra a resposta em bolhas curtas pra parecer conversa natural no WhatsApp.
 * Cada parágrafo vira uma bolha; parágrafos longos são divididos por frase até `max`.
 * Listas numeradas/bullets são mantidas juntas (não quebra item a item).
 */
function splitForWhatsApp(text: string, max: number): string[] {
  const out: string[] = [];
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const para of paras) {
    // Mantém listas inteiras numa bolha só
    const isList = /(^|\n)\s*(\d+[.)]|[-*•])\s+/.test(para);
    if (isList || para.length <= max) { out.push(para); continue; }
    // Parágrafo longo → quebra por frase, agrupando até `max`
    let cur = "";
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if (cur && (cur + " " + sentence).length > max) { out.push(cur.trim()); cur = sentence; }
      else cur = cur ? cur + " " + sentence : sentence;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length ? out : [text];
}
