// ig-auto-campanha-post — vigia a publicação de um post agendado e, assim que ele
// sai no Instagram, cria sozinho a campanha comentário→DM com a palavra-chave.
//
// Por que existe: post agendado só ganha ID depois de publicado. Sem isso, alguém
// teria que abrir o CRM na hora do post pra cadastrar a campanha na mão — e quem
// comentasse antes disso não receberia nada.
//
// Body: { keyword, material_link, nome?, max_age_min?, dry_run? }

import { createClient } from "jsr:@supabase/supabase-js@2";
import { getDefaultMaterialBase, ACCOUNT_FIELDS, type IgAccount } from "../instagram-webhook/meta-campaign.ts";

const GRAPH = "https://graph.facebook.com/v20.0";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

export async function handleAutoCampanha(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const out = (b: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json().catch(() => ({}));
    const keyword = String(body.keyword || "call").toLowerCase().trim();
    const maxAgeMin = Number(body.max_age_min) || 90;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Cron multi-tenant: itera TODAS as contas connected; tenant vem da conta.
    const { data: accounts } = await supabase
      .from("instagram_business_accounts")
      .select(ACCOUNT_FIELDS)
      .eq("status", "connected");
    const usable = ((accounts || []) as IgAccount[]).filter((a) => a.access_token || a.page_access_token);
    if (!usable.length) return out({ ok: false, error: "conta IG não conectada" });

    const criadas: any[] = [];
    let algumLink = false;

    for (const account of usable) {
      const tenantId = account.tenant_id;
      try {
        // material_link: body OU config `ig_default_material_link` do tenant.
        // Sem ambos → não cria campanha pra esse tenant (erro claro no retorno).
        const materialLink = String(body.material_link || "").trim() ||
          await getDefaultMaterialBase(supabase, tenantId);
        if (!materialLink) {
          criadas.push({
            conta: account.instagram_username,
            erro: "material_link não informado e config ig_default_material_link não configurada em Configurações → API Keys",
          });
          continue;
        }
        algumLink = true;

        const token = account.access_token || account.page_access_token;
        const r = await fetch(
          `${GRAPH}/${account.instagram_business_id}/media` +
          `?fields=id,permalink,caption,thumbnail_url,media_url,timestamp,media_type&limit=8&access_token=${token}`,
        );
        const j = await r.json();
        if (!r.ok) {
          criadas.push({ conta: account.instagram_username, erro: j?.error?.message || `graph ${r.status}` });
          continue;
        }

        const agora = Date.now();
        const recentes = (j.data || []).filter((m: any) => {
          const t = Date.parse(m.timestamp || "");
          return t && (agora - t) <= maxAgeMin * 60_000;
        });
        if (!recentes.length) {
          criadas.push({ conta: account.instagram_username, aguardando: true, motivo: "nenhum post novo ainda" });
          continue;
        }

        for (const post of recentes) {
          // já existe campanha pra esse post nesse tenant? (o cron roda várias vezes)
          const { data: existe } = await supabase
            .from("instagram_comment_campaigns")
            .select("id").eq("tenant_id", tenantId).eq("post_id", post.id).limit(1);
          if (existe?.length) continue;

          // a legenda precisa mesmo pedir a palavra — evita criar campanha em post errado
          const legenda = String(post.caption || "").toLowerCase();
          if (!legenda.includes(keyword)) {
            criadas.push({ post_id: post.id, pulado: `legenda não menciona "${keyword}"` });
            continue;
          }

          if (body.dry_run) { criadas.push({ post_id: post.id, dry_run: true, permalink: post.permalink }); continue; }

          const { data: nova, error } = await supabase
            .from("instagram_comment_campaigns")
            .insert({
              tenant_id: tenantId,
              name: String(body.nome || `Auto: ${keyword}`),
              post_id: post.id,
              post_permalink: post.permalink,
              post_caption: post.caption,
              post_thumbnail_url: post.thumbnail_url || post.media_url,
              keyword_mode: "contains",
              keywords: [keyword],
              reply_mode: "agent",
              agent_slug: "ig-primeiro-contato",
              dm_template: `Material: ${body.nome || keyword}\n${materialLink}`,
              delay_min_seconds: 15,
              delay_max_seconds: 45,
              once_per_user: true,
              process_existing: true,
              status: "active",
            })
            .select("id, name").single();

          if (error) { criadas.push({ post_id: post.id, erro: error.message }); continue; }
          criadas.push({ post_id: post.id, campanha: nova?.id, nome: nova?.name, permalink: post.permalink });
        }
      } catch (e) {
        // try/catch por conta: falha de um tenant não aborta os demais
        criadas.push({ conta: account.instagram_username, erro: String((e as Error).message || e) });
      }
    }

    // Nenhum tenant tinha link (nem body.material_link) → 400 com mensagem clara
    if (!algumLink) {
      return out({
        ok: false,
        error: "material_link obrigatório: passe no body OU configure ig_default_material_link em Configurações → API Keys",
        detalhes: criadas,
      }, 400);
    }

    return out({ ok: true, criadas });
  } catch (e: any) {
    return out({ ok: false, error: String(e?.message || e) });
  }
}
