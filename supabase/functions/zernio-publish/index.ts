// zernio-publish — espelha o carrossel do Studio (instagram_publications.paths) nas OUTRAS
// redes via Zernio (Facebook, TikTok, Threads…). Instagram continua pelo instagram-publish.
//
// Ações (POST, usuário logado; tenant do JWT):
//   accounts  { campaignId? }                → profile + contas conectadas + histórico da campanha
//   connect   { platform, redirect_url }     → authUrl da Zernio pra conectar a rede
//   publish   { campaignId, accountIds[], scheduledFor? } → POST /v1/posts
//   status    { campaignId }                 → atualiza as publicações da campanha (GET /v1/posts/{id})
//   disconnect{ accountId }                  → DELETE /v1/accounts/{id}
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCaller, deny } from "../_shared/auth.ts";
import { ZERNIO_PLATFORMS, ZernioError, ensureProfile, listAccounts, zernio, zernioKey } from "../_shared/zernio.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const BUCKET = "instagram-publications";
const SIGNED_TTL = 7 * 24 * 3600; // Zernio baixa a mídia na hora de publicar (agendado pode demorar dias)
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function mapPlatforms(post: any, prev: any[] = []) {
  const byAcc = new Map((prev || []).map((p: any) => [p.account_id, p]));
  return (post?.platforms || []).map((p: any) => ({
    platform: p.platform,
    account_id: p.accountId,
    username: byAcc.get(p.accountId)?.username || null,
    status: p.status || post?.status || null,
    url: p.platformPostUrl || p.publishedUrl || null,
    error: p.errorMessage || p.error || null,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  const caller = await getCaller(req);
  if (!caller.ok) return deny();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "Corpo inválido" }, 400); }
  const action = String(body.action || "");

  // Tenant: do usuário; service/internal podem apontar no body.
  const tenantId: string | null = caller.user ? (caller.user.superadmin && body.tenant_id ? body.tenant_id : caller.user.tenantId) : (body.tenant_id || null);
  if (!tenantId) return json({ error: "Empresa não identificada." }, 403);
  if (caller.user && !caller.user.superadmin) {
    const { data: member } = await db.from("team_members").select("is_active, role").eq("tenant_id", tenantId).eq("auth_user_id", caller.user.id).maybeSingle();
    if (!member?.is_active) return json({ error: "Acesso não autorizado." }, 403);
  }

  const apiKey = await zernioKey(db);
  if (!apiKey) return json({ error: "Cadastre a chave ZERNIO_API_KEY em Configurações › Integrações.", configured: false }, 200);

  try {
    const { data: tenant } = await db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    const profileId = await ensureProfile(db, apiKey, tenantId, tenant?.name || "Loja");

    if (action === "accounts") {
      const accounts = await listAccounts(apiKey, profileId);
      let history: any[] = [];
      if (body.campaignId && uuid.test(body.campaignId)) {
        const { data } = await db.from("social_publications").select("id, zernio_post_id, status, platforms, media_count, scheduled_for, created_at")
          .eq("tenant_id", tenantId).eq("campaign_id", body.campaignId).order("created_at", { ascending: false }).limit(10);
        history = data || [];
      }
      return json({
        configured: true,
        profileId,
        platforms: ZERNIO_PLATFORMS,
        accounts: accounts.map((a) => ({
          id: a._id, platform: a.platform, username: a.username || a.displayName || a._id,
          picture: a.profilePicture || null, url: a.profileUrl || null,
          active: a.isActive !== false && !a.needsReconnection, needs_reconnection: !!a.needsReconnection,
          aceita_imagem: ZERNIO_PLATFORMS[a.platform]?.aceitaImagem ?? true,
        })),
        history,
      });
    }

    if (action === "connect") {
      const platform = String(body.platform || "");
      if (!ZERNIO_PLATFORMS[platform]) return json({ error: "Rede não suportada." }, 400);
      const redirect = String(body.redirect_url || "");
      if (!/^https?:\/\//i.test(redirect)) return json({ error: "redirect_url inválida." }, 400);
      const qs = new URLSearchParams({ profileId, redirect_url: redirect, language: "pt-BR", scopes: "posting,analytics" });
      const r = await zernio<any>(apiKey, "GET", `/connect/${platform}?${qs.toString()}`);
      if (!r?.authUrl) return json({ error: "Zernio não devolveu o link de conexão." }, 502);
      return json({ authUrl: r.authUrl });
    }

    if (action === "disconnect") {
      const accountId = String(body.accountId || "");
      if (!accountId) return json({ error: "Conta inválida." }, 400);
      // Só contas do profile desta loja
      const mine = (await listAccounts(apiKey, profileId)).some((a) => a._id === accountId);
      if (!mine) return json({ error: "Conta não pertence a esta loja." }, 403);
      await zernio(apiKey, "DELETE", `/accounts/${encodeURIComponent(accountId)}`);
      return json({ ok: true });
    }

    if (action === "publish") {
      const campaignId = String(body.campaignId || "");
      if (!uuid.test(campaignId)) return json({ error: "Campanha inválida." }, 400);
      const accountIds: string[] = Array.isArray(body.accountIds) ? body.accountIds.map(String) : [];
      if (accountIds.length === 0) return json({ error: "Escolha pelo menos uma rede." }, 400);

      const { data: pub } = await db.from("instagram_publications").select("caption, paths, status").eq("campaign_id", campaignId).eq("tenant_id", tenantId).maybeSingle();
      const paths: string[] = Array.isArray(pub?.paths) ? pub!.paths : [];
      if (!pub || paths.length === 0) return json({ error: "Devolva as artes do Studio ao Totexgest primeiro." }, 409);

      const accounts = await listAccounts(apiKey, profileId);
      const chosen = accounts.filter((a) => accountIds.includes(a._id));
      if (chosen.length !== accountIds.length) return json({ error: "Alguma conta escolhida não é desta loja." }, 403);
      const semImagem = chosen.filter((a) => ZERNIO_PLATFORMS[a.platform]?.aceitaImagem === false);
      if (semImagem.length) return json({ error: `${semImagem.map((a) => ZERNIO_PLATFORMS[a.platform]?.label || a.platform).join(", ")} só aceita vídeo. Tire da seleção.` }, 400);

      // Mídia: URL assinada (HTTPS, serve o arquivo cru) — Zernio aceita URL direta.
      const mediaItems: { url: string; type: "image" }[] = [];
      for (const p of paths) {
        const { data, error } = await db.storage.from(BUCKET).createSignedUrl(p, SIGNED_TTL);
        if (error || !data) return json({ error: "Arte indisponível no armazenamento." }, 500);
        mediaItems.push({ url: data.signedUrl, type: "image" });
      }

      const caption = String(pub.caption || "");
      const platforms: any[] = [];
      for (const a of chosen) {
        const entry: any = { platform: a.platform, accountId: a._id };
        if (a.platform === "tiktok") {
          // Foto-carrossel: precisa do privacy_level que o criador permite + consentimentos.
          let privacy = "PUBLIC_TO_EVERYONE";
          try {
            const info = await zernio<any>(apiKey, "GET", `/accounts/${encodeURIComponent(a._id)}/tiktok/creator-info`);
            const levels: { value: string }[] = info?.privacyLevels || [];
            if (levels.length && !levels.some((l) => l.value === privacy)) privacy = levels[0].value;
          } catch { /* usa padrão */ }
          entry.platformSpecificData = {
            mediaType: "photo", privacyLevel: privacy, contentPreviewConfirmed: true, expressConsentGiven: true,
            allowComment: true, photoCoverIndex: 0, description: caption.slice(0, 4000),
          };
        } else if (a.platform === "pinterest") {
          entry.platformSpecificData = { title: caption.split("\n")[0].slice(0, 100) };
        }
        platforms.push(entry);
      }

      const scheduledFor = body.scheduledFor ? new Date(body.scheduledFor) : null;
      const agendar = scheduledFor && !isNaN(scheduledFor.getTime()) && scheduledFor.getTime() > Date.now() + 60_000;
      const payload: any = {
        content: caption,
        mediaItems,
        platforms,
        timezone: "America/Sao_Paulo",
        metadata: { tenant_id: tenantId, campaign_id: campaignId, origem: "totexgest-studio" },
        ...(agendar ? { scheduledFor: scheduledFor!.toISOString() } : { publishNow: true }),
      };

      const { data: row, error: insErr } = await db.from("social_publications").insert({
        tenant_id: tenantId, campaign_id: campaignId, status: agendar ? "scheduled" : "publishing",
        caption, media_count: mediaItems.length, scheduled_for: agendar ? scheduledFor!.toISOString() : null,
        platforms: chosen.map((a) => ({ platform: a.platform, account_id: a._id, username: a.username || a.displayName || null, status: "pending", url: null, error: null })),
        created_by: caller.user?.id || null,
      }).select("id, platforms").single();
      if (insErr || !row) return json({ error: "Não foi possível registrar a publicação." }, 500);

      let post: any = null;
      try {
        const r = await zernio<any>(apiKey, "POST", "/posts", payload, { "Idempotency-Key": row.id });
        post = r?.post || r;
      } catch (e) {
        const ze = e as ZernioError;
        await db.from("social_publications").update({
          status: "failed", updated_at: new Date().toISOString(),
          platforms: row.platforms.map((p: any) => ({ ...p, status: "failed", error: ze.message })),
        }).eq("id", row.id);
        return json({ error: `Zernio recusou: ${ze.message}`, publication_id: row.id }, 502);
      }

      const zernioPostId = post?._id || post?.id || post?.postId || null;
      const platformsOut = post?.platforms?.length ? mapPlatforms(post, row.platforms) : row.platforms;
      const { data: updated } = await db.from("social_publications").update({
        zernio_post_id: zernioPostId, status: post?.status || (agendar ? "scheduled" : "publishing"),
        platforms: platformsOut, updated_at: new Date().toISOString(),
      }).eq("id", row.id).select("id, zernio_post_id, status, platforms, media_count, scheduled_for, created_at").single();
      return json({ publication: updated });
    }

    if (action === "status") {
      const campaignId = String(body.campaignId || "");
      if (!uuid.test(campaignId)) return json({ error: "Campanha inválida." }, 400);
      const { data: rows } = await db.from("social_publications").select("id, zernio_post_id, status, platforms, media_count, scheduled_for, created_at")
        .eq("tenant_id", tenantId).eq("campaign_id", campaignId).order("created_at", { ascending: false }).limit(10);
      const out: any[] = [];
      for (const r of rows || []) {
        if (r.zernio_post_id && !["published", "failed", "cancelled"].includes(r.status)) {
          try {
            const g = await zernio<any>(apiKey, "GET", `/posts/${encodeURIComponent(r.zernio_post_id)}`);
            const post = g?.post || g;
            const upd = { status: post?.status || r.status, platforms: mapPlatforms(post, r.platforms), updated_at: new Date().toISOString() };
            await db.from("social_publications").update(upd).eq("id", r.id);
            out.push({ ...r, ...upd });
            continue;
          } catch { /* mantém o que tem */ }
        }
        out.push(r);
      }
      return json({ history: out });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    const ze = e as ZernioError;
    console.error("[zernio-publish]", action, ze.message, ze.body ?? "");
    return json({ error: ze.message || "Erro na Zernio." }, ze.status === 401 ? 502 : 500);
  }
});
