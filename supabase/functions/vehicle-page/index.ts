// vehicle-page — PÁGINAS DE CARRO COM IA ("autoconsultor"), Marco 2026-11-02.
//
//  GET  /vehicle-page/<slug>            → HTML público da página (OG tags, JSON-LD). ?format=json
//  POST { action }  (usuário logado da loja, ou x-internal-token):
//    estoque   { busca? }                → carros da loja no marketplace + estado da página de cada um
//    generate  { vehicle_id, entrada? }  → cria/regenera: marketplace + FIPE (fipe-lookup) +
//                                          simulador (simulador-cardoso, se a loja tiver) + IA (Claude)
//    publish / unpublish / delete { id }
//    list                                → páginas da loja (views, cliques)
//  POST { action: "click", slug, kind }  (público, sem auth) → cria o lead "clique" (source
//    marketplace, sem telefone, ref = 8 chars do id) igual ao botão do site; o webhook do
//    WhatsApp casa a mensagem que chega (absorbMarketplaceClick). Devolve {ref, numero}.
//
// Regras: FIPE só via fipe-lookup; nunca taxa de juros na página (só reais); IA não inventa
// dados DESTE exemplar (km, cor, revisões…) — só o que veio do marketplace; o resto é
// "referência do modelo". Chaves via getIntegrationKey.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCaller, deny } from "../_shared/auth.ts";
import { getIntegrationKey } from "../_shared/config.ts";
import { askClaudeJson } from "../_shared/claude-json.ts";
import { buildVehicleHtml, cambioPt, combPt, brl0, type PageContent, type PageFipe, type PageSim, type PageVehicle } from "../_shared/vehicle-page-html.ts";
import { DEFAULT_VOICE_REPLY, prepareTextForSpeech, synthesizeSpeech, type VoiceReplyConfig } from "../_shared/tts.ts";

const MEDIA_BUCKET = "vehicle-media"; // público: vídeos e narrações das páginas de carro

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FN_URL = `${SUPABASE_URL}/functions/v1/vehicle-page`;
const DEFAULT_MARKET = "https://totexmotors.com";
const DEFAULT_PAGE_BASE = "https://totexgest.vercel.app/c";
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-token" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const html = (h: string, s = 200, cache = "public, max-age=300") => new Response(h, { status: s, headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache } });

const slugify = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
const digits = (s: unknown) => String(s || "").replace(/\D/g, "");
function phoneBr(s: unknown): string | null {
  let d = digits(s);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 ? d : null;
}

