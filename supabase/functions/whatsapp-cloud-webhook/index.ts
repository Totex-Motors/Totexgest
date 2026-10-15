import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { tryHandleViaAgentPlatformCloud } from "./agent-platform.ts";
import { getIntegrationKey } from "../_shared/config.ts";

/**
 * WhatsApp Cloud API Webhook
 * Recebe mensagens e status updates da Meta Cloud API.
 *
 * Configurar na Meta:
 * - Webhook URL: https://YOUR_PROJECT_REF.supabase.co/functions/v1/whatsapp-cloud-webhook
 * - Verify Token: YOUR_VERIFY_TOKEN
 * - Campos: messages, message_status
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_CLOUD_VERIFY_TOKEN") || "";
const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_CLOUD_API_TOKEN") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";

Deno.serve(async (req) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ========== WEBHOOK VERIFICATION (GET) ==========
  // Meta envia GET com hub.mode, hub.verify_token, hub.challenge pra validar o webhook
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    // Verify token vem da config global (tela API Keys) com fallback pro secret.
    let expected = VERIFY_TOKEN;
    try {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await sb.from("config").select("value").eq("key", "WHATSAPP_CLOUD_VERIFY_TOKEN").maybeSingle();
      if (data?.value && String(data.value).trim()) expected = String(data.value).trim();
    } catch (_e) { /* usa o env */ }

    if (mode === "subscribe" && token === expected && expected) {
      console.log("[Cloud Webhook] Verification successful");
      return new Response(challenge, { status: 200 });
    }

    console.error("[Cloud Webhook] Verification failed — invalid token");
    return new Response("Forbidden", { status: 403 });
  }

  // ========== WEBHOOK EVENTS (POST) ==========
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();

    // Meta envelopa em object.entry[].changes[].value
    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value;
        if (!value) continue;

        const metadata = value.metadata;
        const phoneNumberId = metadata?.phone_number_id;

        // Buscar instância oficial pelo phone_number_id
        const { data: instance } = await supabase
          .from("whatsapp_instances")
          .select("id, name, tenant_id")
          .eq("metadata->>phone_number_id", phoneNumberId)
          .maybeSingle();

        // Fallback: buscar por nome
        const fallback = instance ? null : await getOfficialInstance(supabase);
        const instanceId = instance?.id || fallback?.id || null;
        const instanceTenantId = instance?.tenant_id || fallback?.tenant_id || null;

        // ===== MENSAGENS RECEBIDAS =====
        if (value.messages) {
          for (const msg of value.messages) {
            await handleIncomingMessage(supabase, msg, value.contacts, instanceId, instanceTenantId);
          }
        }

        // ===== STATUS UPDATES (sent, delivered, read) =====
        if (value.statuses) {
          for (const status of value.statuses) {
            await handleStatusUpdate(supabase, status, instanceId);
          }
        }
      }
    }

    // Meta espera 200 sempre — se retornar erro, reenvia
    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[Cloud Webhook] Error:", err.message);
    // Retornar 200 mesmo com erro pra Meta não reenviar infinitamente
    return new Response(JSON.stringify({ received: true, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ==================== HANDLE INCOMING MESSAGE ====================

async function handleIncomingMessage(supabase: any, msg: any, contacts: any[], instanceId: string | null, tenantId: string | null) {
  // Tenant DONO da instância (número oficial). O agente central (agente-stand) é
  // deployado aqui — o roteador V2 precisa deste tenant, NÃO do tenant do lead
  // (que vira a loja após a distribuição). Sem isso, lead em loja = agente mudo.
  const instanceTenantId = tenantId;
  const from = msg.from; // número do lead (ex: 5531999999999)
  const msgId = msg.id; // wamid.xxxxx
  const timestamp = msg.timestamp; // unix timestamp
  const msgType = msg.type; // text, image, audio, video, document, reaction, etc

  // Extrair conteúdo baseado no tipo
  let content = "";
  let mediaUrl = null;
  let messageType = "Conversation";
  // Eventos de SISTEMA (ex.: resposta à permissão de ligação) ficam no histórico mas
  // NÃO viram "fala do cliente" pros agentes — senão o agente de texto responde
  // "anotado, um especialista vai te ligar" e atropela a ligação da Nina.
  let skipAgents = false;

  switch (msgType) {
    case "text":
      content = msg.text?.body || "";
      break;
    case "image":
      content = msg.image?.caption || "[Imagem]";
      mediaUrl = msg.image?.id; // Media ID — precisa buscar URL depois
      messageType = "image";
      break;
    case "audio":
      content = "[Áudio]";
      mediaUrl = msg.audio?.id;
      messageType = "audio";
      break;
    case "video":
      content = msg.video?.caption || "[Vídeo]";
      mediaUrl = msg.video?.id;
      messageType = "video";
      break;
    case "document":
      content = msg.document?.caption || `[Documento: ${msg.document?.filename || ""}]`;
      mediaUrl = msg.document?.id;
      messageType = "document";
      break;
    case "sticker":
      content = "[Sticker]";
      messageType = "sticker";
      break;
    case "reaction":
      // Reações não são mensagens — tratar separadamente se necessário
      console.log(`[Cloud Webhook] Reaction from ${from}: ${msg.reaction?.emoji}`);
      return;
    case "button":
      // resposta a template com QUICK_REPLY (ex.: pausa_conversa fora da janela)
      content = msg.button?.text || "[Botão]";
      if (await handlePausaReply(supabase, from.replace(/\D/g, ""), String(msg.button?.payload || msg.button?.text || ""))) { skipAgents = true; messageType = "pausa_reply"; }
      break;
    case "interactive":
      if (msg.interactive?.type === "call_permission_reply" || msg.interactive?.call_permission_reply) {
        // Resposta ao pedido de permissão pra LIGAR (Nina — Fase B). Guarda no lead e libera a fila.
        const cpr = msg.interactive.call_permission_reply || {};
        const accepted = String(cpr.response || "").toLowerCase() === "accept";
        const expiresAt = cpr.expiration_timestamp ? new Date(Number(cpr.expiration_timestamp) * 1000).toISOString() : null;
        content = accepted ? `✅ Permitiu ligação${cpr.is_permanent ? " (permanente)" : expiresAt ? ` até ${new Date(expiresAt).toLocaleDateString("pt-BR")}` : ""}` : "❌ Não permitiu ligação";
        messageType = "call_permission_reply";
        skipAgents = true;
        try {
          await handleCallPermissionReply(supabase, from.replace(/\D/g, ""), { accepted, expiresAt, isPermanent: !!cpr.is_permanent, source: cpr.response_source || null });
        } catch (e) { console.error("[Cloud Webhook] call_permission_reply:", (e as Error).message); }
      } else {
        content = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interativo]";
        // botões da mensagem de PAUSA (follow-up automático): "Encerrar" e "Me chama outro dia" são
        // tratados pelo sistema; "Continuar" segue pro agente como texto normal.
        const bid = String(msg.interactive?.button_reply?.id || "");
        if (await handlePausaReply(supabase, from.replace(/\D/g, ""), bid || content)) { skipAgents = true; messageType = "pausa_reply"; }
      }
      break;
    default:
      content = `[${msgType}]`;
  }

  // Nome do contato (Meta envia no array contacts)
  const contactName = contacts?.find((c: any) => c.wa_id === from)?.profile?.name || from;
  const cleanPhone = from.replace(/\D/g, "");

  // Se tem mídia, baixar e armazenar no Storage
  let storedMediaUrl: string | null = null;
  if (mediaUrl) {
    storedMediaUrl = await downloadAndStoreMedia(supabase, mediaUrl, msgType, instanceTenantId);
  }

  // Transcrever áudio com Whisper pra o agente poder ler.
  // Chave via getIntegrationKey (Integrações da loja → config → env) — o env puro estava
  // vazio em produção e o agente recebia só "[Áudio]" ("não consegui ouvir").
  const openaiKey = msgType === "audio" && storedMediaUrl
    ? (await getIntegrationKey(supabase, "OPENAI_API_KEY", instanceTenantId)) || OPENAI_API_KEY
    : null;
  if (msgType === "audio" && storedMediaUrl && openaiKey) {
    const transcription = await transcribeAudio(supabase, storedMediaUrl, openaiKey);
    if (transcription) {
      content = transcription;
      console.log(`[Cloud Webhook] Audio transcribed: "${transcription.substring(0, 80)}"`);
    }
  }

  console.log(`[Cloud Webhook] Message from ${contactName} (${cleanPhone}): "${content.substring(0, 50)}"${storedMediaUrl ? ` [media: ${storedMediaUrl}]` : ''}`);

  // Deduplicação: checar se já existe msg com esse message_id
  const { data: existing } = await supabase
    .from("whatsapp_messages")
    .select("id")
    .eq("message_id", msgId)
    .maybeSingle();

  if (existing) {
    console.log(`[Cloud Webhook] Duplicate message ${msgId} — skipping`);
    return;
  }

  // === ROTEAMENTO MULTI-TENANT (número oficial COMPARTILHADO entre lojas) ===
  // Com um único número oficial servindo várias lojas, a resposta do cliente cai
  // no tenant do lead dele — a loja que recebeu o lead na distribuição. A regra é
  // "lead mais recente daquele telefone": a distribuição cria o lead na loja DEPOIS
  // do lead de origem (master), então o mais recente é o da loja. Sem lead em
  // nenhum tenant → tenant da instância oficial (master, 1º contato / IA central).
  const last8 = cleanPhone.slice(-8);
  let routedTenantId = tenantId;

  // Botão do WhatsApp do site: o clique criou um lead SEM telefone ("Cliente (não identificado)");
  // a mensagem é a 1ª vez que o número aparece → funde o clique com este número ANTES do roteamento.
  try { await absorbMarketplaceClick(supabase, cleanPhone, contactName, content); } catch (e) { console.error("[Cloud Webhook] clique do site:", (e as Error).message); }

  const { data: lead } = await supabase
    .from("leads")
    .select("id, tenant_id")
    .ilike("phone", `%${last8}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let finalLeadId = lead?.id || null;
  if (lead?.tenant_id) routedTenantId = lead.tenant_id;

  // Se não encontrou lead em nenhum tenant, cria no tenant da instância (master) pela
  // porta única (passo 2 — docs/ENTRADAS-DE-LEADS.md): dedupe por telefone dentro do
  // tenant + trava anti-corrida (duas mensagens seguidas do mesmo número = 1 lead).
  if (!finalLeadId) {
    if (!routedTenantId) {
      console.error(`[Cloud Webhook] Sem tenant pra criar o lead de ${cleanPhone} (instância sem tenant) — mensagem salva sem lead`);
    } else {
      const { data: foc, error: focErr } = await supabase.rpc("find_or_create_lead", {
        p_tenant: routedTenantId,
        p_phone: cleanPhone,
        p_name: contactName !== cleanPhone ? contactName : null,
        p_source: "whatsapp",
        p_lead_kind: "buyer",
        p_metadata: {},
      });
      if (focErr) console.error(`[Cloud Webhook] find_or_create_lead err:`, focErr.message);
      finalLeadId = foc?.lead_id || null;
      console.log(`[Cloud Webhook] ${foc?.created ? "Created new" : "Reused"} lead: ${finalLeadId} (tenant ${routedTenantId})`);
    }
  }

  // Daqui pra frente o tenant é o do lead ROTEADO (não o da instância oficial),
  // pra mensagem, inbox e agente caírem na loja certa.
  tenantId = routedTenantId;

  // Salvar mensagem
  const sentAt = timestamp ? new Date(parseInt(timestamp) * 1000).toISOString() : new Date().toISOString();

  const { error } = await supabase.from("whatsapp_messages").insert({
    instance_id: instanceId,
    remote_jid: `${cleanPhone}@s.whatsapp.net`,
    message_id: msgId,
    message_type: messageType,
    content,
    is_from_me: false,
    sent_at: sentAt,
    sender_name: contactName,
    sender_phone: cleanPhone,
    lead_id: finalLeadId,
    media_url: storedMediaUrl || null,
    ...(tenantId ? { tenant_id: tenantId } : {}),
    metadata: { source: "cloud_api", original_type: msgType, cloud_media_id: mediaUrl || null },
  });

  if (error) {
    console.error(`[Cloud Webhook] Error saving message:`, error.message);
    return;
  }

  // === GATILHO DE DISTRIBUIÇÃO (piloto multi-loja) ===
  // A mensagem do QR/totem (ou do vendedor/promotora) já nomeia a loja, ex.:
  // "...vi o veículo BMW M 135i da loja PG Motors no Totem...". Casa o nome da
  // loja com um tenant que participa da distribuição (destino de handoff ativo)
  // e, se for diferente da loja atual do lead, distribui (cria o lead na loja +
  // avisa o grupo dela). Idempotente e nunca quebra o fluxo do webhook.
  if (content && content.trim() && finalLeadId) {
    try {
      const targetTenant = await matchStoreTenant(supabase, content);
      if (targetTenant && targetTenant !== tenantId) {
        await fetch(`${SUPABASE_URL}/functions/v1/distribuir-lead`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lead_id: finalLeadId, target_tenant_id: targetTenant, motivo: content.slice(0, 160) }),
        });
      }
    } catch (e) {
      console.error("[Cloud Webhook] gatilho de distribuição:", (e as Error).message);
    }
  }

  // === ROTEADOR V2 (Plataforma de Agentes) — PORTEIRO ===
  // Gated por config.agent_platform_v2_enabled (off = legado intacto).
  // Se um agente V2 casar nesta instância, ele responde via Cloud API e o legado é pulado.
  if (skipAgents) {
    console.log(`[Cloud Webhook] evento de sistema (${messageType}) — não vai pros agentes`);
    return;
  }
  if (content && content.trim()) {
    try {
      const handledByV2 = await tryHandleViaAgentPlatformCloud({
        supabase,
        instanceId: instanceId || "",
        senderPhone: cleanPhone,
        text: content,
        messageId: msgId,
        leadId: finalLeadId,
        tenantId: instanceTenantId, // agente roteia pelo tenant da INSTÂNCIA (central), não do lead/loja
        inboundType: msgType,       // áudio do lead → agente pode responder em áudio (voice_reply mirror)
      });
      if (handledByV2) return; // agente V2 respondeu — não cai no legado
    } catch (e) {
      console.error("[Cloud Webhook] V2 router error (caindo pro legado):", (e as Error).message);
    }
  }

  // Enqueue pra AI agent (mesmo mecanismo do webhook UAZAPI)
  if (finalLeadId && instanceId) {
    // Buscar agente que usa esta instância
    const { data: agent } = await supabase
      .from("ai_sales_agents")
      .select("id")
      .eq("instance_id", instanceId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (agent) {
      await supabase.from("ai_agent_message_queue").insert({
        lead_id: finalLeadId,
        agent_id: agent.id,
        status: "pending",
      });
      console.log(`[Cloud Webhook] Enqueued message for agent ${agent.id}`);
    }
  }
}

// Casa o nome de uma loja citada no texto com um tenant que participa da
// distribuição (tem destino de handoff ATIVO em tenant_lead_destinations).
// Prefere o match mais longo (evita casar "Totex" quando o texto diz "PG Motors").
// ==================== BOTÕES DA MENSAGEM DE PAUSA (follow-up automático, 2026-10-15) ====================
// "Encerrar por agora" → nao_contatar por 30 dias + despedida curta, sem agente.
// "Me chama outro dia" → lembrete de retomada em 3 dias (9h30) + confirmação curta, sem agente.
// "Continuar por aqui" → false: vai pro agente como mensagem normal (ele retoma com valor).
async function handlePausaReply(supabase: any, phone: string, idOuTitulo: string): Promise<boolean> {
  const v = String(idOuTitulo || "").toLowerCase();
  const encerrar = v === "pausa_encerrar" || /encerrar por agora/.test(v);
  const depois = v === "pausa_depois" || /me chama outro dia/.test(v);
  if (!encerrar && !depois) return false;
  const last8 = phone.slice(-8);
  const { data: lead } = await supabase.from("leads").select("id, tenant_id, name, metadata").ilike("phone", `%${last8}`).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!lead) return false;
  const md = (lead.metadata || {}) as Record<string, any>;
  const nome = String(lead.name || "").trim().split(/\s+/)[0];
  const quem = (await getIntegrationKey(supabase, "REAQUECIMENTO_ASSINATURA")) || "Nina";
  const sendText = (text: string) => fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-cloud`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, apikey: SUPABASE_SERVICE_ROLE_KEY },
    body: JSON.stringify({ action: "send_text", phone, text, lead_id: lead.id, tenant_id: lead.tenant_id, sent_by: "followup_auto" }),
  }).catch((e) => console.error("[Cloud Webhook] pausa reply:", (e as Error).message));

  if (encerrar) {
    const ate = new Date(Date.now() + 30 * 86400_000).toISOString();
    await supabase.from("leads").update({ metadata: { ...md, nao_contatar: true, nao_contatar_ate: ate, nao_contatar_motivo: "pausa: encerrar por agora", pausa_encerrada_em: new Date().toISOString() } }).eq("id", lead.id);
    await supabase.from("agent_reminders").update({ status: "cancelled" }).eq("status", "pending").contains("resume_context", { lead_id: lead.id });
    await sendText(`Combinado${nome && !/^\+?\d+$/.test(nome) ? `, ${nome}` : ""}! Vou deixar quieto por aqui. Quando quiser retomar, é só me chamar que eu continuo de onde paramos. Até mais! 😊`);
    console.log(`[Cloud Webhook] pausa: ${phone} encerrou (não contatar até ${ate})`);
    return true;
  }
  // "me chama outro dia": retomada em 3 dias, 9h30 (sessão do agente deste número)
  const { data: sess } = await supabase.from("agents_sessions").select("id, agent_id, tenant_id").eq("channel", "whatsapp")
    .contains("provider_state", { external_session_key: `whatsapp:${phone}` }).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (sess) {
    const br = new Date(Date.now() - 3 * 3600_000);
    const fireAt = new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() + 3, 9, 30) + 3 * 3600_000).toISOString();
    const { data: inst } = await supabase.from("whatsapp_instances").select("id").eq("provider", "meta_cloud").limit(1).maybeSingle();
    await supabase.from("agent_reminders").update({ status: "cancelled" }).eq("session_id", sess.id).eq("status", "pending").is("repeat_every_minutes", null);
    await supabase.from("agent_reminders").insert({
      tenant_id: sess.tenant_id, agent_id: sess.agent_id, session_id: sess.id, channel: "whatsapp", fire_at: fireAt, status: "pending",
      message: "Cliente pediu pra chamar outro dia (botão da pausa)",
      resume_context: { kind: "followup_auto", step: 1, lead_id: lead.id, instance_id: inst?.id || null, recipient: phone, user_id: null, pedido_pelo_cliente: true },
    });
  }
  await supabase.from("leads").update({ metadata: { ...md, pausa_retomar_em: new Date(Date.now() + 3 * 86400_000).toISOString() } }).eq("id", lead.id);
  await sendText(`Perfeito${nome && !/^\+?\d+$/.test(nome) ? `, ${nome}` : ""}! Te chamo daqui a uns dias, então. Se antes disso quiser alguma coisa, é só mandar mensagem. 😊`);
  console.log(`[Cloud Webhook] pausa: ${phone} pediu pra chamar outro dia`);
  return true;
}

