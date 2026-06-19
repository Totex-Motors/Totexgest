/**
 * agent-platform.ts (Cloud API) — roteia mensagens da WhatsApp Cloud API pra
 * Plataforma de Agentes V2.
 *
 * Espelha o `whatsapp-webhook/agent-platform.ts` (UAZAPI), com UMA diferença:
 * o ENVIO da resposta é feito via edge fn `send-whatsapp-cloud` (action send_text),
 * não pelo /send/text da UAZAPI. Receber/rotear/autorizar/sessão são idênticos.
 *
 * Retorna true se a mensagem FOI tratada pela V2 (caller NÃO segue o fluxo legado).
 * Retorna false se não tratou (segue legado ai_sales_agents intacto).
 *
 * GATED por config.agent_platform_v2_enabled — off = sempre false = legado.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export async function tryHandleViaAgentPlatformCloud(args: {
  supabase: any;
  instanceId: string;
  senderPhone: string;
  text: string;
  messageId: string | null;
  leadId?: string | null;
  /** Tenant dono da instância oficial (whatsapp_instances.tenant_id). */
  tenantId?: string | null;
}): Promise<boolean> {
  const { supabase, instanceId, senderPhone, text, messageId, leadId, tenantId } = args;
  if (!text || !text.trim()) return false;

  // Multi-tenant: sem o tenant da instância não roteamos.
  if (!tenantId) { console.error("[cloud-v2] sem tenantId da instância — pula V2"); return false; }

  // 1. Flag global — off = legado
  const { data: cfgRow } = await supabase
    .from("config").select("value").eq("key", "agent_platform_v2_enabled").maybeSingle();
  let v2Enabled = false;
  try { v2Enabled = JSON.parse(cfgRow?.value ?? "{}").enabled === true; } catch { /* off */ }
  if (!v2Enabled) return false;

  // 2. Lookup deployment (instância + palavra-chave), escopado ao tenant
  const { data: routeRows, error: routeErr } = await supabase.rpc("agent_route_lookup", {
    p_channel: "whatsapp",
    p_instance_id: instanceId,
    p_ctx: { text },
    p_tenant_id: tenantId,
  });
  if (routeErr) { console.error("[cloud-v2] route err:", routeErr.message); return false; }
  const match = Array.isArray(routeRows) ? routeRows[0] : routeRows;
  if (!match || !match.agent_slug) return false; // nenhum agente V2 nessa instância → legado

  // 3. Config do deployment → autorização
  const { data: dep } = await supabase
    .from("agents_deployments").select("config").eq("id", match.deployment_id).maybeSingle();
  const cfg = (dep?.config || {}) as Record<string, any>;
  const accessMode: string = cfg.access_mode || "open";
  const senderDigits = onlyDigits(senderPhone);

  // Marca a origem do lead (ex: stand → source='stand') já na 1ª mensagem.
  if (cfg.lead_source && leadId) {
    await supabase.from("leads").update({ source: String(cfg.lead_source) }).eq("id", leadId);
  }

  if (accessMode === "private") {
    const authorized: string[] = (cfg.authorized_numbers || []).map((n: string) => onlyDigits(String(n))).filter(Boolean);
    const ok = authorized.some((a) => a && (senderDigits.endsWith(a) || a.endsWith(senderDigits)));
    if (!ok) {
      if (cfg.unauthorized_message) await sendCloud(senderDigits, String(cfg.unauthorized_message), tenantId, leadId);
      console.log(`[cloud-v2] número ${senderDigits} não autorizado (agente ${match.agent_slug}, modo private)`);
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
        provider_state: { external_session_key: sessionKey, whatsapp_phone: senderDigits },
      }).select("id").single();
    sessionId = ns?.id;
  }

  // 4.5 Debounce via banco (latest-wins): agrupa as mensagens rápidas do cliente numa
  //     resposta só. Cada msg chega como uma invocação SEPARADA do webhook (isolates
  //     diferentes) → 3 msgs = 3 respostas robotizadas. Por isso o debounce é via banco.
  let messageToSend = text;
  if (leadId) {
    const deb = await debounceInbound(supabase, leadId, messageId, sessionId);
    if (!deb) {
      console.log("[cloud-v2] follower (debounce DB) — msg mais nova assumiu, sem resposta");
      return true; // não sou o líder → a última mensagem da janela responde por todas
    }
    if (deb.combinedText) messageToSend = deb.combinedText;
  }

  // 5. Chama agent-runner e lê o SSE
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
          instance_id: instanceId,
          whatsapp_phone: senderDigits,
          recipient: senderDigits,
          message_id: messageId,
          lead_id: leadId || null,
        },
      }),
    });
    // Follower do debounce: o leader responde por todas as msgs da janela → aqui não envia nada.
    if (res.status === 204) {
      console.log("[cloud-v2] follower (debounce) — sem resposta nesta msg");
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
    console.error("[cloud-v2] agent-runner err:", (e as Error).message);
    await sendCloud(senderDigits, "⚠️ Tive um problema técnico. Tenta de novo daqui a pouco?", tenantId, leadId);
    return true;
  }

  // 5.5 A geração pode demorar (tool calls). Se nesse meio tempo chegou mensagem mais nova,
  //     ABORTA o envio — a invocação dela responde por todas. Evita duas respostas saindo
  //     ao mesmo tempo e intercalando as bolhas.
  if (leadId && await hasNewerInbound(supabase, leadId, messageId)) {
    console.log("[cloud-v2] msg mais nova durante a geração — aborta envio (evita intercalar)");
    return true;
  }

  // 6. Envia resposta via Cloud API em bolhas curtas, com delay (mais natural).
  const finalText = fullText.trim() || "Desculpa, não consegui processar agora.";
  const parts = splitForWhatsApp(finalText, 280);
  for (let i = 0; i < parts.length; i++) {
    await sendCloud(senderDigits, parts[i], tenantId, leadId);
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

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function onlyDigits(s: string): string { return String(s).replace(/\D/g, ""); }

/** Envia texto livre via edge fn send-whatsapp-cloud (action send_text). */
async function sendCloud(phone: string, text: string, tenantId: string | null, leadId?: string | null): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}`, "apikey": SERVICE_KEY },
      body: JSON.stringify({
        action: "send_text",
        phone: onlyDigits(phone),
        text,
        tenant_id: tenantId,
        lead_id: leadId || null,
        sent_by: "ai_agent_v2",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[cloud-v2] send-whatsapp-cloud ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (e) { console.error("[cloud-v2] sendCloud err:", (e as Error).message); }
}

/**
 * Quebra a resposta em bolhas curtas (parágrafo → frase até `max`); listas ficam juntas.
 */
function splitForWhatsApp(text: string, max: number): string[] {
  const out: string[] = [];
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const para of paras) {
    const isList = /(^|\n)\s*(\d+[.)]|[-*•])\s+/.test(para);
    if (isList || para.length <= max) { out.push(para); continue; }
    let cur = "";
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      if (cur && (cur + " " + sentence).length > max) { out.push(cur.trim()); cur = sentence; }
      else cur = cur ? cur + " " + sentence : sentence;
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out.length ? out : [text];
}
