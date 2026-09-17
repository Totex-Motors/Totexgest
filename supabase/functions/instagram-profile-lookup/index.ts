// instagram-profile-lookup — perfil do lead do Instagram DENTRO do CRM, sem o
// vendedor abrir a página do Instagram. Proxy server-side (o token NUNCA vai
// pro frontend).
//
// POST { "igsid": "417...", "username": "fulano" }  (JWT do usuário → tenant + conta)
//
// Duas fontes, combinadas:
//  1) User Profile API (graph.instagram.com) — funciona na conexão "IG Login".
//     Dá nome, foto, nº de seguidores, verificado e se a pessoa te segue.
//     Só p/ quem MANDOU DM (precisa do igsid = participant_instagram_id).
//  2) Business Discovery — só funciona se a conta IG estiver ligada a uma
//     Página do Facebook. Aí adiciona BIO, site e posts recentes. Se não
//     estiver disponível (caso "IG Login"), é ignorada em silêncio.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const GRAPH_FB = "https://graph.facebook.com/v20.0";
const GRAPH_IG = "https://graph.instagram.com/v21.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const USER_FIELDS =
  "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user,is_verified_user";
const BD_INNER =
  "id,username,name,biography,followers_count,follows_count,media_count,profile_picture_url,website," +
  "media.limit(9){id,caption,media_type,media_url,thumbnail_url,permalink,like_count,comments_count,timestamp}";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const raw = await req.json().catch(() => ({}));
    const igsid = String(raw?.igsid || "").trim();
    const username = String(raw?.username || "").replace(/^@/, "").trim().toLowerCase();
    if (!igsid && !username) return json({ error: "igsid ou username é obrigatório" }, 400);

    // Auth: usuário logado + membro ativo (padrão instagram-list-media)
    const auth = req.headers.get("Authorization") || "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user } } = await supabase.auth.getUser(jwt);
    if (!user) return json({ error: "unauthenticated" }, 401);

    const tenantId = getTenantIdFromRequest(req);
    if (!tenantId) return json({ error: "forbidden" }, 403);
    const { data: tm } = await supabase.from("team_members")
      .select("is_active").eq("tenant_id", tenantId).eq("auth_user_id", user.id).maybeSingle();
    if (!tm?.is_active) return json({ error: "forbidden" }, 403);

    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select("instagram_business_id, access_token, page_access_token, ig_login_id, ig_login_token")
      .eq("tenant_id", tenantId)
      .eq("status", "connected")
      .limit(1);
    const account = accounts?.[0];
    if (!account) return json({ error: "Nenhuma conta IG conectada" }, 404);

    const profile: Record<string, unknown> = {};
    let media: Array<Record<string, unknown>> = [];
    let available = false;

    // 1) User Profile API (IG Login) — dá seguidores/verificado/segue-você
    if (igsid && account.ig_login_token) {
      try {
        const r = await fetch(`${GRAPH_IG}/${igsid}?fields=${USER_FIELDS}&access_token=${account.ig_login_token}`);
        if (r.ok) {
          const u = await r.json();
          profile.username = u.username || username || null;
          profile.name = u.name || null;
          profile.profile_pic = u.profile_pic || null;
          profile.followers_count = u.follower_count ?? null;
          profile.is_verified = !!u.is_verified_user;
          profile.follows_you = !!u.is_user_follow_business;   // a pessoa segue a loja
          profile.you_follow = !!u.is_business_follow_user;    // a loja segue a pessoa
          available = true;
        }
      } catch { /* segue pro passo 2 */ }
    }

    // 2) Business Discovery (só com Página do FB) — adiciona BIO + site + posts
    if (username) {
      const tries: Array<{ node?: string | null; token?: string | null; base: string }> = [
        { node: account.instagram_business_id, token: account.access_token || account.page_access_token, base: GRAPH_FB },
      ];
      for (const t of tries) {
        if (!t.node || !t.token) continue;
        try {
          const url = `${t.base}/${t.node}?fields=business_discovery.username(${encodeURIComponent(username)})%7B${encodeURIComponent(BD_INNER)}%7D&access_token=${t.token}`;
          const r = await fetch(url);
          if (!r.ok) continue;
          const bd = (await r.json())?.business_discovery;
          if (!bd) continue;
          profile.username = bd.username || profile.username || username;
          profile.name = bd.name ?? profile.name ?? null;
          profile.biography = bd.biography ?? null;
          profile.website = bd.website ?? null;
          profile.followers_count = bd.followers_count ?? profile.followers_count ?? null;
          profile.follows_count = bd.follows_count ?? null;
          profile.media_count = bd.media_count ?? null;
          if (bd.profile_picture_url) profile.profile_pic = bd.profile_picture_url;
          media = (bd.media?.data || []).map((m: Record<string, unknown>) => ({
            id: m.id, caption: m.caption, media_type: m.media_type, media_url: m.media_url,
            thumbnail_url: m.thumbnail_url, permalink: m.permalink,
            like_count: m.like_count, comments_count: m.comments_count, timestamp: m.timestamp,
          }));
          available = true;
          // Cacheia bio/posts (UNIQUE real: tenant_id, username)
          await supabase.from("instagram_profiles").upsert({
            tenant_id: tenantId, username: profile.username,
            full_name: bd.name || null, biography: bd.biography || null,
            follower_count: bd.followers_count ?? null, external_url: bd.website || null,
            latest_posts: media, last_scraped_at: new Date().toISOString(),
          }, { onConflict: "tenant_id,username" });
          break;
        } catch { /* ignora */ }
      }
    }

    if (!available) {
      return json({
        available: false,
        reason: "Sem dados via API para este perfil (conta pessoal/privada ou sem DM recebido).",
      });
    }
    return json({ available: true, profile, media });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
