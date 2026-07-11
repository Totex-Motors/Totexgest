// uazapi-proxy — proxy seguro pra UAZAPI.
//
// O frontend NUNCA vê a api_key da instância: manda { action, instance_id, ...params },
// a function valida o acesso do usuário (via RLS) e faz a chamada à UAZAPI com a
// api_key lida pelo service role.
//
// Autorização em 2 camadas:
//   1. Cliente user-scoped (Authorization do request) tenta enxergar a instância.
//      Se o RLS bloquear (ou não existir) → 403.
//   2. Cliente service-role busca api_url/api_key e chama a UAZAPI.
//
// Actions admin (admin_create_instance / admin_delete_instance) exigem is_admin()
// e usam UAZAPI_ADMIN_URL/UAZAPI_ADMIN_TOKEN lidos da tabela config (getIntegrationKey).
//
// Resposta: sempre { ok, status, data } — erros da UAZAPI voltam com HTTP 200 e
// ok:false pro front tratar.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Repassa a resposta da UAZAPI como { ok, status, data } (HTTP 200 mesmo em erro).
async function callUazapi(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return json({ ok: res.ok, status: res.status, data });
}

// Extrai só os campos permitidos (nunca repassa o body inteiro pra UAZAPI).
function pick(src: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.action !== "string") {
      return json({ ok: false, error: "Body inválido: { action, instance_id, ...params }" }, 400);
    }
    const { action, instance_id: instanceId } = body as {
      action: string;
      instance_id?: string;
    };

    // Cliente user-scoped: espelha o RLS do usuário logado.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ ok: false, error: "Não autenticado" }, 401);
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // ─── Actions ADMIN (criar/deletar instância via admin token) ───────────
    if (action === "admin_create_instance" || action === "admin_delete_instance") {
      const { data: isAdmin, error: adminErr } = await userClient.rpc("is_admin");
      if (adminErr || isAdmin !== true) {
        return json({ ok: false, error: "Apenas administradores" }, 403);
      }

      if (action === "admin_create_instance") {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return json({ ok: false, error: "Informe o nome da instância" }, 400);
        const team = typeof body.team === "string" && body.team ? body.team : "comercial";

        const tenantId = getTenantIdFromRequest(req);
        const adminUrlRaw = await getIntegrationKey(serviceClient, "UAZAPI_ADMIN_URL", tenantId);
        const adminToken = await getIntegrationKey(serviceClient, "UAZAPI_ADMIN_TOKEN", tenantId);
        if (!adminUrlRaw || !adminToken) {
          return json({ ok: false, error: "UAZAPI não configurado (UAZAPI_ADMIN_URL/UAZAPI_ADMIN_TOKEN)" }, 400);
        }
        const adminUrl = adminUrlRaw.replace(/\/$/, "");
        const webhookUrl = `${SUPABASE_URL}/functions/v1/whatsapp-webhook`;

        // 1. Cria instância na UAZAPI (/instance/init é o endpoint oficial)
        const createRes = await fetch(`${adminUrl}/instance/init`, {
          method: "POST",
          headers: { "Content-Type": "application/json", admintoken: adminToken },
          body: JSON.stringify({ name }),
        });
        if (!createRes.ok) {
          const errText = await createRes.text();
          return json({ ok: false, status: createRes.status, data: { error: `UAZAPI: ${createRes.status}`, raw: errText } });
        }
        const createData = await createRes.json();
        const instanceToken = createData.token || createData.apikey;
        if (!instanceToken) {
          return json({ ok: false, status: 200, data: { error: "Token não retornado pela UAZAPI" } });
        }

        // 2. Configura webhook (falha aqui não bloqueia — pode ser reconfigurado depois)
        try {
          await fetch(`${adminUrl}/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", token: instanceToken },
            body: JSON.stringify({
              url: webhookUrl,
              events: ["messages", "messages_update", "connection", "groups", "contacts", "call", "chats"],
              excludeMessages: ["wasSentByApi"],
              addUrlEvents: true,
            }),
          });
        } catch { /* webhook pode ser configurado depois */ }

        // 3. Salva no banco com o cliente do USUÁRIO (RLS preenche/valida o tenant,
        //    igual o insert que o frontend fazia antes).
        const insertPayload: Record<string, unknown> = {
          name: createData.name || name,
          api_url: adminUrl,
          webhook_url: adminUrl,
          api_key: instanceToken,
          teams: [team],
          status: "disconnected",
          metadata: { uazapi_instance_id: createData.instance?.id || null, webhook_url: webhookUrl },
        };
        if (typeof body.purpose === "string" && body.purpose) insertPayload.purpose = body.purpose;

        const { data: inserted, error: insertErr } = await userClient
          .from("whatsapp_instances")
          .insert(insertPayload)
          .select("id, name, status, teams, purpose")
          .single();
        if (insertErr) {
          return json({ ok: false, status: 200, data: { error: `Erro ao salvar instância: ${insertErr.message}` } });
        }
        return json({ ok: true, status: 200, data: { instance: inserted } });
      }

      // admin_delete_instance — espelha o fluxo atual: desvincula membros e apaga a linha.
      if (!instanceId) return json({ ok: false, error: "instance_id obrigatório" }, 400);
      const { data: visible } = await userClient
        .from("whatsapp_instances")
        .select("id")
        .eq("id", instanceId)
        .maybeSingle();
      if (!visible) return json({ ok: false, error: "Instância não encontrada ou sem acesso" }, 403);

      await userClient.from("team_members").update({ whatsapp_instance_id: null }).eq("whatsapp_instance_id", instanceId);
      const { error: delErr } = await userClient.from("whatsapp_instances").delete().eq("id", instanceId);
      if (delErr) {
        return json({ ok: false, status: 200, data: { error: `Erro ao excluir: ${delErr.message}` } });
      }
      return json({ ok: true, status: 200, data: { deleted: true } });
    }

    // ─── Actions por instância ──────────────────────────────────────────────
    if (!instanceId) {
      return json({ ok: false, error: "instance_id obrigatório" }, 400);
    }

    // Camada 1: o usuário enxerga essa instância? (RLS do tenant)
    const { data: visible, error: visErr } = await userClient
      .from("whatsapp_instances")
      .select("id")
      .eq("id", instanceId)
      .maybeSingle();
    if (visErr || !visible) {
      return json({ ok: false, error: "Instância não encontrada ou sem acesso" }, 403);
    }

    // Camada 2: service role lê as credenciais (nunca expostas ao browser)
    const { data: instance, error: instErr } = await serviceClient
      .from("whatsapp_instances")
      .select("api_url, api_key, webhook_url, metadata")
      .eq("id", instanceId)
      .single();
    if (instErr || !instance) {
      return json({ ok: false, error: "Instância não encontrada" }, 404);
    }

    const metadata = (instance.metadata as Record<string, unknown>) || {};
    const apiUrl = String(instance.api_url || instance.webhook_url || metadata.uazapi_url || "").replace(/\/$/, "");
    const apiKey = instance.api_key as string | null;
    if (!apiUrl || !apiKey) {
      return json({ ok: false, status: 200, data: { error: "Instância UAZAPI sem credenciais configuradas" } });
    }

    const jsonHeaders = { "Content-Type": "application/json", Accept: "application/json", token: apiKey };
    const params = body as Record<string, unknown>;

    switch (action) {
      case "instance_status":
        return await callUazapi(`${apiUrl}/instance/status`, { headers: { token: apiKey } });

      case "instance_connect":
        return await callUazapi(`${apiUrl}/instance/connect`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({}),
        });

      case "instance_disconnect":
        return await callUazapi(`${apiUrl}/instance/disconnect`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({}),
        });

      case "send_text": {
        const payload = pick(params, ["number", "text", "mentions", "replyid"]);
        if (!payload.number || !payload.text) {
          return json({ ok: false, error: "number e text são obrigatórios" }, 400);
        }
        return await callUazapi(`${apiUrl}/send/text`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "send_media": {
        const payload = pick(params, ["number", "type", "file", "text", "docName"]);
        if (!payload.number || !payload.type || !payload.file) {
          return json({ ok: false, error: "number, type e file são obrigatórios" }, 400);
        }
        return await callUazapi(`${apiUrl}/send/media`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "send_pix_button": {
        const payload = pick(params, ["number", "pixType", "pixKey", "pixName"]);
        if (!payload.number || !payload.pixType || !payload.pixKey) {
          return json({ ok: false, error: "number, pixType e pixKey são obrigatórios" }, 400);
        }
        return await callUazapi(`${apiUrl}/send/pix-button`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "message_react": {
        const payload = pick(params, ["id", "text"]);
        if (!payload.id) return json({ ok: false, error: "id é obrigatório" }, 400);
        return await callUazapi(`${apiUrl}/message/react`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "message_edit": {
        const payload = pick(params, ["id", "text"]);
        if (!payload.id || !payload.text) {
          return json({ ok: false, error: "id e text são obrigatórios" }, 400);
        }
        return await callUazapi(`${apiUrl}/message/edit`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "message_delete": {
        const payload = pick(params, ["id"]);
        if (!payload.id) return json({ ok: false, error: "id é obrigatório" }, 400);
        return await callUazapi(`${apiUrl}/message/delete`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(payload),
        });
      }

      case "contact_photo": {
        // Espelha useContactPhoto: POST /chat/details { number, preview: true }
        const payload = pick(params, ["number"]);
        if (!payload.number) return json({ ok: false, error: "number é obrigatório" }, 400);
        return await callUazapi(`${apiUrl}/chat/details`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ ...payload, preview: true }),
        });
      }

      case "group_list":
        return await callUazapi(`${apiUrl}/group/list`, { headers: { token: apiKey } });

      default:
        return json({ ok: false, error: `Ação não permitida: ${action}` }, 400);
    }
  } catch (err) {
    console.error("[uazapi-proxy] Erro:", err);
    return json({ ok: false, error: (err as Error)?.message || "Erro interno" }, 500);
  }
});
