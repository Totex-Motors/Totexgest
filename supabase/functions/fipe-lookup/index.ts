import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// ============================================================================
// FIPE — porta ÚNICA de consulta à Tabela FIPE para TODOS os projetos da Totex.
// Doc: "Integração Tabela FIPE — fipeX (Totexgest e demais projetos)".
//
// Cascata: cache → API fipeX → dataset (fipe_prices) → FIPE oficial (emergência).
// Devolve SEMPRE o mesmo formato, com `fonte`. Valores SEMPRE em centavos.
// Auth: JWT do usuário OU header x-fipe-token == FIPE_LOOKUP_TOKEN (n8n/cron).
//
// Schema fipeX validado 2026-09-21:
//   GET /search?q=<texto> → data[{price_id, model_id, fuel_id, fipe_code, make_name,
//        model_name, model_slug, fuel_acronym(com espaços), model_year,
//        latest_market_price_cents, type_name, ref_month, ref_year}]  ← FONTE DO PREÇO
//   GET /prices/expanded?model_id=&fuel_id=&year= → { price, analytics{annual_depreciation_rate,
//        value_retention_pct, anomaly_status, price_rank...}, history[...] } ← só enriquecimento
//        (INSTÁVEL: pode vir vazio; tratar como opcional).
//   fuel acronyms (minúsculos): g a d f l n h
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
function nowRef() { const d = new Date(); return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 }; }
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
  } finally { clearTimeout(t); }
}

function emptyResult() {
  return {
    ok: true, fonte: null as string | null, precisa_confirmar_modelo: false, candidatos: [] as any[],
    veiculo: null as any, preco: null as any,
    analise: { depreciacao_anual_pct: null, retencao_valor_pct: null, anomalia: null, ranking: null, volatilidade_pct: null } as any,
    historico: [] as any[],
  };
}

interface FxRec {
  price_id: string; model_id: string; fuel_id: string; codigo_fipe: string | null;
  nome_marca: string | null; nome_modelo: string | null; model_slug: string | null;
  fuel_acronym: string | null; ano_modelo: number | null; valor_centavos: number | null;
  tipo_veiculo: string | null; ref_ano: number | null; ref_mes: number | null;
}
async function fipexSearch(q: string, limit = 12): Promise<FxRec[]> {
  const d = await fetchJSON(`${FIPEX_BASE}/search?${new URLSearchParams({ q, limit: String(limit) })}`);
  const arr = Array.isArray(d?.data) ? d.data : [];
  return arr.map((r: any) => ({
    price_id: r.price_id, model_id: r.model_id, fuel_id: r.fuel_id,
    codigo_fipe: r.fipe_code ?? null, nome_marca: r.make_name ?? null, nome_modelo: r.model_name ?? null,
    model_slug: r.model_slug ?? null, fuel_acronym: trim(r.fuel_acronym) || null, ano_modelo: r.model_year ?? null,
    valor_centavos: r.latest_market_price_cents ?? null, tipo_veiculo: r.type_name ?? null,
    ref_ano: r.ref_year ?? null, ref_mes: r.ref_month ?? null,
  }));
}

