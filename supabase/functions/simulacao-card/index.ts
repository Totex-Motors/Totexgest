/**
 * simulacao-card — a Nina "roda o simulador" e manda a IMAGEM da simulação no WhatsApp
 * (ideia do Marco, 2026-10-15: prova visual em vez de número solto; depois vem o cupom).
 *
 * Tool do agente V2 (enviar_simulacao): { arguments: { carro?, valor?, entrada?, prazo?, extra?,
 *   carro_na_troca? }, session_id, user_id } — igual às outras tools (service role).
 * Também aceita chamada direta: { lead_id | phone, carro | valor, ... , enviar?: boolean }.
 *
 * Fluxo: simulador-cardoso (porta única: números) + consultar-estoque (foto/ano/km do
 * marketplace) → SVG → PNG (resvg wasm) → bucket privado whatsapp-media (URL assinada 2 h)
 * → send-whatsapp-cloud send_image (número OFICIAL) → registra em leads.metadata.simulacoes.
 * Espera SIMULACAO_CARD_DELAY_MS (padrão 6 s) antes de enviar: o cliente acabou de ler
 * "deixa eu rodar no simulador" — a pausa faz parte da experiência.
 * Regras: só reais, nunca taxa; nunca valor do carro do cliente na troca; "estimativa".
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { renderCardPng, fotoDataUri, brl0 } from "../_shared/simulacao-card.ts";
import { getNinaExclusiveStore } from "../_shared/nina-store.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HQ_TENANT = "c13681e3-5db9-48d1-9c5c-856e6041d77f";
const BUCKET = "whatsapp-media";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const digits = (s: unknown) => String(s || "").replace(/\D/g, "");

async function callEdge(fn: string, body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY }, body: JSON.stringify(body) });
  const t = await r.text(); try { return { ok: r.ok, data: JSON.parse(t) }; } catch { return { ok: r.ok, data: { raw: t } }; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const body = await req.json().catch(() => ({}));
    const a = (body.arguments || body) as Record<string, any>;

    // ── quem é o cliente (sessão do agente ou direto) ──
    let leadId: string | null = body.lead_id || null;
    let phone = digits(body.phone);
    let tenantId: string = body.tenant_id || HQ_TENANT;
    if (body.session_id) {
      const { data: s } = await sb.from("agents_sessions").select("tenant_id, working_memory, provider_state").eq("id", body.session_id).maybeSingle();
      const wm = (s?.working_memory || {}) as Record<string, any>; const ps = (s?.provider_state || {}) as Record<string, any>;
      phone = phone || digits(wm.customer_phone || ps.whatsapp_phone);
      leadId = leadId || wm.lead_id || null;
      tenantId = s?.tenant_id || tenantId;
    }
    if (!leadId && phone) {
      const { data: l } = await sb.from("leads").select("id").ilike("phone", `%${phone.slice(-8)}`).order("created_at", { ascending: false }).limit(1).maybeSingle();
      leadId = l?.id || null;
    }
    const lead = leadId ? (await sb.from("leads").select("id, name, metadata, tenant_id").eq("id", leadId).maybeSingle()).data : null;
    const md = ((lead?.metadata as Record<string, any>) || {});
    if (!phone && lead) { const { data: l2 } = await sb.from("leads").select("phone").eq("id", lead.id).maybeSingle(); phone = digits(l2?.phone); }

    // ── carro: argumento → carro de interesse do lead ──
    const carroPedido = String(a.carro || "").trim() || String(md.veiculo_interesse_texto || "").trim() ||
      (md.vehicle ? [md.vehicle.brand, md.vehicle.model, md.vehicle.version].filter(Boolean).join(" ") : "");
    const valorArg = Number(a.valor || a.veiculo || a.preco) || 0;
    if (!carroPedido && !valorArg) return json({ success: false, message: "Me diga qual carro (nome) ou o valor dele pra eu rodar a simulação." });

    // ── números pela porta única ──
    const plano = await callEdge("simulador-cardoso", { action: "plano", carro: carroPedido || undefined, valor: valorArg || undefined, entrada: a.entrada, prazo: a.prazo, extra: a.extra, carro_na_troca: a.carro_na_troca ?? a.usado });
    if (!plano.ok || !plano.data?.success) return json({ success: false, message: plano.data?.message || "Não consegui rodar a simulação agora. Diga o valor do carro ou tente de novo." });
    const p = plano.data;
    const carroTitulo: string = p.carro || carroPedido;

    // ── foto/ano/km do marketplace (consultar-estoque) ──
    const excl = await getNinaExclusiveStore(sb).catch(() => null);
    let veic: any = null;
    try {
      const e = await callEdge("consultar-estoque", { arguments: { busca: carroTitulo, limite: 5, ...(excl ? { tenant_id: excl.tenantId } : {}) }, session_id: null, user_id: null });
      const lista = Array.isArray(e.data?.veiculos) ? e.data.veiculos : [];
      const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const toks = norm(carroTitulo).split(/\s+/).filter((t) => t.length >= 3 && !/^\d/.test(t)).slice(0, 3);
      veic = lista.find((v: any) => toks.every((t) => norm(v.titulo).includes(t))) || lista.find((v: any) => toks.slice(0, 2).every((t) => norm(v.titulo).includes(t))) || null;
    } catch { /* sem foto, sem problema */ }

    const prazo = Number(p.plano?.prazo || 48);
    const parcela = Number(p.plano?.parcela || 0);
    const outros = String(p.plano?.outros_prazos || "").split(";").map((s: string) => s.trim()).filter(Boolean).map((s: string) => {
      const m = s.match(/(\d+)x de ([\d.]+)/); return m ? { prazo: Number(m[1]), parcela: Number(m[2].replace(/\./g, "")) } : null;
    }).filter(Boolean) as Array<{ prazo: number; parcela: number }>;
    const sub = [veic?.ano, veic?.km ? `${Number(veic.km).toLocaleString("pt-BR")} km` : null, veic?.cor, veic?.cidade].filter(Boolean).join(" · ");

    const png = await renderCardPng({
      titulo: veic?.titulo || carroTitulo, subtitulo: sub || null, preco: Number(p.valor_carro), entrada: Number(p.entrada || 0),
      prazo, parcela, outros, ultimaHoje: Number(p.antecipacao?.ultima_parcela_hoje) || null,
      cupom: p.cupom_campanha?.valor ? { titulo: p.cupom_campanha.titulo, valor: Number(p.cupom_campanha.valor), economia_mes: Number(p.cupom_campanha.economia_mes || 0) } : null,
      fotoDataUri: await fotoDataUri(veic?.foto || null),
      assinatura: `${(await getIntegrationKey(sb, "REAQUECIMENTO_ASSINATURA")) || "Nina"} · Totex Motors`,
      loja: excl?.name || veic?.loja || null,
    });

    // ── sobe no bucket privado + URL assinada (a Meta baixa pelo link) ──
    const path = `simulacoes/${leadId || phone || "anon"}/${Date.now()}.png`;
    const up = await sb.storage.from(BUCKET).upload(path, png, { contentType: "image/png", upsert: true });
    if (up.error) return json({ success: false, message: `Não consegui salvar a imagem: ${up.error.message}` });
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(path, 2 * 3600);
    const imageUrl = signed?.signedUrl || null;

    const resumo = `${veic?.titulo || carroTitulo}: ${prazo}x de ${brl0(parcela)} (entrada ${brl0(Number(p.entrada || 0))})${p.antecipacao?.ultima_parcela_hoje ? `; a jogada do décimo terceiro: a última parcela paga hoje sai por ${brl0(Number(p.antecipacao.ultima_parcela_hoje))}` : ""}.`;

    // ── envia (a pausa é proposital) ──
    const enviar = body.enviar !== false && !!phone;
    let envio: string | null = null;
    if (enviar && imageUrl) {
      const delay = Number((await getIntegrationKey(sb, "SIMULACAO_CARD_DELAY_MS")) || 6000);
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 20000)));
      const caption = `Simulação do ${veic?.titulo || carroTitulo} 📊 ${prazo}x de ${brl0(parcela)}. Estimativa do simulador da Cardoso; a condição final é com a Grazi e os bancos.`;
      const s = await callEdge("send-whatsapp-cloud", { action: "send_image", phone, media_url: imageUrl, caption, lead_id: leadId, tenant_id: lead?.tenant_id || tenantId, sent_by: "simulacao_card" });
      envio = s.ok && !s.data?.error ? "enviada" : `falhou: ${JSON.stringify(s.data).slice(0, 160)}`;
    }

    if (lead) {
      const hist = Array.isArray(md.simulacoes) ? md.simulacoes : [];
      await sb.from("leads").update({ metadata: { ...md, simulacoes: [...hist, { em: new Date().toISOString(), carro: veic?.titulo || carroTitulo, prazo, parcela, entrada: Number(p.entrada || 0), path, envio }].slice(-10) }, last_interaction_at: new Date().toISOString() }).eq("id", lead.id);
    }

    return json({
      success: true, enviada: envio === "enviada", envio, image_url: imageUrl, resumo,
      numeros: { carro: veic?.titulo || carroTitulo, valor_carro: p.valor_carro, entrada: p.entrada, prazo, parcela, outros_prazos: p.plano?.outros_prazos, antecipacao: p.antecipacao, cupom_campanha: p.cupom_campanha },
      message: envio === "enviada"
        ? `A imagem da simulação JÁ FOI ENVIADA no WhatsApp do cliente (${resumo}). Não repita os números todos: comente em UMA frase a jogada do décimo terceiro ou o ganho dele, e faça UMA pergunta fácil (ex.: "quer que eu veja com entrada menor?" ou "fecha pra você ver ele de perto no sábado?"). Nunca cite taxa. O valor do carro dele na troca sai na avaliação.`
        : `Simulação pronta (${resumo}), mas não enviei a imagem${phone ? "" : " (sem telefone)"}. Fale os números em reais, sem taxa.`,
    });
  } catch (e) {
    console.error("[simulacao-card]", (e as Error).message);
    return json({ success: false, message: `Erro na simulação: ${(e as Error).message}` }, 500);
  }
});
