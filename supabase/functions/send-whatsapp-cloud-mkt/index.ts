import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * WhatsApp Cloud API (Meta oficial) — Envio de mensagens (MULTI-TENANT)
 *
 * Princípios:
 *   - ZERO hardcoded: credentials resolvidas no banco a cada request
 *   - Identifica instância via instance_id OU pega primeira ativa do tenant (provider='meta_cloud')
 *   - Coexiste com UAZAPI: só processa instâncias com provider='meta_cloud'
 *
 * MULTI-TENANT — resolução do tenant:
 *   - Categoria (a): chamada do frontend (JWT Authorization header)
 *   - Categoria (d): chamada server-to-server (campaign-processor envia tenant_id no body)
 *
 * Uso:
 *   POST { instance_id, action, phone, ... }
 *   POST { action, phone, ... }  (pega primeira instância meta_cloud DO TENANT)
 *
 * Actions:
 *   - send_text: { text } ou { message }
 *   - send_template: { template_name, template_params }
 *   - send_image: { media_url, caption }
 *   - send_document: { media_url, caption, filename }
 *   - send_audio: { media_url }
 *   - send_video: { media_url, caption }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const GRAPH_API_VERSION = "v22.0";

interface CloudInstance {
  id: string;
  name: string;
  api_key: string;           // token permanente da Meta
  phone_number_id: string;
  business_account_id: string | null;
  tenant_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json();
    const {
      action, phone, lead_id, sent_by, sent_by_name,
      sent_by_team_member_id, sent_by_agent_id, instance_id,
    } = body;

    if (!phone) {
      return jsonRes({ error: "phone required" }, 400);
    }

