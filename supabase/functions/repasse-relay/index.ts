// repasse-relay — teste e reprocessamento manual do Repasse Relay.
//
// O fluxo normal roda dentro do whatsapp-webhook (maybeRelayRepasse). Esta função
// serve pra:
//   - action "preview":   gera o post a partir de um texto colado, SEM enviar (botão "Testar").
//   - action "reprocess": reprocessa uma mensagem (envia de verdade e loga).
//
// Auth em 2 camadas (igual uazapi-proxy): o usuário precisa enxergar a instância
// (RLS do tenant); o trabalho roda com service role.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { maybeRelayRepasse, previewRepasse } from "../_shared/repasse.ts";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.action !== "string") {
      return json({ ok: false, error: "Body inválido: { action, instance_id, ... }" }, 400);
    }
    const { action, instance_id: instanceId, source_group_jid: sourceGroupJid, text, message_id: messageId } = body as {
      action: string;
      instance_id?: string;
      source_group_jid?: string;
      text?: string;
      message_id?: string;
    };

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Não autenticado" }, 401);
    if (!instanceId) return json({ ok: false, error: "instance_id obrigatório" }, 400);
    if (!sourceGroupJid) return json({ ok: false, error: "source_group_jid obrigatório" }, 400);

    // Camada 1: o usuário enxerga a instância? (RLS do tenant)
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: visible } = await userClient
      .from("whatsapp_instances")
      .select("id")
      .eq("id", instanceId)
      .maybeSingle();
    if (!visible) return json({ ok: false, error: "Instância não encontrada ou sem acesso" }, 403);

    const tenantId = getTenantIdFromRequest(req);

    if (action === "preview") {
      if (!text) return json({ ok: false, error: "text obrigatório" }, 400);
      const result = await previewRepasse(serviceClient, { instanceId, sourceGroupJid, text, tenantId });
      return json({ ok: true, data: result });
    }

    if (action === "reprocess") {
      if (!text || !messageId) return json({ ok: false, error: "text e message_id obrigatórios" }, 400);
      const relayed = await maybeRelayRepasse(serviceClient, {
        instanceId,
        tenantId,
        groupJid: sourceGroupJid,
        messageId,
        text,
      });
      return json({ ok: true, data: { relayed } });
    }

    return json({ ok: false, error: `Ação não permitida: ${action}` }, 400);
  } catch (err) {
    console.error("[repasse-relay] Erro:", err);
    return json({ ok: false, error: (err as Error)?.message || "Erro interno" }, 500);
  }
});
