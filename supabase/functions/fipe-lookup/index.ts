import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// ============================================================================
// FIPE — porta ÚNICA de consulta à Tabela FIPE para TODOS os projetos da Totex.
// Doc: "Integração Tabela FIPE — fipeX (Totexgest e demais projetos)".
//
// Cascata de fontes (nesta ordem):
//   1. cache          — fipe_price_cache (resposta fipeX do mês corrente)
//   2. fipex          — API pública https://api.fipex.com.br/v1 (10 req/s por IP)
//   3. dataset        — base fipe_prices (release do dataset fipeX importada)
//   4. fipe_oficial   — POST veiculos.fipe.org.br (fallback de emergência)
//
// A função devolve SEMPRE o mesmo formato, com `fonte` indicando a origem.
// Valores SEMPRE em centavos (inteiro). Nunca chama fipeX/FIPE do front.
//
// Autenticação: JWT do usuário (front) OU header `x-fipe-token` == FIPE_LOOKUP_TOKEN
// (config) + tenant_id no body (n8n/cron).
//
// Schema fipeX validado em 2026-09-21:
//   GET /search?q=<texto>          → data[{price_id, fipe_code, make_name, model_name,
//                                    model_slug, fuel_acronym (com espaços!), model_year,
//                                    latest_market_price_cents, type_name, ref_month, ref_year}]
//   GET /prices/expanded?model_slug=&year=&fuel_acronym=
//                                  → { price{price_cents, reference{month,year}, fipe_code, make/model/fuel},
//                                      analytics{annual_depreciation_rate, value_retention_pct, anomaly_status, ...},
//                                      history[{year, month, market_price_cents}] }
//   fuel acronyms (minúsculos): g Gasolina · a Álcool · d Diesel · f Flex · l Elétrico · n GNV · h Híbrido
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fipe-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const LOG = "[fipe-lookup]";
const FIPEX_BASE = "https://api.fipex.com.br/v1";
const REQ_TIMEOUT_MS = 15_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const trim = (s: unknown) => String(s ?? "").trim();

// combustível (texto PuxaPlaca ou sigla) → acrônimo minúsculo da FIPE/fipeX
function fuelAcronym(v: unknown): string | null {
  const s = norm(v);
  if (!s) return null;
  if (["g", "gasolina"].includes(s)) return "g";
  if (["a", "alcool", "álcool", "etanol"].includes(s)) return "a";
  if (["d", "diesel"].includes(s)) return "d";
  if (["l", "eletrico", "elétrico"].includes(s)) return "l";
  if (["n", "gnv", "gas natural", "gás natural"].includes(s)) return "n";
  if (["h", "hibrido", "híbrido"].includes(s)) return "h";
  if (["f", "flex", "gasolina e alcool", "gasolina e álcool", "flexível", "flexivel"].includes(s)) return "f";
  return s[0];
}

function nowRef(): { ano: number; mes: number } {
  const d = new Date();
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 };
}
const mmRef = (ano: number | null, mes: number | null) => (ano && mes ? `${ano}-${String(mes).padStart(2, "0")}` : null);

interface Member { id: string; tenant_id: string; role: string; name: string | null }
async function resolveMember(sb: SupabaseClient, user: { id: string; email?: string }): Promise<Member | null> {
  const cols = "id, tenant_id, role, name";
  if (user.email) {
    const { data } = await sb.from("team_members").select(cols).eq("email", user.email).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (data) return data as Member;
  }
  const { data } = await sb.from("team_members").select(cols).eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
  return (data as Member | null) ?? null;
}

async function fetchJSON(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return res.ok ? data : null;
  } catch (err) {
    console.warn(LOG, "fetch falhou", url.replace(/\?.*/, ""), err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(t);
  }
}

function emptyResult() {
  return {
    ok: true,
    fonte: null as string | null,
    precisa_confirmar_modelo: false,
    candidatos: [] as any[],
    veiculo: null as any,
    preco: null as any,
    analise: { depreciacao_anual_pct: null, retencao_valor_pct: null, anomalia: null, ranking: null, volatilidade_pct: null } as any,
    historico: [] as any[],
  };
}

