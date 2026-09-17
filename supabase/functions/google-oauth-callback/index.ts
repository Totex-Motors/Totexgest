// google-oauth-callback — troca o `code` do OAuth do Google por tokens e grava
// a conexão no team_members. Roda no servidor porque usa o GOOGLE_CLIENT_SECRET
// (jamais no navegador). Chamada pela UI (JWT do usuário) após o Google redirecionar
// pra /configuracoes?code=...
//
// POST { code, redirect_uri, team_member_id }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { requireIntegrationKey } from "../_shared/config.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { code, redirect_uri, team_member_id } = await req.json().catch(() => ({}));
    if (!code || !redirect_uri || !team_member_id) {
      return json({ success: false, error: "code, redirect_uri e team_member_id são obrigatórios" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Auth: usuário logado precisa ser o dono do team_member (evita conectar a conta de outro).
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await supabase.auth.getUser(jwt);
    if (!user) return json({ success: false, error: "unauthenticated" }, 401);

    const { data: member } = await supabase
      .from("team_members")
      .select("id, auth_user_id, tenant_id")
      .eq("id", team_member_id)
      .maybeSingle();
    if (!member) return json({ success: false, error: "Membro não encontrado" }, 404);
    if (member.auth_user_id && member.auth_user_id !== user.id) {
      return json({ success: false, error: "forbidden" }, 403);
    }

    // Chaves do Google (config do tenant → fallback global). Secret NUNCA vai pro front.
    const clientId = await requireIntegrationKey(supabase, "GOOGLE_CLIENT_ID", member.tenant_id);
    const clientSecret = await requireIntegrationKey(supabase, "GOOGLE_CLIENT_SECRET", member.tenant_id);

    // Troca o authorization code por access_token + refresh_token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      // Erros comuns: redirect_uri_mismatch, invalid_grant (code já usado/expirado)
      const detail = tokens?.error_description || tokens?.error || `HTTP ${tokenRes.status}`;
      console.error("[google-oauth-callback] token exchange failed:", detail);
      return json({ success: false, error: `Google recusou a troca do código: ${detail}` }, 502);
    }

    const accessToken = tokens.access_token as string | undefined;
    const refreshToken = tokens.refresh_token as string | undefined;
    const expiresIn = Number(tokens.expires_in || 3600);
    if (!accessToken) {
      return json({ success: false, error: "Google não retornou access_token" }, 502);
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Grava a conexão. refresh_token só vem no 1º consent (prompt=consent garante):
    // se não vier, preserva o que já existe pra não perder a conexão.
    const update: Record<string, unknown> = {
      google_access_token: accessToken,
      google_token_expires_at: expiresAt,
      google_calendar_connected: true,
    };
    if (refreshToken) update.google_refresh_token = refreshToken;

    const { error: upErr } = await supabase
      .from("team_members")
      .update(update)
      .eq("id", team_member_id);
    if (upErr) {
      console.error("[google-oauth-callback] update failed:", upErr.message);
      return json({ success: false, error: "Falha ao salvar a conexão no banco" }, 500);
    }

    return json({ success: true, has_refresh_token: !!refreshToken });
  } catch (e) {
    console.error("[google-oauth-callback] error:", (e as Error)?.message);
    return json({ success: false, error: (e as Error)?.message || "Erro inesperado" }, 500);
  }
});