// Enriquecimento opcional: análise + histórico (pode vir vazio → devolve nulls).
async function fipexAnalytics(model_id: string, fuel_id: string, year: number) {
  const d = await fetchJSON(`${FIPEX_BASE}/prices/expanded?${new URLSearchParams({ model_id, fuel_id, year: String(year) })}`);
  const an = d?.analytics;
  const pct = (x: unknown) => (x == null ? null : Math.round(Number(x) * 1000) / 10);
  const analise = an ? {
    depreciacao_anual_pct: pct(an.annual_depreciation_rate),
    retencao_valor_pct: pct(an.value_retention_pct),
    anomalia: an.anomaly_status ?? null,
    ranking: an.price_rank != null ? { posicao: an.price_rank, total: an.price_rank_total_in_category } : null,
    volatilidade_pct: pct(an.price_volatility),
  } : null;
  const historico = (d?.history ?? []).map((h: any) => ({ ano: h.year, mes: h.month, valor_centavos: h.market_price_cents }));
  return { analise, historico };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    // ── Auth ──
    let tenantId: string | null = null, memberId: string | null = null;
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

    // ── Identidade ──
    let codigo_fipe = (typeof body.codigo_fipe === "string" && body.codigo_fipe) || null;
    let preferSlug = (typeof body.modelo_slug === "string" && body.modelo_slug) || (typeof body.model_slug === "string" && body.model_slug) || null;
    const ano = Number.isFinite(Number(body.ano)) ? Number(body.ano) : null;
    const zero_km = body.zero_km === true || ano === 0;
    let fa = fuelAcronym(body.fuel_acronym ?? body.combustivel);
    let marcaTxt: string | null = typeof body.marca === "string" ? body.marca : null;
    let modeloTxt: string | null = typeof body.modelo === "string" ? body.modelo : null;
    const leadId = (typeof body.lead_id === "string" && body.lead_id) || null;
    const sellerVehicleId = (typeof body.seller_vehicle_id === "string" && body.seller_vehicle_id) || null;
    const placa = String(body.placa ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") || null;

    if (!preferSlug && !modeloTxt && placa && tenantId) {
      const { data: pl } = await sb.from("vehicle_plate_lookups").select("vehicle").eq("tenant_id", tenantId).eq("plate", placa).maybeSingle();
      const v = (pl?.vehicle ?? {}) as Record<string, unknown>;
      marcaTxt = marcaTxt || (v.marca ? String(v.marca) : null);
      modeloTxt = modeloTxt || (v.modelo ? String(v.modelo) : null);
      if (!fa) fa = fuelAcronym(v.combustivel);
    }

    const result = emptyResult();
    const ref = nowRef();

    // ── Confirmação da tela → grava de-para ──
    const confirmar = (body.confirmar && typeof body.confirmar === "object") ? body.confirmar as Record<string, unknown> : null;
    if (confirmar) {
      preferSlug = (confirmar.model_slug as string) || preferSlug;
      codigo_fipe = (confirmar.codigo_fipe as string) || codigo_fipe;
      fa = fuelAcronym(confirmar.fuel_acronym) || fa;
      if (marcaTxt && modeloTxt) {
        await sb.from("fipe_model_match").upsert({
          marca_texto: norm(marcaTxt), modelo_texto: norm(modeloTxt), ano_modelo: ano, sigla_combustivel: fa,
          codigo_fipe, model_slug: preferSlug, fuel_acronym: fa, nome_modelo_fipe: (confirmar.nome_modelo as string) ?? null,
          confirmado_por: memberId, tenant_id: tenantId, last_used_at: new Date().toISOString(),
        }, { onConflict: "marca_texto,modelo_texto,ano_modelo,sigla_combustivel" });
      }
    }

    // ── De-para conhecido → slug preferido (evita perguntar de novo) ──
    if (!preferSlug && marcaTxt && modeloTxt) {
      const { data: mm } = await sb.from("fipe_model_match").select("*")
        .eq("marca_texto", norm(marcaTxt)).eq("modelo_texto", norm(modeloTxt))
        .eq("ano_modelo", ano ?? -1).eq("sigla_combustivel", fa ?? "").maybeSingle();
      if (mm) {
        preferSlug = mm.model_slug; codigo_fipe = codigo_fipe || mm.codigo_fipe; fa = fa || mm.fuel_acronym;
        await sb.from("fipe_model_match").update({ hits: (mm.hits ?? 1) + 1, last_used_at: new Date().toISOString() }).eq("id", mm.id);
      }
    }

    // ── (a) cache do mês ──
    if (preferSlug || codigo_fipe) {
      const qc = sb.from("fipe_price_cache").select("*").order("fetched_at", { ascending: false }).limit(1);
      if (preferSlug) qc.eq("model_slug", preferSlug); else qc.eq("codigo_fipe", codigo_fipe!);
      if (ano != null) qc.eq("ano_modelo", ano);
      if (fa) qc.eq("fuel_acronym", fa);
      const { data: c } = await qc.maybeSingle();
      if (c && c.ano_referencia === ref.ano && c.mes_referencia === ref.mes) {
        const p = c.payload as any;
        result.fonte = "cache"; result.veiculo = p.veiculo; result.preco = p.preco; result.analise = p.analise ?? result.analise; result.historico = p.historico ?? [];
        codigo_fipe = codigo_fipe || p.veiculo?.codigo_fipe;
        await sb.from("fipe_price_cache").update({ hits: (c.hits ?? 1) + 1 }).eq("id", c.id);
      }
    }

    // ── (b) API fipeX: /search dá o preço; expanded enriquece (opcional) ──
    if (!result.fonte && (modeloTxt || marcaTxt)) {
      const cand = await fipexSearch([marcaTxt, modeloTxt].filter(Boolean).join(" "));
      let chosen: FxRec | null = null;
      if (preferSlug) {
        chosen = cand.find((c) => c.model_slug === preferSlug && (ano == null || c.ano_modelo === ano)) || cand.find((c) => c.model_slug === preferSlug) || null;
      }
      if (!chosen) {
        let pool = cand;
        if (ano != null) pool = pool.filter((c) => c.ano_modelo === ano);
        let poolFa = fa ? pool.filter((c) => c.fuel_acronym === fa) : pool;
        if (!poolFa.length) poolFa = pool; // combustível não bateu → não descarta tudo
        const uniq = [...new Set(poolFa.map((c) => c.model_slug))];
        if (uniq.length === 1 && poolFa[0]) chosen = poolFa[0];
        else if (poolFa.length) {
          // ambíguo → pede confirmação (candidatos JÁ trazem preço)
          const seen = new Set<string>();
          result.precisa_confirmar_modelo = true;
          result.candidatos = poolFa.filter((c) => { const k = c.model_slug || ""; if (seen.has(k)) return false; seen.add(k); return true; })
            .slice(0, 6).map((c) => ({
              label: `${c.nome_marca} ${c.nome_modelo} ${c.ano_modelo}`.trim(),
              model_slug: c.model_slug, codigo_fipe: c.codigo_fipe, fuel_acronym: c.fuel_acronym,
              nome_marca: c.nome_marca, nome_modelo: c.nome_modelo, ano_modelo: c.ano_modelo, valor_centavos: c.valor_centavos,
            }));
          return json(result);
        }
      }
      if (chosen && chosen.valor_centavos != null) {
        codigo_fipe = codigo_fipe || chosen.codigo_fipe;
        result.fonte = "fipex";
        result.veiculo = { marca: chosen.nome_marca, modelo: chosen.nome_modelo, ano_modelo: chosen.ano_modelo, combustivel: chosen.fuel_acronym, codigo_fipe };
        result.preco = { valor_centavos: chosen.valor_centavos, mes_referencia: mmRef(chosen.ref_ano, chosen.ref_mes) };
        // enriquecimento opcional
        if (chosen.model_id && chosen.fuel_id && chosen.ano_modelo) {
          const enr = await fipexAnalytics(chosen.model_id, chosen.fuel_id, chosen.ano_modelo);
          if (enr.analise) result.analise = enr.analise;
          if (enr.historico?.length) result.historico = enr.historico;
        }
        // cache
        await sb.from("fipe_price_cache").upsert({
          codigo_fipe, model_slug: chosen.model_slug, fuel_acronym: chosen.fuel_acronym, ano_modelo: chosen.ano_modelo, zero_km,
          ano_referencia: chosen.ref_ano ?? ref.ano, mes_referencia: chosen.ref_mes ?? ref.mes,
          payload: { veiculo: result.veiculo, preco: result.preco, analise: result.analise, historico: result.historico },
          fonte: "fipex", fetched_at: new Date().toISOString(),
        }, { onConflict: "codigo_fipe,ano_modelo,zero_km,fuel_acronym,ano_referencia,mes_referencia" });
      }
    }

    // ── (c) dataset ──
    if (!result.fonte && codigo_fipe) {
      const { data: rows } = await sb.from("fipe_prices").select("*")
        .eq("codigo_fipe", codigo_fipe).eq("ano_modelo", ano ?? -1).eq("zero_km", zero_km)
        .order("ano_referencia", { ascending: false }).order("mes_referencia", { ascending: false }).limit(24);
      const arr = (rows ?? []).filter((r: any) => !fa || r.sigla_combustivel === fa);
      if (arr.length) {
        const l = arr[0] as any;
        result.fonte = "dataset";
        result.veiculo = { marca: l.nome_marca, modelo: l.nome_modelo, ano_modelo: l.ano_modelo, combustivel: l.sigla_combustivel, codigo_fipe };
        result.preco = { valor_centavos: l.valor_centavos, mes_referencia: mmRef(l.ano_referencia, l.mes_referencia) };
        result.historico = arr.map((r: any) => ({ ano: r.ano_referencia, mes: r.mes_referencia, valor_centavos: r.valor_centavos }));
      }
    }

    // ── (d) FIPE oficial — TODO ──

    // ── Snapshot ──
    if (result.preco?.valor_centavos != null && (leadId || sellerVehicleId) && tenantId) {
      const [ry, rm] = String(result.preco.mes_referencia ?? "").split("-");
      await sb.from("vehicle_fipe_snapshot").insert({
        tenant_id: tenantId, lead_id: leadId, seller_vehicle_id: sellerVehicleId,
        codigo_fipe, model_slug: preferSlug ?? result.veiculo?.model_slug ?? null, nome_marca: result.veiculo?.marca ?? marcaTxt, nome_modelo: result.veiculo?.modelo ?? modeloTxt,
        ano_modelo: ano, sigla_combustivel: fa, valor_centavos: result.preco.valor_centavos,
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