// ─── fipeX: busca por texto → candidatos com preço/identidade ────────────────
async function fipexSearch(q: string, limit = 8): Promise<any[]> {
  const d = await fetchJSON(`${FIPEX_BASE}/search?${new URLSearchParams({ q, limit: String(limit) })}`);
  const arr = Array.isArray(d?.data) ? d.data : [];
  return arr.map((r: any) => ({
    price_id: r.price_id,
    codigo_fipe: r.fipe_code ?? null,
    nome_marca: r.make_name ?? null,
    nome_modelo: r.model_name ?? null,
    model_slug: r.model_slug ?? null,
    fuel_acronym: trim(r.fuel_acronym) || null,
    ano_modelo: r.model_year ?? null,
    valor_centavos: r.latest_market_price_cents ?? null,
    tipo_veiculo: r.type_name ?? null,
    ref_ano: r.ref_year ?? null,
    ref_mes: r.ref_month ?? null,
  }));
}

// ─── fipeX: detalhe completo (preço + analytics + histórico) ─────────────────
async function fipexExpanded(model_slug: string, year: number, fuel_acronym: string): Promise<any | null> {
  const qs = new URLSearchParams({ model_slug, year: String(year), fuel_acronym });
  const d = await fetchJSON(`${FIPEX_BASE}/prices/expanded?${qs}`);
  const p = d?.price;
  if (!p) return null;
  const an = d?.analytics ?? {};
  const pct = (x: unknown) => (x == null ? null : Math.round(Number(x) * 1000) / 10); // fração → % com 1 casa
  return {
    veiculo: {
      marca: p.make?.name ?? null,
      modelo: p.model?.name ?? null,
      ano_modelo: p.model_year ?? year,
      combustivel: p.fuel?.name ?? null,
      codigo_fipe: p.fipe_code ?? null,
    },
    preco: { valor_centavos: p.price_cents ?? null, mes_referencia: mmRef(p.reference?.year, p.reference?.month) },
    analise: {
      depreciacao_anual_pct: pct(an.annual_depreciation_rate),
      retencao_valor_pct: pct(an.value_retention_pct),
      anomalia: an.anomaly_status ?? null,
      ranking: an.price_rank != null ? { posicao: an.price_rank, total: an.price_rank_total_in_category } : null,
      volatilidade_pct: pct(an.price_volatility),
    },
    historico: (d?.history ?? []).map((h: any) => ({ ano: h.year, mes: h.month, valor_centavos: h.market_price_cents })),
    codigo_fipe: p.fipe_code ?? null,
    model_slug: p.model?.slug ?? model_slug,
    fuel_acronym: p.fuel?.acronym ?? fuel_acronym,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    // ── Auth: JWT do usuário OU token de serviço ──
    let tenantId: string | null = null;
    let memberId: string | null = null;
    const svcToken = req.headers.get("x-fipe-token");
    if (svcToken) {
      const expected = await getIntegrationKey(sb, "FIPE_LOOKUP_TOKEN");
      if (!expected || svcToken !== expected) return json({ error: "Token de serviço inválido" }, 401);
      tenantId = typeof body.tenant_id === "string" ? body.tenant_id : null;
    } else {
      const auth = req.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Sem autenticação" }, 401);
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);
      const member = await resolveMember(sb, user);
      if (!member) return json({ error: "Membro do time não encontrado" }, 403);
      tenantId = member.tenant_id; memberId = member.id;
    }

    // ── Identidade do veículo ──
    let codigo_fipe = (typeof body.codigo_fipe === "string" && body.codigo_fipe) || null;
    let model_slug = (typeof body.modelo_slug === "string" && body.modelo_slug) || (typeof body.model_slug === "string" && body.model_slug) || null;
    const ano = Number.isFinite(Number(body.ano)) ? Number(body.ano) : null;
    const zero_km = body.zero_km === true || ano === 0;
    let fa = fuelAcronym(body.fuel_acronym ?? body.combustivel);
    let marcaTxt: string | null = typeof body.marca === "string" ? body.marca : null;
    let modeloTxt: string | null = typeof body.modelo === "string" ? body.modelo : null;
    const leadId = (typeof body.lead_id === "string" && body.lead_id) || null;
    const sellerVehicleId = (typeof body.seller_vehicle_id === "string" && body.seller_vehicle_id) || null;
    const placa = String(body.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") || null;

    // Só a placa → puxa marca/modelo/combustível do cache de placa do tenant
    if (!codigo_fipe && !model_slug && !modeloTxt && placa && tenantId) {
      const { data: pl } = await sb.from("vehicle_plate_lookups").select("vehicle").eq("tenant_id", tenantId).eq("plate", placa).maybeSingle();
      const v = (pl?.vehicle ?? {}) as Record<string, unknown>;
      marcaTxt = marcaTxt || (v.marca ? String(v.marca) : null);
      modeloTxt = modeloTxt || (v.modelo ? String(v.modelo) : null);
      if (!fa) fa = fuelAcronym(v.combustivel);
    }

    const result = emptyResult();
    const ref = nowRef();

    // ── Confirmação explícita da tela → grava de-para e segue ──
    const confirmar = (body.confirmar && typeof body.confirmar === "object") ? body.confirmar as Record<string, unknown> : null;
    if (confirmar) {
      codigo_fipe = (confirmar.codigo_fipe as string) || codigo_fipe;
      model_slug = (confirmar.model_slug as string) || model_slug;
      fa = fuelAcronym(confirmar.fuel_acronym) || fa;
      if (marcaTxt && modeloTxt) {
        await sb.from("fipe_model_match").upsert({
          marca_texto: norm(marcaTxt), modelo_texto: norm(modeloTxt), ano_modelo: ano, sigla_combustivel: fa,
          codigo_fipe, model_slug, fuel_acronym: fa, nome_modelo_fipe: (confirmar.nome_modelo as string) ?? null,
          confirmado_por: memberId, tenant_id: tenantId, last_used_at: new Date().toISOString(),
        }, { onConflict: "marca_texto,modelo_texto,ano_modelo,sigla_combustivel" });
      }
    }

    // ── De-para já conhecido ──
    if (!model_slug && marcaTxt && modeloTxt) {
      const { data: mm } = await sb.from("fipe_model_match").select("*")
        .eq("marca_texto", norm(marcaTxt)).eq("modelo_texto", norm(modeloTxt))
        .eq("ano_modelo", ano ?? -1).eq("sigla_combustivel", fa ?? "").maybeSingle();
      if (mm) {
        model_slug = mm.model_slug; codigo_fipe = codigo_fipe || mm.codigo_fipe; fa = fa || mm.fuel_acronym;
        await sb.from("fipe_model_match").update({ hits: (mm.hits ?? 1) + 1, last_used_at: new Date().toISOString() }).eq("id", mm.id);
      }
    }

    // ── Sem modelo resolvido → busca no fipeX; 1 match usa, vários = confirmar ──
    if (!model_slug && (modeloTxt || marcaTxt)) {
      const cand = await fipexSearch([marcaTxt, modeloTxt].filter(Boolean).join(" "));
      let filtered = cand;
      if (ano != null) filtered = filtered.filter((c) => c.ano_modelo === ano);
      if (fa) filtered = filtered.filter((c) => !c.fuel_acronym || c.fuel_acronym === fa);
      const uniqSlugs = [...new Set(filtered.map((c) => c.model_slug))];
      if (uniqSlugs.length === 1 && filtered[0]) {
        model_slug = filtered[0].model_slug; codigo_fipe = codigo_fipe || filtered[0].codigo_fipe; fa = fa || filtered[0].fuel_acronym;
      } else {
        // devolve candidatos (sem preço final até confirmar)
        const seen = new Set<string>();
        result.precisa_confirmar_modelo = true;
        result.candidatos = (filtered.length ? filtered : cand).filter((c) => {
          const k = `${c.model_slug}|${c.ano_modelo}`; if (seen.has(k)) return false; seen.add(k); return true;
        }).slice(0, 6).map((c) => ({
          label: `${c.nome_marca} ${c.nome_modelo} ${c.ano_modelo}`.trim(),
          model_slug: c.model_slug, codigo_fipe: c.codigo_fipe, fuel_acronym: c.fuel_acronym,
          nome_marca: c.nome_marca, nome_modelo: c.nome_modelo, ano_modelo: c.ano_modelo, valor_centavos: c.valor_centavos,
        }));
        return json(result);
      }
    }

    const anoFinal = ano ?? (result.candidatos[0]?.ano_modelo ?? null);

    // ── (a) cache do mês corrente ──
    if (model_slug || codigo_fipe) {
      const q = sb.from("fipe_price_cache").select("*").order("fetched_at", { ascending: false }).limit(1);
      if (model_slug) q.eq("model_slug", model_slug); else q.eq("codigo_fipe", codigo_fipe!);
      if (anoFinal != null) q.eq("ano_modelo", anoFinal);
      if (fa) q.eq("fuel_acronym", fa);
      const { data: c } = await q.maybeSingle();
      if (c && c.ano_referencia === ref.ano && c.mes_referencia === ref.mes) {
        const p = c.payload as any;
        result.fonte = "cache"; result.veiculo = p.veiculo; result.preco = p.preco; result.analise = p.analise ?? result.analise; result.historico = p.historico ?? [];
        codigo_fipe = codigo_fipe || p.veiculo?.codigo_fipe;
        await sb.from("fipe_price_cache").update({ hits: (c.hits ?? 1) + 1 }).eq("id", c.id);
      }
    }

    // ── (b) API fipeX (expanded) ──
    if (!result.fonte && model_slug && fa && anoFinal != null) {
      const ex = await fipexExpanded(model_slug, anoFinal, fa);
      if (ex && ex.preco?.valor_centavos != null) {
        result.fonte = "fipex"; result.veiculo = ex.veiculo; result.preco = ex.preco; result.analise = ex.analise; result.historico = ex.historico;
        codigo_fipe = codigo_fipe || ex.codigo_fipe;
        const [ry, rm] = String(ex.preco.mes_referencia ?? "").split("-");
        await sb.from("fipe_price_cache").upsert({
          codigo_fipe, model_slug, fuel_acronym: fa, ano_modelo: anoFinal, zero_km,
          ano_referencia: ry ? Number(ry) : ref.ano, mes_referencia: rm ? Number(rm) : ref.mes,
          payload: { veiculo: ex.veiculo, preco: ex.preco, analise: ex.analise, historico: ex.historico },
          fonte: "fipex", fetched_at: new Date().toISOString(),
        }, { onConflict: "codigo_fipe,ano_modelo,zero_km,fuel_acronym,ano_referencia,mes_referencia" });
      }
    }

    // ── (c) dataset importado (fipe_prices) ──
    if (!result.fonte && codigo_fipe) {
      const { data: rows } = await sb.from("fipe_prices").select("*")
        .eq("codigo_fipe", codigo_fipe).eq("ano_modelo", anoFinal ?? -1).eq("zero_km", zero_km)
        .order("ano_referencia", { ascending: false }).order("mes_referencia", { ascending: false }).limit(24);
      const arr = (rows ?? []).filter((r: any) => !fa || r.sigla_combustivel === fa);
      if (arr.length) {
        const l = arr[0] as any;
        result.fonte = "dataset";
        result.veiculo = { marca: l.nome_marca, modelo: l.nome_modelo, ano_modelo: l.ano_modelo, combustivel: l.nome_combustivel, codigo_fipe };
        result.preco = { valor_centavos: l.valor_centavos, mes_referencia: mmRef(l.ano_referencia, l.mes_referencia) };
        result.historico = arr.map((r: any) => ({ ano: r.ano_referencia, mes: r.mes_referencia, valor_centavos: r.valor_centavos }));
      }
    }

    // ── (d) FIPE oficial (emergência) — TODO habilitar com volume baixo ──

    // ── Snapshot na captação (append-only) ──
    if (result.preco?.valor_centavos != null && (leadId || sellerVehicleId) && tenantId) {
      const [ry, rm] = String(result.preco.mes_referencia ?? "").split("-");
      await sb.from("vehicle_fipe_snapshot").insert({
        tenant_id: tenantId, lead_id: leadId, seller_vehicle_id: sellerVehicleId,
        codigo_fipe, model_slug, nome_marca: result.veiculo?.marca ?? marcaTxt, nome_modelo: result.veiculo?.modelo ?? modeloTxt,
        ano_modelo: anoFinal, sigla_combustivel: fa, valor_centavos: result.preco.valor_centavos,
        ano_referencia: ry ? Number(ry) : ref.ano, mes_referencia: rm ? Number(rm) : ref.mes,
        fonte: result.fonte, analise: result.analise, historico: result.historico, created_by: memberId,
      });
    }

    if (!result.fonte && !result.precisa_confirmar_modelo) {
      return json({ ...result, ok: false, motivo: "Não encontrei o preço FIPE. Confirme marca/modelo/ano ou tente de novo." });
    }
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message }, 500);
  }
});