/** Descrição do anúncio vem com entidades ("&#13;") e quebras duplicadas do ERP da loja. */
function limpaDescricao(d: unknown): string | null {
  let s = String(d || "");
  if (!s.trim()) return null;
  s = s.replace(/&#13;|&#10;/g, "\n").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, 1500) || null;
}

function toPageVehicle(v: any, base: string): PageVehicle {
  const fotos = Array.isArray(v?.images)
    ? [...v.images].sort((a, b) => (b?.isPrimary ? 1 : 0) - (a?.isPrimary ? 1 : 0) || (a?.order ?? 0) - (b?.order ?? 0)).map((i) => i?.url).filter(Boolean)
    : [];
  // O marketplace repete o modelo na versão ("Tucson" + "Tucson 2.0 16V…") → tira a repetição
  const modelo = String(v.model || "").trim();
  let versao = String(v.version || "").trim();
  if (modelo && versao.toLowerCase().startsWith(modelo.toLowerCase())) versao = versao.slice(modelo.length).trim();
  return {
    id: String(v.id), marca: v.brand || "", modelo, versao: versao || null,
    titulo: [v.brand, modelo, versao].filter(Boolean).join(" "),
    ano: Number(v.year) || null, preco: Number(v.price) > 0 ? Number(v.price) : null,
    km: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null, cor: v.color || null,
    cambio: v.transmission || null, combustivel: v.fuel || null, portas: Number(v.doors) || null,
    cidade: v.city || null, estado: v.state || null, descricao: limpaDescricao(v.description),
    fotos, loja: { nome: v.dealership?.name || null, telefone: v.dealership?.phone || null, cidade: v.dealership?.city || null },
    link_marketplace: `${base}/veiculo/${v.id}`,
  };
}

async function marketBase(sb: any) {
  return String((await getIntegrationKey(sb, "TOTEX_MARKETPLACE_API_URL")) || DEFAULT_MARKET).replace(/\/$/, "");
}
async function pageBase(sb: any) {
  return String((await getIntegrationKey(sb, "VEHICLE_PAGE_BASE_URL")) || DEFAULT_PAGE_BASE).replace(/\/$/, "");
}
async function dealershipOf(sb: any, tenantId: string): Promise<string | null> {
  const { data } = await sb.from("marketplace_store_mappings").select("marketplace_store_id").eq("tenant_id", tenantId).eq("active", true).maybeSingle();
  return data?.marketplace_store_id || null;
}
/** Número do WhatsApp que recebe o clique: oficial (meta_cloud) da loja > telefone da loja no marketplace. */
async function whatsappDaLoja(sb: any, tenantId: string, v: PageVehicle): Promise<string | null> {
  const { data: inst } = await sb.from("whatsapp_instances").select("phone_number").eq("tenant_id", tenantId).eq("provider", "meta_cloud").eq("status", "connected").limit(1).maybeSingle();
  return phoneBr(inst?.phone_number) || phoneBr(v.loja.telefone) || phoneBr(await getIntegrationKey(sb, "VEHICLE_PAGE_WHATSAPP", tenantId));
}

// ───────────── FIPE (porta única fipe-lookup) ─────────────
async function fipeDoCarro(sb: any, tenantId: string, v: PageVehicle): Promise<PageFipe | null> {
  try {
    const token = await getIntegrationKey(sb, "FIPE_LOOKUP_TOKEN");
    if (!token || !v.ano) return null;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/fipe-lookup`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-fipe-token": token },
      body: JSON.stringify({ tenant_id: tenantId, marca: v.marca, modelo: `${v.modelo} ${v.versao || ""}`.trim(), ano: v.ano, combustivel: combPt(v.combustivel) }),
    });
    const d = await r.json().catch(() => null);
    // Regra: nunca escolher modelo sozinho. Sem preço confirmado → sem FIPE na página.
    if (!d?.ok || d.precisa_confirmar_modelo || !d.preco?.valor_centavos) return null;
    const valor = Number(d.preco.valor_centavos);
    return { valor_centavos: valor, mes_referencia: d.preco.mes_referencia || null, codigo_fipe: d.veiculo?.codigo_fipe || null, diferenca_pct: v.preco ? ((v.preco - valor / 100) / (valor / 100)) * 100 : null };
  } catch (e) { console.warn("[vehicle-page] fipe:", (e as Error).message); return null; }
}

// ───────────── Simulador (só lojas que têm) ─────────────
async function simulacaoDoCarro(sb: any, tenantId: string, v: PageVehicle, entrada?: number): Promise<PageSim | null> {
  try {
    const lojas = String((await getIntegrationKey(sb, "SIMULADOR_TENANT_IDS")) || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!v.preco || !lojas.includes(tenantId)) return null;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/simulador-cardoso`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ action: "plano", valor: v.preco, carro: v.titulo, ...(entrada ? { entrada } : {}) }),
    });
    const d = await r.json().catch(() => null);
    if (!d?.success || !d.plano?.parcela) return null;
    return { prazo: d.plano.prazo, parcela: d.plano.parcela, entrada: Number(d.entrada) || 0, outros_prazos: d.plano.outros_prazos || null, ultima_parcela_hoje: d.antecipacao?.ultima_parcela_hoje || null };
  } catch (e) { console.warn("[vehicle-page] simulador:", (e as Error).message); return null; }
}