// ==================== CLIQUE NO BOTÃO DO WHATSAPP DO SITE (2026-10-15) ====================
// O marketplace cria, no clique do botão, um lead sem telefone ("Cliente (não identificado)",
// source 'marketplace', metadata.vehicle + deal) — o WhatsApp não entrega o número de quem
// clica, só de quem manda mensagem. Quando a mensagem chega ("vi o X da loja Y no site da
// TotexMotors", opcionalmente com "ref ABCD1234" = 8 primeiros caracteres do id do lead):
//  - ref presente → casa exato (48 h); sem ref → o órfão mais recente (2 h) com o mesmo carro;
//  - se o número JÁ tem lead na loja do órfão → carro/loja/deal vão pra ele e o órfão some;
//  - senão → o órfão GANHA o telefone e o nome do WhatsApp e vira o lead da conversa
//    (é o mais recente daquele telefone → o roteamento cai na loja certa).
// Órfão que nunca recebe mensagem: marketplace_cliques_sem_contato() (cron diário) tira do funil.
async function absorbMarketplaceClick(supabase: any, phone: string, contactName: string | null, text: string): Promise<void> {
  const t = String(text || "");
  const ref = t.match(/\bref\.?\s*[:#]?\s*([0-9a-f]{6,12})\b/i)?.[1]?.toLowerCase() || null;
  const m = t.match(/\bvi\s+(?:o|a|um|uma)?\s*(.+?)\s+da\s+loja\s+(.+?)\s+no\s+site/i);
  if (!ref && !m) return;
  const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const NOISE = /^(\d+([.,]\d+)?|\d+v|\d+p|flex|aut\.?|automatico|manual|turbo|tb|awd|4x4|4x2|hibrido|eletrico|diesel|cvt|evolut\.?|\d{4})$/;
  const carro = m?.[1] || "";
  const tokens = [...new Set(norm(carro).replace(/[().,]/g, " ").split(/\s+/).filter((k) => k.length >= 3 && !NOISE.test(k)))];

  const since = new Date(Date.now() - (ref ? 48 : 2) * 3600_000).toISOString();
  const { data: orphans } = await supabase.from("leads").select("id, tenant_id, name, metadata, created_at")
    .is("phone", null).eq("source", "marketplace").gte("created_at", since)
    .order("created_at", { ascending: false }).limit(20);
  const list = (orphans || []) as any[];
  if (!list.length) return;

  let orphan: any = null;
  if (ref) orphan = list.find((o) => String(o.id).replace(/-/g, "").toLowerCase().startsWith(ref) || String(o.id).toLowerCase().startsWith(ref)) || null;
  if (!orphan && tokens.length) {
    orphan = list.find((o) => {
      const v = (o.metadata || {}).vehicle || {};
      const s = norm([v.brand, v.model, v.version, v.description, v.title].filter(Boolean).join(" "));
      return tokens.filter((k) => s.includes(k)).length >= Math.min(2, tokens.length);
    }) || null;
  }
  if (!orphan) return;

  const now = new Date().toISOString();
  const omd = (orphan.metadata || {}) as Record<string, any>;
  const { data: target } = await supabase.from("leads").select("id, name, metadata")
    .eq("tenant_id", orphan.tenant_id).ilike("phone", `%${phone.slice(-8)}`).neq("id", orphan.id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (target) {
    // o número já tem lead nessa loja: o clique vira dado dele
    const tmd = (target.metadata || {}) as Record<string, any>;
    const patch: Record<string, any> = { ...tmd, marketplace_click: { lead_id: orphan.id, at: orphan.created_at, fundido_em: now } };
    if (omd.vehicle) {
      const vid = String(omd.vehicle.id || "");
      const rest = (Array.isArray(tmd.vehicles) ? tmd.vehicles : (tmd.vehicle ? [tmd.vehicle] : [])).filter((x: any) => String(x?.id || "") !== vid);
      patch.vehicle = omd.vehicle; patch.vehicles = [omd.vehicle, ...rest].slice(0, 5);
      patch.veiculo_interesse_texto = [omd.vehicle.brand, omd.vehicle.model, omd.vehicle.version, omd.vehicle.year].filter(Boolean).join(" ") || tmd.veiculo_interesse_texto;
    }
    for (const k of ["store", "marketplace_store_name", "credere_store_name"]) if (omd[k] && !tmd[k]) patch[k] = omd[k];
    await supabase.from("leads").update({ metadata: patch, last_interaction_at: now }).eq("id", target.id);
    await supabase.from("deals").update({ lead_id: target.id }).eq("lead_id", orphan.id);
    const del = await supabase.from("leads").delete().eq("id", orphan.id);
    if (del.error) {
      await supabase.from("leads").update({ name: "Clique do site (fundido)", status: "fundido", metadata: { ...omd, fundido_em: target.id } }).eq("id", orphan.id);
    }
    console.log(`[Cloud Webhook] clique do site ${orphan.id} fundido no lead ${target.id} (${phone})`);
  } else {
    // o clique vira o lead: ganha o telefone e o nome do WhatsApp
    const placeholder = /n[aã]o identificado|^cliente$/i.test(String(orphan.name || ""));
    await supabase.from("leads").update({
      phone,
      name: placeholder && contactName && !/^\+?\d+$/.test(contactName) ? contactName : orphan.name,
      last_interaction_at: now,
      metadata: { ...omd, identificado_por: "mensagem_whatsapp", identificado_em: now, ...(ref ? { ref_site: ref } : {}) },
    }).eq("id", orphan.id);
    console.log(`[Cloud Webhook] clique do site ${orphan.id} identificado: ${phone}`);
  }
}

async function matchStoreTenant(supabase: any, text: string): Promise<string | null> {
  const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const t = norm(text);
  if (!t) return null;
  const { data: dests } = await supabase
    .from("tenant_lead_destinations")
    .select("tenant_id, label")
    .eq("active", true);
  if (!dests || dests.length === 0) return null;
  const ids = [...new Set(dests.map((d: any) => d.tenant_id))];
  const { data: tenants } = await supabase.from("tenants").select("id, name").in("id", ids);
  const nameById: Record<string, string> = {};
  for (const tn of tenants || []) nameById[tn.id] = tn.name;
  let best: string | null = null;
  let bestLen = 0;
  for (const d of dests) {
    for (const cand of [nameById[d.tenant_id], d.label]) {
      const name = norm(cand || "");
      if (name.length >= 3 && t.includes(name) && name.length > bestLen) {
        best = d.tenant_id;
        bestLen = name.length;
      }
    }
  }
  return best;
}

// ==================== HANDLE STATUS UPDATE ====================

async function handleStatusUpdate(supabase: any, status: any, instanceId: string | null) {
  const msgId = status.id;
  const statusValue = status.status; // sent, delivered, read, failed
  const recipientId = status.recipient_id;
  const timestamp = status.timestamp;

  // Atualizar status da mensagem no banco
  if (msgId && statusValue) {
    await supabase
      .from("whatsapp_messages")
      .update({
        status: statusValue,
        metadata: supabase.rpc ? undefined : undefined, // Não sobrescrever metadata
      })
      .eq("message_id", msgId);
  }

  // Se falhou, logar o erro COM o detalhe da Meta (error_data.details diz o motivo real,
  // ex.: "Unsupported MIME type …") e guardar na mensagem pra aparecer no inbox/diagnóstico.
  if (statusValue === "failed" && status.errors) {
    const errs = status.errors.map((e: any) => ({
      code: e.code, title: e.title, details: e.error_data?.details || e.message || null,
    }));
    const errorMsg = errs.map((e: any) => `${e.code}: ${e.title}${e.details ? ` — ${e.details}` : ""}`).join(", ");
    console.error(`[Cloud Webhook] Message ${msgId} failed: ${errorMsg}`);
    try {
      const { data: row } = await supabase.from("whatsapp_messages").select("metadata").eq("message_id", msgId).maybeSingle();
      await supabase.from("whatsapp_messages")
        .update({ metadata: { ...((row?.metadata as Record<string, unknown>) || {}), delivery_errors: errs } })
        .eq("message_id", msgId);
    } catch (e) { console.warn("[Cloud Webhook] não gravou delivery_errors:", (e as Error).message); }
  }
}

// ==================== HELPERS ====================

// Transcrever áudio com OpenAI Whisper
async function transcribeAudio(supabase: any, audioUrl: string, openaiKey: string): Promise<string | null> {
  try {
    // Baixar áudio do Storage. O bucket `whatsapp-media` é PRIVADO: a URL "pública" não
    // baixa por fetch — usa o service role quando é do nosso storage.
    let audioBlob: Blob;
    const st = String(audioUrl).match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)/);
    if (st) {
      const { data, error } = await supabase.storage.from(st[1]).download(decodeURIComponent(st[2].split("?")[0]));
      if (error || !data) { console.error("[Cloud Webhook] transcribe: download storage falhou:", error?.message); return null; }
      audioBlob = data;
    } else {
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) return null;
      audioBlob = await audioRes.blob();
    }

    // Montar multipart form pra Whisper API
    const boundary = `----WhisperBoundary${Date.now()}`;
    const mimeType = audioBlob.type || "audio/ogg";
    const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";

    // Header parts
    const parts: Uint8Array[] = [];
    const enc = new TextEncoder();

    // model field
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
    // language field
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\npt\r\n`));
    // file field header
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType}\r\n\r\n`));
    // file content
    parts.push(new Uint8Array(await audioBlob.arrayBuffer()));
    // footer
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    // Concat all parts
    const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
    const body = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.length;
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("[Cloud Webhook] Whisper error:", JSON.stringify(data));
      return null;
    }

    const text = data.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err: any) {
    console.error("[Cloud Webhook] Transcription error:", err.message);
    return null;
  }
}

