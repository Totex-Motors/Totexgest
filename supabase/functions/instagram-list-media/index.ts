// instagram-list-media — lista posts/reels recentes da conta IG conectada.
// Proxy server-side: o access_token NUNCA vai pro frontend.
// Usado pelo seletor de post em /marketing/instagram-comments.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const GRAPH = "https://graph.facebook.com/v20.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    // Auth: exige user autenticado + team member ativo
    const auth = req.headers.get("Authorization") || "";
    const jwt = auth.replace(/^Bearer\s+/i, "");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: { user } } = await supabase.auth.getUser(jwt);
    if (!user) return json({ error: "unauthenticated" }, 401);

    // Tenant do JWT (chamada da UI) — escopa membro e conta.
    // Multi-tenant real (Totexgest): sem claim de tenant não tem fallback.
    const tenantId = getTenantIdFromRequest(req);
    if (!tenantId) return json({ error: "forbidden" }, 403);
    const { data: tm } = await supabase.from("team_members")
      .select("is_active")
      .eq("tenant_id", tenantId)
      .eq("auth_user_id", user.id).maybeSingle();
    if (!tm?.is_active) return json({ error: "forbidden" }, 403);

    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select("instagram_business_id, access_token, page_access_token, ig_login_id, ig_login_token")
      .eq("tenant_id", tenantId)
      .eq("status", "connected")
      .limit(1);
    const account = accounts?.[0];
    if (!account) return json({ error: "Nenhuma conta IG conectada" }, 404);

    // A Meta tem DOIS flavors e o endpoint de leitura muda com ele:
    //  - IG Login (novo, recomendado) → graph.instagram.com/me/media
    //  - Página do Facebook (antigo)  → graph.facebook.com/{ig_business_id}/media
    // Chamar o antigo com token do IG Login devolve lista VAZIA sem erro —
    // a tela mostrava "nenhum post" mesmo com posts publicados.
    const FIELDS =
      "id,permalink,caption,media_url,thumbnail_url,comments_count,timestamp,media_type";
    const useIgLogin = !!account.ig_login_token;
    const url = useIgLogin
      ? `https://graph.instagram.com/v20.0/me/media?fields=${FIELDS}&limit=24&access_token=${account.ig_login_token}`
      : `${GRAPH}/${account.instagram_business_id}/media?fields=${FIELDS}&limit=24&access_token=${account.access_token || account.page_access_token}`;
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return json({ error: err?.error?.message || `graph ${r.status}` }, 502);
    }
    const data = await r.json();
    return json({ media: data?.data || [] });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
