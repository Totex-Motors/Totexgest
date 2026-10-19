// zernio-webhook — eventos da Zernio (post.published / post.partial / post.failed /
// post.platform.published / post.platform.failed / account.disconnected).
// Assinatura: X-Zernio-Signature = HMAC-SHA256 hex do corpo cru com ZERNIO_WEBHOOK_SECRET.
// Sem o secret configurado → 503 (não processa nada sem assinatura).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { verifyZernioSignature } from "../_shared/zernio.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "zernio-webhook" });
  if (req.method !== "POST") return json({ error: "método" }, 405);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const secret = await getIntegrationKey(db, "ZERNIO_WEBHOOK_SECRET");
  if (!secret) {
    console.warn("[zernio-webhook] ZERNIO_WEBHOOK_SECRET não configurado — evento ignorado");
    return json({ error: "webhook secret não configurado" }, 503);
  }
  const raw = await req.text();
  const sig = req.headers.get("x-zernio-signature") || req.headers.get("x-late-signature");
  if (!(await verifyZernioSignature(secret, raw, sig))) {
    console.warn("[zernio-webhook] assinatura inválida");
    return json({ error: "assinatura inválida" }, 401);
  }

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return json({ error: "json" }, 400); }
  const event = String(ev?.event || "");
  if (ev?.test) return json({ ok: true, test: true });

  try {
    if (event.startsWith("post.")) {
      const post = ev.post || {};
      const postId = post.id || post._id;
      if (!postId) return json({ ok: true, skipped: "sem post id" });
      const { data: row } = await db.from("social_publications").select("id, platforms, status").eq("zernio_post_id", postId).maybeSingle();
      if (!row) return json({ ok: true, skipped: "post desconhecido" });

      const prev: any[] = row.platforms || [];
      let platforms = prev;
      if (Array.isArray(post.platforms) && post.platforms.length) {
        platforms = post.platforms.map((p: any) => {
          const old = prev.find((o) => o.account_id === p.accountId) || {};
          return {
            platform: p.platform, account_id: p.accountId, username: old.username || null,
            status: p.status || old.status || null,
            url: p.publishedUrl || p.platformPostUrl || old.url || null,
            error: p.error || p.errorMessage || (p.status === "published" ? null : old.error) || null,
          };
        });
      }
      // Evento por rede: aplica só naquela conta
      if (ev.platform && ev.account?.accountId) {
        const accId = ev.account.accountId;
        const found = platforms.some((p) => p.account_id === accId);
        const patch = {
          status: ev.platform.status || (event.endsWith("failed") ? "failed" : event.endsWith("published") ? "published" : null),
          url: ev.platform.publishedUrl || null,
          error: ev.platform.error || null,
        };
        platforms = found
          ? platforms.map((p) => (p.account_id === accId ? { ...p, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)) } : p))
          : [...platforms, { platform: ev.account.platform, account_id: accId, username: ev.account.username || null, ...patch }];
      }
      const statusMap: Record<string, string> = { "post.published": "published", "post.failed": "failed", "post.partial": "partial", "post.scheduled": "scheduled", "post.cancelled": "cancelled" };
      let status = statusMap[event] || post.status || row.status;
      if (event.startsWith("post.platform.")) {
        const sts = platforms.map((p) => p.status);
        status = sts.every((s) => s === "published") ? "published" : sts.every((s) => s === "failed") ? "failed" : sts.some((s) => s === "failed") && sts.some((s) => s === "published") ? "partial" : row.status;
      }
      await db.from("social_publications").update({ status, platforms, updated_at: new Date().toISOString() }).eq("id", row.id);
      return json({ ok: true, status });
    }

    if (event === "account.disconnected") {
      console.warn("[zernio-webhook] conta desconectada", ev.account?.platform, ev.account?.username, ev.account?.reason);
      // Aviso simples no log; a tela mostra "reconectar" ao listar as contas.
      return json({ ok: true });
    }

    return json({ ok: true, ignored: event });
  } catch (e) {
    console.error("[zernio-webhook]", (e as Error).message);
    return json({ error: "falha ao processar" }, 500);
  }
});