/**
 * Permissão de ligação (Meta) respondida pelo cliente: grava em leads.metadata.call_permission
 * (todos os leads com esse telefone) e, se aceitou, libera as ligações da Nina que esperavam.
 */
async function handleCallPermissionReply(supabase: any, phone: string, r: { accepted: boolean; expiresAt: string | null; isPermanent: boolean; source: string | null }) {
  const last8 = phone.slice(-8);
  const { data: leads } = await supabase.from("leads").select("id, metadata").like("phone", `%${last8}`).limit(10);
  for (const l of leads || []) {
    const md = (l.metadata || {}) as Record<string, unknown>;
    await supabase.from("leads").update({
      metadata: { ...md, call_permission: { status: r.accepted ? (r.isPermanent ? "permanent" : "temporary") : "rejected", expires_at: r.expiresAt, source: r.source, at: new Date().toISOString() } },
    }).eq("id", l.id);
  }
  const { data: q } = await supabase.from("nina_call_queue").select("id").eq("status", "awaiting_permission").like("phone", `%${last8}`);
  if (q && q.length) {
    await supabase.from("nina_call_queue")
      .update(r.accepted ? { status: "queued", scheduled_for: new Date().toISOString() } : { status: "expired", last_error: "cliente não permitiu a ligação" })
      .in("id", q.map((x: any) => x.id));
    console.log(`[Cloud Webhook] permissão ${r.accepted ? "aceita" : "negada"} por ${phone} → ${q.length} ligação(ões) da Nina ${r.accepted ? "liberadas" : "encerradas"}`);
  }
}

