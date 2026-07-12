import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

/**
 * fetch-meta-creative — busca dados do criativo de um anúncio Meta e cacheia em ad_creatives.
 * Multi-tenant: lê access_token de meta_ads_accounts do tenant.
 * Idempotente: upsert por (tenant_id, ad_id).
 *
 * POST { tenant_id, ad_id }
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_API = "https://graph.facebook.com/v21.0";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const reqBody = await req.json();
    const { ad_id } = reqBody;
    // tenant explícito no body > tenant do JWT do chamador
    const tenant_id = reqBody.tenant_id || getTenantIdFromRequest(req);
    if (!tenant_id || !ad_id) {
      return new Response(JSON.stringify({ error: "tenant_id and ad_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Já temos cacheado E com storage_url? (não refetch se < 7 dias E imagem persistida)
    const { data: cached } = await supabase
      .from("ad_creatives")
      .select("id, fetched_at, storage_url")
      .eq("tenant_id", tenant_id)
      .eq("ad_id", ad_id)
      .maybeSingle();

    if (cached?.storage_url) {
      const ageDays = (Date.now() - new Date(cached.fetched_at).getTime()) / 86400000;
      if (ageDays < 7) {
        return new Response(JSON.stringify({ status: "cached", id: cached.id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    // Se já tem o creative mas sem storage_url, força refetch pra subir a imagem pro nosso storage.

    // Pega token de qualquer ad account ativa do tenant (todas usam mesmo system user token)
    const { data: account } = await supabase
      .from("meta_ads_accounts")
      .select("access_token")
      .eq("tenant_id", tenant_id)
      .eq("is_active", true)
      .not("access_token", "is", null)
      .limit(1)
      .maybeSingle();

    if (!account?.access_token) {
      return new Response(JSON.stringify({ error: "no meta token for tenant" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Busca o ad + creative + campaign no Graph
    const fields = "name,account_id,campaign{id,name},creative{id,title,body,thumbnail_url,image_url,image_hash,object_story_spec,asset_feed_spec,video_id}";
    const url = `${META_API}/${ad_id}?fields=${encodeURIComponent(fields)}&access_token=${account.access_token}`;
    const res = await fetch(url);
    let json = await res.json();

    // Se falhou como ad, tenta como adset (utm_term pode ser adset_id) — pega o 1º ad do adset
    if (json.error?.message?.includes("nonexisting field (creative)")) {
      const adsUrl = `${META_API}/${ad_id}/ads?fields=${encodeURIComponent(fields)}&limit=1&access_token=${account.access_token}`;
      const adsRes = await fetch(adsUrl);
      const adsJson = await adsRes.json();
      const firstAd = adsJson?.data?.[0];
      if (firstAd) {
        json = firstAd; // usa o ad real, mas mantém o id original (adset_id) na cache abaixo
      }
    }

    if (json.error) {
      return new Response(JSON.stringify({ error: "meta api", details: json.error }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const c = json.creative || {};
    const story = c.object_story_spec || {};
    const linkData = story.link_data || {};
    const videoData = story.video_data || {};
    const firstChild = linkData.child_attachments?.[0] || {};
    const feed = c.asset_feed_spec || {};
    const feedTitle = feed.titles?.[0]?.text;
    const feedBody = feed.bodies?.[0]?.text;
    const feedImageHash = feed.images?.[0]?.hash;
    const feedVideo = feed.videos?.[0];
    // Advantage+ Video: thumbnail dentro de asset_feed_spec.videos[] vem em 160x160 (vs 64x64 do creative.thumbnail_url)
    const feedVideoThumb = feedVideo?.thumbnail_url;
    const feedVideoId = feedVideo?.video_id;

    const headline = c.title || linkData.name || videoData.title || firstChild.name || feedTitle || null;
    const body = c.body || linkData.message || videoData.message || linkData.description || firstChild.description || feedBody || null;
    const thumbnail_url = feedVideoThumb || c.thumbnail_url || linkData.picture || firstChild.picture || null;
    const videoId = c.video_id || feedVideoId;
    const video_url = videoId ? `https://www.facebook.com/watch/?v=${videoId}` : null;

    // Tenta puxar imagem em alta resolução via /act_<id>/adimages (1080x1080).
    // Hash pode vir em creative.image_hash ou asset_feed_spec.images[0].hash.
    let image_url = c.image_url || null;
    const hash = c.image_hash || feedImageHash;
    const accountId = json.account_id;
    if (!image_url && hash && accountId) {
      try {
        const imgUrl = `${META_API}/act_${accountId}/adimages?hashes=${encodeURIComponent(JSON.stringify([hash]))}&fields=url,height,width&access_token=${account.access_token}`;
        const imgRes = await fetch(imgUrl);
        const imgJson = await imgRes.json();
        image_url = imgJson?.data?.[0]?.url || null;
      } catch (_) { /* mantém null */ }
    }
    if (!image_url) image_url = linkData.picture || firstChild.picture || null;

    // Baixa a imagem do CDN Meta e sobe pro Supabase Storage pra ter URL permanente.
    // As URLs do CDN Meta expiram em ~4-7 dias (oe= no querystring), por isso
    // creatives "antigos" perdem a thumb. Storage nosso = URL pra sempre.
    let storage_path: string | null = null;
    let storage_url: string | null = null;
    let storage_synced_at: string | null = null;
    const sourceImageUrl = image_url || thumbnail_url;
    if (sourceImageUrl) {
      try {
        const imgRes = await fetch(sourceImageUrl);
        if (imgRes.ok) {
          const contentType = imgRes.headers.get("content-type") || "image/jpeg";
          const ext = contentType.includes("png") ? "png"
            : contentType.includes("webp") ? "webp"
            : contentType.includes("gif") ? "gif"
            : "jpg";
          const buf = new Uint8Array(await imgRes.arrayBuffer());
          const path = `${tenant_id}/${ad_id}.${ext}`;
          const { error: upStorageErr } = await supabase.storage
            .from("ad-creatives")
            .upload(path, buf, { contentType, upsert: true, cacheControl: "31536000" });
          if (!upStorageErr) {
            const { data: pub } = supabase.storage.from("ad-creatives").getPublicUrl(path);
            storage_path = path;
            storage_url = pub.publicUrl;
            storage_synced_at = new Date().toISOString();
          } else {
            console.error("[fetch-meta-creative] storage upload err:", upStorageErr);
          }
        } else {
          console.error("[fetch-meta-creative] CDN fetch failed:", imgRes.status);
        }
      } catch (e: any) {
        console.error("[fetch-meta-creative] storage error:", e?.message);
      }
    }

    const row = {
      tenant_id,
      ad_id,
      creative_id: c.id || null,
      ad_name: json.name || null,
      campaign_id: json.campaign?.id || null,
      campaign_name: json.campaign?.name || null,
      headline,
      body,
      thumbnail_url,
      image_url,
      video_url,
      storage_path,
      storage_url,
      storage_synced_at,
      fetched_at: new Date().toISOString(),
    };

    const { data: upserted, error: upErr } = await supabase
      .from("ad_creatives")
      .upsert(row, { onConflict: "tenant_id,ad_id" })
      .select("id")
      .single();

    if (upErr) throw upErr;

    return new Response(JSON.stringify({ status: "ok", id: upserted.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