// ───────────── IA (autoconsultor) ─────────────
async function conteudoIA(sb: any, tenantId: string, v: PageVehicle, fipe: PageFipe | null, sim: PageSim | null): Promise<{ content: PageContent | null; model: string }> {
  const model = (await getIntegrationKey(sb, "VEHICLE_PAGE_MODEL")) || DEFAULT_MODEL;
  const system = `Você é o AUTOCONSULTOR da loja: um consultor de carros honesto, direto e simpático, escrevendo a página de um carro usado à venda, em português do Brasil, pra uma pessoa comum (sem jargão).
REGRAS INVIOLÁVEIS:
- Sobre ESTE exemplar, use SÓ os dados fornecidos (ano, km, cor, câmbio, combustível, descrição da loja). NÃO invente revisões, dono único, laudo, pneus, garantia ou qualquer detalhe que não esteja nos dados.
- Informações do MODELO/VERSÃO (equipamentos, consumo, concorrentes, custos) são de referência de mercado: seja conservador, use faixas, e nunca afirme como certo o que varia por versão.
- Dinheiro só em reais; NUNCA fale de taxa de juros ou porcentagem de financiamento. Não prometa aprovação de crédito.
- Sem superlativos vazios ("o melhor carro do mundo"). Argumentos concretos. Nada de emojis.
- Frases curtas. Cada campo cabe num celular.
Responda SOMENTE com JSON válido no formato pedido.`;
  const user = `DADOS DO CARRO (fonte: anúncio da loja):
${JSON.stringify({ titulo: v.titulo, marca: v.marca, modelo: v.modelo, versao: v.versao, ano: v.ano, preco: v.preco ? brl0(v.preco) : null, km: v.km, cor: v.cor, cambio: cambioPt(v.cambio), combustivel: combPt(v.combustivel), portas: v.portas, cidade: v.cidade, loja: v.loja.nome, descricao_da_loja: v.descricao }, null, 1)}
${fipe ? `TABELA FIPE do modelo (${fipe.mes_referencia || "mês atual"}): ${brl0(fipe.valor_centavos / 100)} → o preço anunciado está ${fipe.diferenca_pct != null ? `${fipe.diferenca_pct.toFixed(0)}% ${fipe.diferenca_pct <= 0 ? "abaixo" : "acima"}` : "próximo"} da tabela.` : "FIPE: não disponível (não mencione tabela FIPE)."}
${sim ? `PARCELA estimada pelo simulador da loja: ${sim.prazo}x de ${brl0(sim.parcela)} com entrada de ${brl0(sim.entrada)} (pode citar, sem taxa).` : "Parcela: não disponível (não cite valores de parcela)."}

Gere o JSON:
{
 "headline": "título vendedor de até 70 caracteres, com o nome do carro",
 "subheadline": "1 frase (até 140 chars) com o principal argumento",
 "resumo": ["parágrafo 1 (2-3 frases): o que é este carro e por que vale olhar", "parágrafo 2: condição/estado com base SÓ nos dados (km, ano, descrição) e preço x FIPE se houver"],
 "pontos_fortes": [{"titulo": "até 4 palavras", "texto": "1 frase"}] (6 itens, do modelo/versão e do exemplar),
 "para_quem": "2-3 frases: perfil de comprador e uso (família, trabalho, app, cidade, estrada)",
 "equipamentos": ["item típico da versão"] (8-12 itens, só os que você tem confiança),
 "consumo": {"cidade": "ex.: 9-11 km/l", "estrada": "ex.: 12-14 km/l", "observacao": "1 frase (combustível, motor)"},
 "custo_mensal": {"ipva_ano": "faixa em reais pra SP, ex.: R$ 2.800-3.200", "seguro_mes": "faixa em reais, ex.: R$ 180-300", "combustivel_mes": "faixa pra 1.000 km/mês", "observacao": "1 frase"},
 "concorrentes": [{"modelo": "concorrente direto", "comparacao": "1-2 frases: onde este carro ganha e onde perde"}] (3 itens),
 "objecoes": [{"objecao": "dúvida comum do comprador (ex.: 'É caro de manter?')", "resposta": "resposta honesta em 1-2 frases"}] (3 itens),
 "faq": [{"pergunta": "...", "resposta": "..."}] (5 itens: documentação, troca, test drive, financiamento SEM taxa, garantia genérica 'confirme na loja'),
 "cta": "chamada final curta (até 60 chars) convidando pro WhatsApp/visita",
 "seo": {"title": "até 60 chars", "description": "até 155 chars"}
}`;
  const content = await askClaudeJson(sb, tenantId, system, user, { model, maxTokens: 3500, tag: "vehicle-page" });
  return { content: (content as PageContent) || null, model };
}