    // MULTI-TENANT: resolve tenant_id (JWT prioritário; fallback body)
    let tenantId: string | null = null;
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader && !authHeader.includes(SUPABASE_SERVICE_ROLE_KEY)) {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      tenantId = (user?.app_metadata as any)?.tenant_id || null;
    }
    if (!tenantId && body.tenant_id) tenantId = body.tenant_id;

    // Último fallback: deriva o tenant da própria instância se um instance_id foi
    // explicitado (útil pra crons/campaign-processor que passam só instance_id).
    if (!tenantId && instance_id) {
      const { data: inst } = await supabase
        .from("whatsapp_instances").select("tenant_id").eq("id", instance_id).maybeSingle();
      tenantId = inst?.tenant_id || null;
    }
    if (!tenantId) {
      return jsonRes({ error: "missing tenant" }, 401);
    }

    // Resolver instância Cloud API (do tenant)
    const instance = await resolveInstance(supabase, tenantId, { instance_id });
    if (!instance) {
      return jsonRes(
        { error: "Nenhuma instância Cloud API ativa encontrada para este tenant" },
        404,
      );
    }

    // Normalizar telefone
    const cleanPhone = phone.replace(/\D/g, "");
    const formattedPhone = cleanPhone.startsWith("55") ? cleanPhone : `55${cleanPhone}`;

    const graphUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instance.phone_number_id}/messages`;

    let result: { ok: boolean; data: any; content: string; messageType: string; extraMeta?: any };

    switch (action) {
      case "send_template":
        result = await sendTemplate(body, formattedPhone, graphUrl, instance, supabase, tenantId);
        break;
      case "send_text":
        result = await sendText(body, formattedPhone, graphUrl, instance);
        break;
      case "send_image":
        result = await sendMedia(body, formattedPhone, "image", graphUrl, instance);
        break;
      case "send_document":
        result = await sendMedia(body, formattedPhone, "document", graphUrl, instance);
        break;
      case "send_audio":
        result = await sendAudioViaUpload(body, formattedPhone, graphUrl, instance);
        break;
      case "send_video":
        result = await sendMedia(body, formattedPhone, "video", graphUrl, instance);
        break;
      default:
        if (body.template_name) {
          result = await sendTemplate(body, formattedPhone, graphUrl, instance, supabase, tenantId);
        } else if (body.text || body.message) {
          result = await sendText(body, formattedPhone, graphUrl, instance);
        } else {
          return jsonRes({ error: "action obrigatória (send_template, send_text, send_image, ...)" }, 400);
        }
    }

    if (!result.ok) {
      console.error(`[cloud-api] Error:`, JSON.stringify(result.data));
      return jsonRes(
        { error: result.data.error?.message || "Falha ao enviar", details: result.data },
        500,
      );
    }

    const messageId = result.data.messages?.[0]?.id;
    console.log(`[cloud-api] Sent. message_id=${messageId} tenant=${tenantId}`);

    // Persistir na timeline
    // MULTI-TENANT: tenant_id explícito no insert de whatsapp_messages
    const isAgent = sent_by === 'ai_agent' || !!sent_by_agent_id;
    await supabase.from("whatsapp_messages").insert({
      tenant_id: tenantId,
      instance_id: instance.id,
      remote_jid: `${formattedPhone}@s.whatsapp.net`,
      message_id: messageId || `cloud_${Date.now()}`,
      message_type: result.messageType || "Conversation",
      content: result.content,
      media_url: result.extraMeta?.media_url || null,
      is_from_me: true,
      sent_at: new Date().toISOString(),
      lead_id: lead_id || null,
      sent_by_team_member_id: isAgent ? null : (sent_by_team_member_id || null),
      sent_by_type: isAgent ? 'ai_agent' : (sent_by_team_member_id ? 'human' : null),
      sent_by_agent_id: sent_by_agent_id || null,
      sender_name: sent_by_name || null,
      metadata: {
        sent_by: sent_by || "system",
        sent_by_name: sent_by_name || null,
        cloud_api: true,
        provider: "meta_cloud",
        ...(result.extraMeta || {}),
      },
    });

    return jsonRes({ success: true, message_id: messageId, instance_id: instance.id });
  } catch (err: any) {
    console.error("[cloud-api] Unexpected:", err.message);
    return jsonRes({ error: err.message }, 500);
  }
});

// ==================== RESOLVER INSTÂNCIA ====================

// MULTI-TENANT: tenantId obrigatório — só instâncias do tenant podem ser usadas.
async function resolveInstance(
  supabase: any,
  tenantId: string,
  params: { instance_id?: string },
): Promise<CloudInstance | null> {
  const baseSelect = "id, name, api_key, phone_number_id, business_account_id, tenant_id";

  // Prefer instance_id explícito
  if (params.instance_id) {
    const { data } = await supabase
      .from("whatsapp_instances")
      .select(baseSelect)
      .eq("id", params.instance_id)
      .eq("tenant_id", tenantId)
      .eq("provider", "meta_cloud")
      .maybeSingle();
    return hydrateInstance(data);
  }

  // Fallback: primeira instância meta_cloud do tenant
  const { data } = await supabase
    .from("whatsapp_instances")
    .select(baseSelect)
    .eq("tenant_id", tenantId)
    .eq("provider", "meta_cloud")
    .limit(1)
    .maybeSingle();
  return hydrateInstance(data);
}

function hydrateInstance(data: any): CloudInstance | null {
  if (!data) return null;
  if (!data.api_key || !data.phone_number_id) {
    console.warn(`[cloud-api] Instance ${data.id} sem api_key ou phone_number_id`);
    return null;
  }
  return data as CloudInstance;
}

// ==================== SEND TEMPLATE ====================

async function sendTemplate(
  body: any,
  phone: string,
  graphUrl: string,
  instance: CloudInstance,
  supabase: any,
  tenantId: string,
) {
  const { template_name, template_params, template_language } = body;
  const templateName = template_name;
  const language = template_language || "pt_BR";

  if (!templateName) {
    throw new Error("template_name obrigatório para send_template");
  }

  const payload: any = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
    },
  };

  if (template_params && template_params.length > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: template_params.map((p: string) => ({ type: "text", text: p })),
      },
    ];
  }

  const response = await callCloudAPI(graphUrl, instance.api_key, payload);
  const content = await buildTemplateText(supabase, tenantId, templateName, template_params);

  return {
    ok: response.ok,
    data: response.data,
    content,
    messageType: "template",
    extraMeta: { template_name: templateName, template_language: language },
  };
}

// ==================== SEND TEXT ====================

async function sendText(body: any, phone: string, graphUrl: string, instance: CloudInstance) {
  const text = body.text || body.message;
  if (!text) throw new Error("text/message obrigatório");

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: text },
  };

  const response = await callCloudAPI(graphUrl, instance.api_key, payload);

  return {
    ok: response.ok,
    data: response.data,
    content: text,
    messageType: "Conversation",
  };
}

// ==================== SEND MEDIA (image/document/video) ====================

async function sendMedia(
  body: any,
  phone: string,
  type: "image" | "document" | "video",
  graphUrl: string,
  instance: CloudInstance,
) {
  const { media_url, caption, filename } = body;
  if (!media_url) throw new Error("media_url obrigatório");

  const mediaObj: any = { link: media_url };
  if (caption) mediaObj.caption = caption;
  if (filename && type === "document") mediaObj.filename = filename;

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type,
    [type]: mediaObj,
  };

  const response = await callCloudAPI(graphUrl, instance.api_key, payload);

  const contentLabel = {
    image: "Imagem",
    document: "Documento",
    video: "Vídeo",
  }[type];

  return {
    ok: response.ok,
    data: response.data,
    content: caption || `[${contentLabel}]`,
    messageType: type,
    extraMeta: { media_url },
  };
}

// ==================== SEND AUDIO (upload via Media API) ====================

async function sendAudioViaUpload(
  body: any,
  phone: string,
  graphUrl: string,
  instance: CloudInstance,
) {
  const { media_url: audioUrl, caption } = body;
  if (!audioUrl) throw new Error("media_url obrigatório para áudio");

  // 1. Baixar áudio
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error("Falha ao baixar áudio");
  const audioBuffer = await audioRes.arrayBuffer();

  // 2. Meta Cloud aceita OGG (Opus codec). Frontend já grava OGG nativo via OpusMediaRecorder.
  //    NÃO incluir "codecs=opus" no Content-Type — Meta rejeita.
  const boundary = `----FormBoundary${Date.now()}`;
  const mimeType = "audio/ogg";
  const filename = "audio.ogg";

  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="messaging_product"\r\n`,
    `whatsapp`,
    `--${boundary}`,
    `Content-Disposition: form-data; name="type"\r\n`,
    mimeType,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mimeType}\r\n`,
  ].join("\r\n");

  const footer = `\r\n--${boundary}--\r\n`;
  const headerBytes = new TextEncoder().encode(header);
  const footerBytes = new TextEncoder().encode(footer);
  const mediaBody = new Uint8Array(headerBytes.length + audioBuffer.byteLength + footerBytes.length);
  mediaBody.set(headerBytes, 0);
  mediaBody.set(new Uint8Array(audioBuffer), headerBytes.length);
  mediaBody.set(footerBytes, headerBytes.length + audioBuffer.byteLength);

  const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instance.phone_number_id}/media`;
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${instance.api_key}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: mediaBody,
  });

  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || !uploadData.id) {
    console.error("[cloud-api] Media upload failed:", JSON.stringify(uploadData));
    // Fallback: tentar via link direto
    const payload = {
      messaging_product: "whatsapp",
      to: phone,
      type: "audio",
      audio: { link: audioUrl },
    };
    const response = await callCloudAPI(graphUrl, instance.api_key, payload);
    return {
      ok: response.ok,
      data: response.data,
      content: caption || "[Áudio]",
      messageType: "audio",
      extraMeta: { media_url: audioUrl },
    };
  }

  const mediaId = uploadData.id;
  console.log(`[cloud-api] Audio uploaded. media_id=${mediaId}`);

  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "audio",
    audio: { id: mediaId },
  };

  const response = await callCloudAPI(graphUrl, instance.api_key, payload);

  return {
    ok: response.ok,
    data: response.data,
    content: caption || "[Áudio]",
    messageType: "audio",
    extraMeta: { media_url: audioUrl, media_id: mediaId },
  };
}