// Baixar mídia do Meta Cloud API e salvar no Supabase Storage
async function downloadAndStoreMedia(supabase: any, mediaId: string, msgType: string, tenantId: string | null = null): Promise<string | null> {
  try {
    // Token da Cloud API via getIntegrationKey (Integrações da loja → config → env).
    // O env WHATSAPP_CLOUD_API_TOKEN estava vazio em produção → "No URL for media" em
    // todo áudio/imagem recebido (nunca baixava nem transcrevia).
    const token = (await getIntegrationKey(supabase, "WHATSAPP_CLOUD_TOKEN", tenantId)) || WHATSAPP_TOKEN;
    if (!token) { console.error("[Cloud Webhook] Sem WHATSAPP_CLOUD_TOKEN pra baixar mídia"); return null; }

    // 1. Obter URL de download do media
    const metaRes = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const metaData = await metaRes.json();
    if (!metaData.url) {
      console.error(`[Cloud Webhook] No URL for media ${mediaId}`);
      return null;
    }

    // 2. Baixar o arquivo
    const fileRes = await fetch(metaData.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fileRes.ok) {
      console.error(`[Cloud Webhook] Failed to download media: ${fileRes.status}`);
      return null;
    }
    const fileBlob = await fileRes.blob();
    const mimeType = metaData.mime_type || fileRes.headers.get("content-type") || "application/octet-stream";

    // 3. Determinar extensão
    const extMap: Record<string, string> = {
      "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr",
      "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
      "video/mp4": "mp4", "video/3gpp": "3gp",
      "application/pdf": "pdf",
    };
    const ext = extMap[mimeType] || mimeType.split("/")[1] || "bin";
    const path = `cloud_${Date.now()}_${mediaId.slice(-8)}.${ext}`;

    // 4. Upload pro Storage
    const { error } = await supabase.storage.from("whatsapp-media").upload(path, fileBlob, { contentType: mimeType });
    if (error) {
      console.error(`[Cloud Webhook] Storage upload failed:`, error.message);
      return null;
    }

    const { data: urlData } = supabase.storage.from("whatsapp-media").getPublicUrl(path);
    console.log(`[Cloud Webhook] Media stored: ${urlData.publicUrl}`);
    return urlData.publicUrl;
  } catch (err: any) {
    console.error(`[Cloud Webhook] Error downloading media:`, err.message);
    return null;
  }
}

async function getOfficialInstance(supabase: any): Promise<{ id: string; tenant_id: string | null } | null> {
  const { data } = await supabase
    .from("whatsapp_instances")
    .select("id, tenant_id")
    .eq("name", "IAP - OFICIAL")
    .limit(1)
    .maybeSingle();
  return data ? { id: data.id, tenant_id: data.tenant_id ?? null } : null;
}