// ───────────── render ─────────────
async function render(sb: any, row: any): Promise<string> {
  const v = row.vehicle as PageVehicle;
  const base = await pageBase(sb);
  const numero = await whatsappDaLoja(sb, row.tenant_id, v);
  const texto_base = `Olá! Eu vi o ${v.titulo}${v.ano ? ` ${v.ano}` : ""} da loja ${v.loja.nome || "Totex Motors"} no site da TotexMotors e gostaria de saber mais.`;
  return buildVehicleHtml({
    v, c: (row.content || {}) as PageContent, fipe: row.fipe || null, sim: row.simulacao || null,
    slug: row.slug, pageUrl: `${base}/${row.slug}`, functionUrl: FN_URL,
    whatsapp: { numero, texto_base },
    geradoEm: row.generated_at ? new Date(row.generated_at).toLocaleDateString("pt-BR") : null,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── GET público: a página ──
  if (req.method === "GET") {
    const url = new URL(req.url);
    const slug = (url.searchParams.get("slug") || url.pathname.split("/").filter(Boolean).pop() || "").toLowerCase();
    if (!slug || slug === "vehicle-page") return json({ ok: true, service: "vehicle-page" });
    const { data: row } = await sb.from("vehicle_pages").select("*").eq("slug", slug).maybeSingle();
    const preview = url.searchParams.get("preview") === "1";
    if (!row || (row.status !== "published" && !preview)) return html(`<!doctype html><meta charset="utf-8"><title>Página não encontrada</title><body style="font-family:sans-serif;padding:40px;text-align:center"><h1>Esse carro não está mais disponível</h1><p>Fale com a loja pra ver o estoque atual.</p></body>`, 404, "no-store");
    if (url.searchParams.get("format") === "json") return json({ slug: row.slug, status: row.status, vehicle: row.vehicle, content: row.content, fipe: row.fipe, simulacao: row.simulacao });
    if (!preview) sb.rpc("vehicle_page_hit", { p_slug: slug, p_kind: "view" }).then(() => {}, () => {});
    return html(await render(sb, row), 200, preview ? "no-store" : "public, max-age=300");
  }

  if (req.method !== "POST") return json({ error: "método" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "corpo inválido" }, 400); }
  const action = String(body.action || "");

  // ── POST público: clique do CTA → lead "clique" com ref ──
  if (action === "click") {
    const slug = String(body.slug || "").toLowerCase();
    const kind = ["whatsapp", "simular", "visita"].includes(body.kind) ? body.kind : "whatsapp";
    const { data: row } = await sb.from("vehicle_pages").select("id, tenant_id, slug, vehicle, status").eq("slug", slug).maybeSingle();
    if (!row) return json({ error: "página não encontrada" }, 404);
    const v = row.vehicle as PageVehicle;
    const numero = await whatsappDaLoja(sb, row.tenant_id, v);
    const dealershipId = await dealershipOf(sb, row.tenant_id);
    const { data: lead } = await sb.from("leads").insert({
      tenant_id: row.tenant_id, name: "Cliente (não identificado)", phone: null, source: "marketplace", status: "new", sales_stage: "new",
      city_name: v.cidade, state: v.estado, context: `Clique "${kind}" na página do carro com IA (${slug})`,
      metadata: {
        marketplace_origin: "LANDING_IA", marketplace_store_id: dealershipId, marketplace_store_name: v.loja.nome, vehicle_page_id: row.id, vehicle_page_click: kind,
        vehicle: { id: v.id, description: `${v.titulo} ${v.ano || ""}`.trim(), brand: v.marca, model: v.modelo, version: v.versao, year: v.ano, mileage: v.km, price: v.preco, price_formatted: v.preco ? brl0(v.preco) : null },
        store: { name: v.loja.nome, phone: v.loja.telefone, city: v.loja.cidade || v.cidade, state: v.estado },
      },
    }).select("id").single();
    sb.rpc("vehicle_page_hit", { p_slug: slug, p_kind: "click" }).then(() => {}, () => {});
    return json({ ref: lead?.id ? String(lead.id).slice(0, 8) : null, numero });
  }

  // ── Demais ações: usuário logado da loja (ou interno) ──
  const caller = await getCaller(req);
  if (!caller.ok) return deny();
  const tenantId: string | null = caller.user ? (caller.user.superadmin && body.tenant_id ? body.tenant_id : caller.user.tenantId) : (body.tenant_id || null);
  if (!tenantId) return json({ error: "Empresa não identificada." }, 403);
  if (caller.user && !caller.user.superadmin) {
    const { data: m } = await sb.from("team_members").select("is_active").eq("tenant_id", tenantId).eq("auth_user_id", caller.user.id).maybeSingle();
    if (!m?.is_active) return json({ error: "Acesso não autorizado." }, 403);
  }
  const base = await pageBase(sb);
  const market = await marketBase(sb);
  const pub = (r: any) => ({ id: r.id, vehicle_id: r.marketplace_vehicle_id, slug: r.slug, status: r.status, url: `${base}/${r.slug}`, preview_url: `${FN_URL}/${r.slug}?preview=1`, titulo: r.vehicle?.titulo, preco: r.vehicle?.preco, foto: r.vehicle?.fotos?.[0] || null, fotos: r.vehicle?.fotos || [], views: r.views, clicks: r.clicks, generated_at: r.generated_at, published_at: r.published_at, model: r.model, tem_fipe: !!r.fipe, tem_simulacao: !!r.simulacao, videos: Array.isArray(r.videos) ? r.videos : [],
    // dados pro vídeo (texto na tela + narração)
    video_dados: r.content ? { headline: r.content.headline, subheadline: r.content.subheadline, pontos: (r.content.pontos_fortes || []).slice(0, 3).map((x: any) => x.titulo), cta: r.content.cta, seo: r.content.seo, ano: r.vehicle?.ano, km: r.vehicle?.km, preco: r.vehicle?.preco, parcela: r.simulacao ? { prazo: r.simulacao.prazo, valor: r.simulacao.parcela } : null, fipe_dif: r.fipe?.diferenca_pct ?? null, loja: r.vehicle?.loja?.nome } : null });

  try {
    if (action === "lojas") {
      // superadmin: escolhe a loja (tenant com loja no marketplace)
      if (!caller.user?.superadmin && !caller.internal) return json({ lojas: [] });
      const { data } = await sb.from("marketplace_store_mappings").select("tenant_id, store_name").eq("active", true).order("store_name");
      return json({ lojas: (data || []).map((m: any) => ({ tenant_id: m.tenant_id, nome: m.store_name })) });
    }

    if (action === "list") {
      const { data } = await sb.from("vehicle_pages").select("*").eq("tenant_id", tenantId).order("updated_at", { ascending: false }).limit(200);
      return json({ pages: (data || []).map(pub) });
    }

    if (action === "estoque") {
      const dealershipId = await dealershipOf(sb, tenantId);
      if (!dealershipId) return json({ error: "Esta loja não está vinculada a uma loja do marketplace (Configurações › Marketplace).", veiculos: [] });
      const qs = new URLSearchParams({ dealershipId, limit: "100", sort: "price_asc" });
      if (body.busca) qs.set("search", String(body.busca));
      const r = await fetch(`${market}/api/vehicles?${qs}`, { headers: { Accept: "application/json" } });
      if (!r.ok) return json({ error: `Estoque indisponível (${r.status}).`, veiculos: [] });
      const d = await r.json();
      const list: any[] = Array.isArray(d?.data) ? d.data : [];
      const { data: pages } = await sb.from("vehicle_pages").select("*").eq("tenant_id", tenantId);
      const byV = new Map((pages || []).map((p: any) => [p.marketplace_vehicle_id, p]));
      return json({
        total: Number(d?.total) || list.length,
        veiculos: list.map((raw) => { const v = toPageVehicle(raw, market); const p = byV.get(v.id); return { ...v, pagina: p ? pub(p) : null }; }),
      });
    }

    if (action === "generate") {
      const vehicleId = String(body.vehicle_id || "").trim();
      if (!vehicleId) return json({ error: "Informe vehicle_id." }, 400);
      const r = await fetch(`${market}/api/vehicles/${encodeURIComponent(vehicleId)}`, { headers: { Accept: "application/json" } });
      if (!r.ok) return json({ error: `Carro não encontrado no marketplace (${r.status}).` }, 404);
      const raw = await r.json();
      // Só carros da própria loja (mapping) — superadmin passa
      const dealershipId = await dealershipOf(sb, tenantId);
      if (!caller.user?.superadmin && !caller.internal && dealershipId && raw?.dealershipId && raw.dealershipId !== dealershipId) return json({ error: "Esse carro é de outra loja." }, 403);
      const v = toPageVehicle(raw, market);
      const [fipe, sim] = await Promise.all([fipeDoCarro(sb, tenantId, v), simulacaoDoCarro(sb, tenantId, v, Number(body.entrada) || undefined)]);
      const { content, model } = await conteudoIA(sb, tenantId, v, fipe, sim);
      if (!content) return json({ error: "A IA não devolveu conteúdo (confira a ANTHROPIC_API_KEY)." }, 502);

      const { data: existing } = await sb.from("vehicle_pages").select("id, slug, status").eq("tenant_id", tenantId).eq("marketplace_vehicle_id", v.id).maybeSingle();
      const slug = existing?.slug || `${slugify(`${v.marca} ${v.modelo} ${v.versao || ""} ${v.ano || ""}`)}-${v.id.slice(-6).toLowerCase()}`;
      const rowData = { tenant_id: tenantId, marketplace_vehicle_id: v.id, slug, vehicle: v, content, fipe, simulacao: sim, model, generated_at: new Date().toISOString(), updated_at: new Date().toISOString(), created_by: caller.user?.id || null };
      const { data: saved, error } = existing
        ? await sb.from("vehicle_pages").update(rowData).eq("id", existing.id).select("*").single()
        : await sb.from("vehicle_pages").insert({ ...rowData, status: "draft" }).select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ page: pub(saved) });
    }

    // Narração do vídeo na voz do agente (texto do autoconsultor → áudio público no bucket)
    if (action === "narracao") {
      const id = String(body.id || "");
      const { data: row } = await sb.from("vehicle_pages").select("*").eq("id", id).maybeSingle();
      if (!row || row.tenant_id !== tenantId) return json({ error: "Página não encontrada." }, 404);
      const v = row.vehicle as PageVehicle; const c = (row.content || {}) as PageContent;
      // curto de propósito: vídeo de rede social (~20-25 s de fala)
      const primeiraFrase = (t: string) => (t.match(/^[^.!?]+[.!?]/)?.[0] || t).trim();
      const texto = String(body.texto || "").trim() || [
        c.headline || v.titulo,
        c.resumo?.[0] ? primeiraFrase(c.resumo[0]) : "",
        c.pontos_fortes?.length ? `Destaques: ${c.pontos_fortes.slice(0, 3).map((p) => p.titulo).join(", ")}.` : "",
        row.simulacao?.parcela ? `Cabe no bolso: ${row.simulacao.prazo} parcelas de ${brl0(row.simulacao.parcela)}.` : "",
        c.cta || "Chama a gente no WhatsApp e vem ver de perto.",
      ].filter(Boolean).join(" ");
      // voz: a mesma da nota de voz do agente da loja (agents_registry.settings.voice_reply); senão padrão OpenAI
      const { data: ag } = await sb.from("agents_registry").select("settings").eq("tenant_id", tenantId).eq("is_active", true).order("created_at").limit(1).maybeSingle();
      const vr = ((ag?.settings as any)?.voice_reply || {}) as Partial<VoiceReplyConfig>;
      const cfg: VoiceReplyConfig = { ...DEFAULT_VOICE_REPLY, ...vr, enabled: true, mode: "always", max_chars: 2000, eleven: { ...DEFAULT_VOICE_REPLY.eleven, ...(vr.eleven || {}) } };
      const audio = await synthesizeSpeech(sb, texto.slice(0, 1200), tenantId, cfg);
      if (!audio) return json({ error: "Não consegui gerar a narração (confira as chaves de voz em Integrações)." }, 502);
      const ext = audio.mime === "audio/mpeg" ? "mp3" : "ogg";
      const path = `${tenantId}/${row.id}/narracao_${Date.now()}.${ext}`;
      const { error: upErr } = await sb.storage.from(MEDIA_BUCKET).upload(path, audio.bytes, { contentType: audio.mime, upsert: true });
      if (upErr) return json({ error: `Upload da narração: ${upErr.message}` }, 500);
      const { data: pu } = sb.storage.from(MEDIA_BUCKET).getPublicUrl(path);
      return json({ url: pu.publicUrl, texto: prepareTextForSpeech(texto), provider: audio.provider, mime: audio.mime });
    }

    // Vídeo gerado no navegador e já enviado pro bucket → registra na página
    if (action === "video_saved") {
      const id = String(body.id || "");
      const { data: row } = await sb.from("vehicle_pages").select("id, tenant_id, videos").eq("id", id).maybeSingle();
      if (!row || row.tenant_id !== tenantId) return json({ error: "Página não encontrada." }, 404);
      const url = String(body.url || "");
      if (!url.includes(`/${MEDIA_BUCKET}/`)) return json({ error: "URL do vídeo inválida." }, 400);
      const video = { url, formato: String(body.formato || "9:16"), duracao_s: Number(body.duracao_s) || null, narracao: !!body.narracao, mime: String(body.mime || "video/mp4"), criado_em: new Date().toISOString(), por: caller.user?.id || null };
      const videos = [video, ...(Array.isArray(row.videos) ? row.videos : [])].slice(0, 10);
      await sb.from("vehicle_pages").update({ videos, updated_at: new Date().toISOString() }).eq("id", id);
      return json({ ok: true, video, videos });
    }

    if (action === "publish" || action === "unpublish" || action === "delete") {
      const id = String(body.id || "");
      const { data: row } = await sb.from("vehicle_pages").select("id, tenant_id").eq("id", id).maybeSingle();
      if (!row || row.tenant_id !== tenantId) return json({ error: "Página não encontrada." }, 404);
      if (action === "delete") { await sb.from("vehicle_pages").delete().eq("id", id); return json({ ok: true }); }
      const { data: upd } = await sb.from("vehicle_pages").update({ status: action === "publish" ? "published" : "draft", published_at: action === "publish" ? new Date().toISOString() : null, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
      return json({ page: pub(upd) });
    }

    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    console.error("[vehicle-page]", action, (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