// ==================== CALL GRAPH API ====================

async function callCloudAPI(
  graphUrl: string,
  token: string,
  payload: any,
): Promise<{ ok: boolean; data: any }> {
  const response = await fetch(graphUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  return { ok: response.ok, data };
}

// ==================== HELPERS ====================

// MULTI-TENANT: busca template do tenant correto
async function buildTemplateText(
  supabase: any,
  tenantId: string,
  templateName: string,
  params?: string[],
): Promise<string> {
  // Busca template — prioriza components (Meta JSONB), cai pra body_text legado
  const { data: tpl } = await supabase
    .from("whatsapp_cloud_templates")
    .select("body_text, components")
    .eq("tenant_id", tenantId)
    .eq("name", templateName)
    .maybeSingle();

  let text: string | null = null;

  // 1. Tenta extrair body do components (formato Meta)
  if (tpl?.components && Array.isArray(tpl.components)) {
    const body = tpl.components.find((c: any) => c?.type === "BODY");
    if (body?.text) text = body.text;
  }
  // 2. Fallback campo legado
  if (!text && tpl?.body_text) text = tpl.body_text;
  // 3. Último fallback
  if (!text) text = `[Template: ${templateName}]`;

  if (params && params.length > 0) {
    params.forEach((p: string, i: number) => {
      text = text!.replace(`{{${i + 1}}}`, p);
    });
  }
  return text;
}

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
