// instagram-send-dm v2 — envia DM do Instagram via META SEND API direto (uChat REMOVIDO 13/07/2026).
//
// Regras Meta: só dá pra enviar se temos o PSID da pessoa (chega em todo webhook `messages`)
// e dentro da janela de 24h desde a última msg dela (fora disso a API retorna erro, que repassamos).
//
// PSID fica em instagram_conversations.participant_instagram_id — populado pelo webhook Meta.
// Conversas LEGADO do uChat têm user_ns (começa com letra) → não dá pra enviar até a pessoa
// mandar nova msg (aí o webhook Meta atualiza o campo com o PSID real).
//
// Interface mantida (front não muda): { conversation_id | instagram_username, lead_id?, message, message_type, media_url }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";
import { getConnectedAccount, resolveAccountFromEvent } from "../instagram-webhook/meta-campaign.ts";

const GRAPH = "https://graph.facebook.com/v20.0";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** PSIDs são numéricos; user_ns legado do uChat começa com letra (ex: f1a2b3...) */
function isPsid(id: string | null | undefined): boolean {
  return !!id && /^\d+$/.test(id);
}

function buildMetaMessage(messageType: string, message: string, mediaUrl?: string) {
  if (["image", "video", "audio"].includes(messageType) && mediaUrl) {
    return { attachment: { type: messageType, payload: { url: mediaUrl } } };
  }
  return { text: message };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const {
      conversation_id,
      instagram_username,
      lead_id,
      message,
      message_type = "text",
      media_url,
      tenant_id: bodyTenantId,
    } = await req.json();

    if (!conversation_id && !instagram_username) {
      return jsonResponse({ success: false, error: "conversation_id ou instagram_username é obrigatório" });
    }
    if (!message && message_type === "text") {
      return jsonResponse({ success: false, error: "message é obrigatório para tipo text" });
    }

    // ── Resolve TENANT (padrão B3: pela entidade) ──
    // 1) conversa (tem tenant_id)  2) body.tenant_id (service-to-service)
    // 3) JWT do caller (UI)        4) única conta connected (single-tenant)
    // deno-lint-ignore no-explicit-any
    let conversation: any = null;
    let tenantId: string | null = bodyTenantId || getTenantIdFromRequest(req);

    if (conversation_id) {
      const { data } = await supabase
        .from("instagram_conversations")
        .select("id, tenant_id, participant_instagram_id, participant_username")
        .eq("id", conversation_id)
        .maybeSingle();
      conversation = data;
      if (!conversation) return jsonResponse({ success: false, error: "Conversa não encontrada." });
      tenantId = conversation.tenant_id || tenantId;
    }
    if (!tenantId) {
      const single = await resolveAccountFromEvent(supabase, null);
      tenantId = single?.tenant_id || null;
    }
    if (!tenantId) {
      return jsonResponse({ success: false, error: "Não deu pra identificar o tenant (2+ contas conectadas). Passe tenant_id ou conversation_id." });
    }

    // Conta conectada do tenant (page token pro Send API)
    const account = await getConnectedAccount(supabase, tenantId);
    if (!account?.ig_login_token && !account?.page_access_token) {
      return jsonResponse({ success: false, error: "Conta IG sem token configurado" });
    }

    if (!conversation) {
      // Por username: pega a conversa mais recente COM PSID (pode haver duplicadas do legado)
      const { data: convs } = await supabase
        .from("instagram_conversations")
        .select("id, tenant_id, participant_instagram_id, participant_username")
        .eq("tenant_id", tenantId)
        .eq("participant_username", instagram_username)
        .order("last_message_at", { ascending: false })
        .limit(10);
      // deno-lint-ignore no-explicit-any
      conversation = (convs || []).find((c: any) => isPsid(c.participant_instagram_id)) || convs?.[0] || null;
      if (!conversation) {
        return jsonResponse({
          success: false,
          error: `@${instagram_username} não tem conversa registrada. A pessoa precisa te mandar uma DM primeiro (regra da Meta).`,
        });
      }
    }

    let psid: string | null = conversation.participant_instagram_id;
    if (!isPsid(psid)) {
      // Legado uChat (user_ns) — 2 fontes alternativas de PSID:
      if (conversation.participant_username) {
        // a) outra conversa do mesmo username que já tenha PSID
        const { data: alt } = await supabase
          .from("instagram_conversations")
          .select("participant_instagram_id")
          .eq("tenant_id", tenantId)
          .eq("participant_username", conversation.participant_username)
          .order("last_message_at", { ascending: false })
          .limit(10);
        // deno-lint-ignore no-explicit-any
        psid = (alt || []).map((c: any) => c.participant_instagram_id).find((id: string) => isPsid(id)) || null;

        // b) recipient de campanha (Private Reply devolveu o PSID)
        if (!isPsid(psid)) {
          const { data: rec } = await supabase
            .from("instagram_comment_campaign_recipients")
            .select("recipient_psid")
            .eq("tenant_id", tenantId)
            .eq("commenter_username", conversation.participant_username)
            .not("recipient_psid", "is", null)
            .order("dm_sent_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          psid = rec?.recipient_psid || null;
        }
      }
      if (!isPsid(psid)) {
        return jsonResponse({
          success: false,
          error: "Sem PSID da Meta pra essa pessoa ainda. Dá pra responder assim que ela mandar a próxima mensagem.",
        });
      }
    }

    // ── Envia via Meta Send API ──
    // Flavor NOVO (graph.instagram.com + Instagram Login token): responder DM da própria
    // conta funciona em Standard Access, SEM App Review (validado 13/07/2026, deep research 3-0).
    // Flavor velho (graph.facebook.com + page token) exige Advanced Access — só fallback.
    const useNewFlavor = !!(account.ig_login_token && account.ig_login_id);
    const sendUrl = useNewFlavor
      ? `https://graph.instagram.com/v20.0/${account.ig_login_id}/messages`
      : `${GRAPH}/${account.facebook_page_id}/messages`;
    const sendToken = useNewFlavor ? account.ig_login_token : account.page_access_token;
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: psid },
        message: buildMetaMessage(message_type, message, media_url),
        access_token: sendToken,
      }),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      const metaErr = sendData?.error?.message || `Meta Send API ${sendRes.status}`;
      // Erro mais comum: janela 24h fechada
      const friendly = /outside of allowed window|24 hour/i.test(metaErr)
        ? "Janela de 24h fechada — a Meta só permite responder até 24h após a última msg da pessoa."
        : metaErr;
      return jsonResponse({ success: false, error: friendly, meta_error: metaErr });
    }

    // ── Vincula lead se veio ──
    if (lead_id) {
      await supabase
        .from("instagram_conversations")
        .update({ lead_id })
        .eq("id", conversation.id)
        .is("lead_id", null);
    }

    // ── Salva no inbox ──
    const now = new Date().toISOString();
    const { data: savedMessage } = await supabase
      .from("instagram_messages")
      .insert({
        tenant_id: tenantId,
        conversation_id: conversation.id,
        instagram_message_id: sendData.message_id || null,
        content: message || null,
        message_type,
        media_url: media_url || null,
        is_from_me: true,
        sender_username: account.instagram_username,
        status: "sent",
        sent_at: now,
      })
      .select("id")
      .single();

    await supabase
      .from("instagram_conversations")
      .update({
        last_message: message_type === "text" ? message : `[${message_type}]`,
        last_message_at: now,
        last_agent_message_at: now,
        // Se resolvemos PSID de outra conversa, persiste nesta
        participant_instagram_id: psid,
      })
      .eq("id", conversation.id);

    return jsonResponse({
      success: true,
      conversation_id: conversation.id,
      message_id: savedMessage?.id || null,
      meta_message_id: sendData.message_id || null,
      recipient_psid: psid,
    });
  } catch (error) {
    console.error("instagram-send-dm error:", error);
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : "Internal server error" },
      500,
    );
  }
});
