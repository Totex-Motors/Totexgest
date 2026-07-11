import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

/**
 * WhatsApp Embedded Signup (Coexistência) — Tech Provider.
 *
 * Permite que o usuário conecte um número que já usa no app WhatsApp Business,
 * via o popup oficial da Meta (Embedded Signup), sem perder conversas.
 *
 * Princípios:
 *  - ZERO hardcoded: app_id, config_id, secret resolvidos no banco (config table).
 *  - Multi-tenant: a instância é criada vinculada ao tenant_id.
 *  - Coexiste com Cloud API/UAZAPI: cria instância provider='meta_cloud'.
 *
 * Actions:
 *  - config   → retorna { app_id, config_id } pro front inicializar o FB SDK.
 *  - exchange → troca o code por token, inscreve o app no WABA, busca o número
 *               e cria/atualiza a instância em whatsapp_instances.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH_API_VERSION = "v22.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // Multi-tenant (Onda B3): tenant do body (exchange já recebe tenant_id) ou do JWT
    const tenantId: string | null = body.tenant_id || getTenantIdFromRequest(req) || null;

    if (action === "config") {
      return await handleConfig(supabase, tenantId);
    }
    if (action === "exchange") {
      return await handleExchange(supabase, body, tenantId);
    }

    return jsonRes({ error: "action obrigatória (config | exchange)" }, 400);
  } catch (err: any) {
    console.error("[embedded-signup] Unexpected:", err?.message || err);
    return jsonRes({ error: err?.message || "Erro inesperado" }, 500);
  }
});

// ==================== CONFIG ====================

async function handleConfig(supabase: any, tenantId: string | null = null) {
  const appId = await getIntegrationKey(supabase, "META_APP_ID", tenantId);
  const configId = await getIntegrationKey(supabase, "EMBEDDED_SIGNUP_CONFIG_ID", tenantId);

  if (!appId || !configId) {
    // status 200 pro front exibir a mensagem amigável.
    return jsonRes({ error: "Configure META_APP_ID e EMBEDDED_SIGNUP_CONFIG_ID em Integrações" }, 200);
  }

  return jsonRes({ app_id: appId, config_id: configId });
}

// ==================== EXCHANGE ====================

async function handleExchange(supabase: any, body: any, tenantId: string | null = null) {
  const { code, waba_id, phone_number_id } = body;
  const tenant_id = body.tenant_id || tenantId;

  if (!code) return jsonRes({ success: false, error: "code obrigatório" }, 200);
  if (!waba_id || !phone_number_id) {
    return jsonRes({
      success: false,
      error: "waba_id e phone_number_id não foram capturados do Embedded Signup. Tente conectar novamente.",
    }, 200);
  }

  const appId = await getIntegrationKey(supabase, "META_APP_ID", tenant_id);
  const appSecret = await getIntegrationKey(supabase, "META_APP_SECRET", tenant_id);
  if (!appId || !appSecret) {
    return jsonRes({
      success: false,
      error: "Configure META_APP_ID e META_APP_SECRET em Integrações antes de conectar.",
    }, 200);
  }

  // 1) Troca o code por access_token.
  const tokenUrl =
    `${GRAPH_BASE}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenRes = await fetch(tokenUrl, { method: "GET" });
  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || tokenData.error || !tokenData.access_token) {
    const msg = tokenData?.error?.message || "Falha ao trocar o código de autorização com a Meta.";
    console.error("[embedded-signup] token exchange failed:", JSON.stringify(tokenData));
    return jsonRes({ success: false, error: msg }, 200);
  }

  const accessToken: string = tokenData.access_token;

  // 2) Inscreve o app no WABA (não-fatal — loga mas não aborta).
  try {
    const subRes = await fetch(`${GRAPH_BASE}/${encodeURIComponent(waba_id)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const subData = await subRes.json().catch(() => ({}));
    if (!subRes.ok || subData?.error) {
      console.warn("[embedded-signup] subscribed_apps falhou (não-fatal):", JSON.stringify(subData));
    }
  } catch (e: any) {
    console.warn("[embedded-signup] subscribed_apps erro (não-fatal):", e?.message || e);
  }

  // 3) Busca dados do número.
  let displayPhoneNumber: string | null = null;
  let verifiedName: string | null = null;
  try {
    const numRes = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(phone_number_id)}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const numData = await numRes.json().catch(() => ({}));
    if (numRes.ok && !numData?.error) {
      displayPhoneNumber = numData.display_phone_number || null;
      verifiedName = numData.verified_name || null;
    } else {
      console.warn("[embedded-signup] busca do número falhou (não-fatal):", JSON.stringify(numData));
    }
  } catch (e: any) {
    console.warn("[embedded-signup] busca do número erro (não-fatal):", e?.message || e);
  }

  // 4) Cria/atualiza a instância.
  const instanceName = `WhatsApp ${displayPhoneNumber || phone_number_id}`;
  const payload = {
    name: instanceName,
    provider: "meta_cloud",
    api_key: accessToken,
    api_url: "https://graph.facebook.com",
    phone_number_id: String(phone_number_id),
    business_account_id: String(waba_id),
    status: "connected",
    purpose: "inbox",
    metadata: {
      coexistence: true,
      created_via: "embedded_signup",
      verified_name: verifiedName,
    },
  };

  // Procura por instância existente (mesmo phone_number_id + tenant).
  let existingQuery = supabase
    .from("whatsapp_instances")
    .select("id")
    .eq("phone_number_id", String(phone_number_id))
    .eq("provider", "meta_cloud");
  existingQuery = tenant_id
    ? existingQuery.eq("tenant_id", tenant_id)
    : existingQuery.is("tenant_id", null);
  const { data: existing } = await existingQuery.maybeSingle();

  let instanceId: string | null = null;

  if (existing?.id) {
    const { data: upd, error: updErr } = await supabase
      .from("whatsapp_instances")
      .update(payload)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (updErr) {
      console.error("[embedded-signup] update falhou:", updErr.message);
      return jsonRes({ success: false, error: `Falha ao atualizar instância: ${updErr.message}` }, 200);
    }
    instanceId = upd?.id || existing.id;
  } else {
    const { data: ins, error: insErr } = await supabase
      .from("whatsapp_instances")
      .insert({ ...payload, tenant_id: tenant_id || null })
      .select("id")
      .single();
    if (insErr) {
      console.error("[embedded-signup] insert falhou:", insErr.message);
      return jsonRes({ success: false, error: `Falha ao criar instância: ${insErr.message}` }, 200);
    }
    instanceId = ins?.id || null;
  }

  console.log(`[embedded-signup] Instância pronta. id=${instanceId} phone_number_id=${phone_number_id}`);
  return jsonRes({ success: true, instance_id: instanceId });
}

// ==================== HELPERS ====================

function jsonRes(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
