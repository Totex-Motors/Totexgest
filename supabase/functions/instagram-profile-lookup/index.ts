// instagram-profile-lookup — traz o perfil público de um @ (bio, seguidores,
// posts recentes) via Business Discovery da Meta, SEM o vendedor abrir a página.
// Proxy server-side: o access_token NUNCA vai pro frontend.
//
// POST { "username": "fulano" }  (JWT do usuário — escopa tenant + conta IG)
//
// Business Discovery só funciona quando o @ alvo é conta PROFISSIONAL
// (Business/Creator) e pública. Conta pessoal → { available:false, reason }.
// Isso é limite da Meta, não do sistema.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const GRAPH_FB = "https://graph.facebook.com/v20.0";
const GRAPH_IG = "https://graph.instagram.com/v21.0";
const CACHE_HOURS = 12;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Campos do business_discovery (perfil + últimos 9 posts).
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
    const { username: rawUsername } = await req.json().catch(() => ({ username: "" }));
    const username = String(rawUsername || "").replace(/^@/, "").trim().toLowerCase();
    if (!username) return json({ error: "username é obrigatório" }, 400);

    // Auth: usuário logado + membro ativo (mesmo padrão do instagram-list-media)
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
      .select("is_active")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", user.id).maybeSingle();
    if (!tm?.is_active) return json({ error: "forbidden" }, 403);

    // 1) Cache: se raspamos há pouco e tem bio, devolve na hora.
    const { data: cached } = await supabase.from("instagram_profiles")
      .select("full_name, biography, follower_count, external_url, latest_posts, last_scraped_at")
      .eq("tenant_id", tenantId)
      .eq("username", username).maybeSingle();
    if (cached?.last_scraped_at && (cached.biography || (cached.latest_posts as unknown[])?.length)) {
      const ageH = (Date.now() - new Date(cached.last_scraped_at).getTime()) / 3.6e6;
      if (ageH < CACHE_HOURS) {
        return json({
          available: true,
          cached: true,
          profile: {
            username,
            name: cached.full_name,
            biography: cached.biography,
            followers_count: cached.follower_count,
            website: cached.external_url,
          },
          media: (cached.latest_posts as unknown[]) || [],
        });
      }
    }

    // 2) Conta IG conectada do tenant
    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select("instagram_business_id, access_token, page_access_token, ig_login_id, ig_login_token")
      .eq("tenant_id", tenantId)
      .eq("status", "connected")
      .limit(1);
    const account = accounts?.[0];
    if (!account) return json({ error: "Nenhuma conta IG conectada" }, 404);

    // 3) Business Discovery — IG Login (graph.instagram.com) tem prioridade,
    //    fallback pra Facebook Graph (conta ligada a Página).
    const useIgLogin = !!(account.ig_login_token && account.ig_login_id);
    const node = useIgLogin ? account.ig_login_id : account.instagram_business_id;
    const token = useIgLogin ? account.ig_login_token : (account.access_token || account.page_access_token);
    const base = useIgLogin ? GRAPH_IG : GRAPH_FB;
    if (!node || !token) return json({ error: "Conta IG sem token válido" }, 400);

    const url = `${base}/${node}?fields=business_discovery.username(${encodeURIComponent(username)})%7B${encodeURIComponent(BD_INNER)}%7D&access_token=${token}`;
    const r = await fetch(url);
    const payload = await r.json().catch(() => ({}));

    if (!r.ok) {
      // Meta devolve erro quando o @ é conta pessoal / privada / inexistente.
      const msg = payload?.error?.message || `graph ${r.status}`;
      const personal = /not.*business|Business Discovery|does not exist|Invalid user/i.test(msg);
      return json({
        available: false,
        reason: personal
          ? "Perfil pessoal ou privado — a Meta só libera bio/posts de contas profissionais públicas."
          : msg,
      });
    }

    const bd = payload?.business_discovery;
    if (!bd) return json({ available: false, reason: "Sem dados retornados pela Meta." });

    const media = (bd.media?.data || []).map((m: Record<string, unknown>) => ({
      id: m.id,
      caption: m.caption,
      media_type: m.media_type,
      media_url: m.media_url,
      thumbnail_url: m.thumbnail_url,
      permalink: m.permalink,
      like_count: m.like_count,
      comments_count: m.comments_count,
      timestamp: m.timestamp,
    }));

    // 4) Cacheia (UNIQUE real: tenant_id, username)
    await supabase.from("instagram_profiles").upsert({
      tenant_id: tenantId,
      username,
      full_name: bd.name || null,
      biography: bd.biography || null,
      follower_count: bd.followers_count ?? null,
      external_url: bd.website || null,
      latest_posts: media,
      last_scraped_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,username" });

    return json({
      available: true,
      cached: false,
      profile: {
        username: bd.username || username,
        name: bd.name || null,
        biography: bd.biography || null,
        followers_count: bd.followers_count ?? null,
        follows_count: bd.follows_count ?? null,
        media_count: bd.media_count ?? null,
        profile_picture_url: bd.profile_picture_url || null,
        website: bd.website || null,
      },
      media,
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
