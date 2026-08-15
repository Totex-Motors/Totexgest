// instagram-refresh-token — renova o token do flavor "Instagram Login".
//
// ⚠️ POR QUE ISSO EXISTE: o token do graph.instagram.com dura 60 DIAS. Sem
// renovação ele expira em silêncio e TODA a automação (webhook, campanhas,
// agente, cutucão) para de funcionar sem erro visível. O refresh reseta pra
// +60d, então um cron semanal faz o token nunca morrer.
//
// Se falhar 2 semanas seguidas o token morre de vez e é preciso reconectar a
// conta no painel da Meta — por isso a falha é registrada E notificada.
//
// Cron sugerido: semanal (ex: '0 6 * * 0').
// Multi-tenant: itera todas as contas connected; falha de uma não aborta as demais.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Tokens do IG Login vêm com expires_in ~60 dias; usamos isso como fallback.
const SIXTY_DAYS_SECONDS = 5_184_000;
// Avisa quando faltar menos que isso pro token expirar.
const ALERT_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

// deno-lint-ignore no-explicit-any
type Supa = any;

/** Avisa no WhatsApp do tenant, se houver grupo configurado. Best-effort. */
async function notify(supabase: Supa, tenantId: string, text: string): Promise<void> {
  try {
    const jid = await getIntegrationKey(supabase, "NOTIFICATIONS_GROUP_JID", tenantId);
    if (!jid) return; // sem grupo configurado — silencioso por design
    const { data: inst } = await supabase
      .from("whatsapp_instances")
      .select("api_url, api_key")
      .eq("tenant_id", tenantId)
      .eq("status", "connected")
      .eq("provider", "uazapi")
      .limit(1)
      .maybeSingle();
    if (!inst?.api_key) return;
    const base = inst.api_url || (await getIntegrationKey(supabase, "UAZAPI_ADMIN_URL", tenantId));
    if (!base) return;
    await fetch(`${String(base).replace(/\/$/, "")}/send/text`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", token: inst.api_key },
      body: JSON.stringify({ number: jid, text, linkPreview: false }),
    });
  } catch { /* notificação nunca quebra o fluxo */ }
}

export async function handleRefreshToken(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select("id, tenant_id, instagram_username, ig_login_token, ig_login_token_expires_at")
      .eq("status", "connected")
      .not("ig_login_token", "is", null);

    const results: Record<string, unknown>[] = [];

    for (const acc of accounts || []) {
      try {
        const r = await fetch(
          `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${acc.ig_login_token}`,
          { signal: AbortSignal.timeout(20_000) },
        );
        const d = await r.json().catch(() => ({}));

        if (r.ok && d.access_token) {
          const expiresAt = new Date(Date.now() + (d.expires_in || SIXTY_DAYS_SECONDS) * 1000);
          await supabase.from("instagram_business_accounts").update({
            ig_login_token: d.access_token,
            ig_login_token_expires_at: expiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", acc.id);
          results.push({
            account: acc.instagram_username,
            status: "refreshed",
            expires_at: expiresAt.toISOString(),
          });
          continue;
        }

        // Falhou: registra com o erro CRU (console se perde, tabela não)
        const erro = d?.error?.message || `HTTP ${r.status}`;
        await supabase.from("instagram_send_failures").insert({
          tenant_id: acc.tenant_id,
          source: "token_refresh",
          username: acc.instagram_username,
          error_raw: JSON.stringify(d?.error || d).slice(0, 2000),
        });
        results.push({ account: acc.instagram_username, status: "failed", error: erro });

        // Só alerta quando a expiração está próxima (ou é desconhecida) — evita
        // spam semanal por uma falha transitória com 50 dias de folga.
        const expMs = acc.ig_login_token_expires_at
          ? new Date(acc.ig_login_token_expires_at).getTime() - Date.now()
          : 0;
        if (!acc.ig_login_token_expires_at || expMs < ALERT_THRESHOLD_MS) {
          await notify(
            supabase,
            acc.tenant_id,
            `⚠️ Falha ao renovar o token do Instagram (@${acc.instagram_username}): ${erro}\n\n` +
              `O token do Instagram Login dura 60 dias. Se não renovar, a automação para em silêncio. ` +
              `Reconecte a conta em Configurações → Instagram Oficial.`,
          );
        }
      } catch (e) {
        results.push({
          account: acc.instagram_username,
          status: "failed",
          error: (e as Error).message,
        });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}
