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
// Autenticação: JWT do usuário (verify_jwt=true). Para automações sem usuário
// (n8n/cron) aceita o header `x-fipe-token` == config FIPE_LOOKUP_TOKEN + tenant_id no body.
//
// ATENÇÃO: os nomes de campos da API fipeX abaixo seguem o documento; confirmar
// contra https://api.fipex.com.br/v1/docs e ajustar o mapeamento se necessário.
// Enquanto o dataset não é importado e/ou o fipeX não é validado ao vivo, a função
// responde pelas fontes que tiver (cache/dataset) e sinaliza `fonte`/`ok`.
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
const onlyDigits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

// combustível (texto PuxaPlaca ou sigla) → sigla de 1 letra da FIPE
function siglaCombustivel(v: unknown): string | null {
  const s = norm(v);
  if (!s) return null;
  if (["g", "gasolina"].includes(s)) return "G";
  if (["a", "alcool", "álcool", "etanol"].includes(s)) return "A";
  if (["d", "diesel"].includes(s)) return "D";
  if (["f", "flex", "gasolina e alcool", "gasolina e álcool", "flexível", "flexivel"].includes(s)) return "F";
  return s[0].toUpperCase();
}

function nowRef(): { ano: number; mes: number } {
  const d = new Date();
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 };
}

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

async function fetchJSON(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.warn(LOG, "fetch falhou", url, err instanceof Error ? err.message : String(err));
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(t);
  }
}

// Resposta padrão da função (mesmo formato venha de onde vier).
function emptyResult() {
  return {
    ok: true,
    fonte: null as string | null,
    precisa_confirmar_modelo: false,
    candidatos: [] as any[],
    veiculo: null as any,
    preco: null as any,
    analise: { depreciacao_anual_pct: null, retencao_valor_pct: null, anomalia: null } as any,
    historico: [] as any[],
  };
}

// ─── fipeX: preço por model_slug + fuel_acronym + year ───────────────────────
async function fipexPrice(model_slug: string, fuel_acronym: string, year: number) {
  const zero = year === 0;
  const qs = new URLSearchParams({ model_slug, fuel_acronym, year: String(year) });
  const r = await fetchJSON(`${FIPEX_BASE}/prices?${qs.toString()}`, { headers: { Accept: "application/json" } });
  if (!r.ok || !r.data) return null;
  // a doc indica: /v1/prices devolve o registro; /v1/prices/{id} traz analytics+histórico
  const rec = Array.isArray(r.data?.data) ? r.data.data[0] : (r.data?.data ?? r.data);
  if (!rec) return null;
  const id = rec.id ?? rec.price_id;
  let full = rec;
  if (id) {
    const e = await fetchJSON(`${FIPEX_BASE}/prices/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
    if (e.ok && e.data) full = e.data?.data ?? e.data;
  }
  return { rec, full, zero };
}

// mapeia o registro do fipeX para o nosso contrato (defensivo com nomes de campos)
function mapFipex(full: any) {
  const val = full?.value_cents ?? full?.valor_centavos ?? (full?.value != null ? Math.round(Number(full.value) * 100) : null);
  const an = full?.analytics ?? full?.analise ?? {};
  const hist = (full?.history ?? full?.historico ?? []).map((h: any) => ({
    ano: h.year ?? h.ano ?? null,
    mes: h.month ?? h.mes ?? null,
    valor_centavos: h.value_cents ?? h.valor_centavos ?? (h.value != null ? Math.round(Number(h.value) * 100) : null),
  }));
  return {
    codigo_fipe: full?.fipe_code ?? full?.codigo_fipe ?? null,
    nome_marca: full?.make ?? full?.marca ?? full?.brand ?? null,
    nome_modelo: full?.model ?? full?.modelo ?? null,
    ano_modelo: full?.year ?? full?.ano_modelo ?? null,
    sigla_combustivel: full?.fuel_acronym ?? full?.sigla_combustivel ?? null,
    valor_centavos: val,
    ref_ano: full?.reference_year ?? full?.ano_referencia ?? null,
    ref_mes: full?.reference_month ?? full?.mes_referencia ?? null,
    analise: {
      depreciacao_anual_pct: an?.annual_depreciation_pct ?? an?.depreciacao_anual_pct ?? null,
      retencao_valor_pct: an?.value_retention_pct ?? an?.retencao_valor_pct ?? null,
      anomalia: an?.anomaly ?? an?.anomalia ?? null,
    },
    historico: hist,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    // ── Autenticação: JWT do usuário OU token de serviço (n8n/cron) ──
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
      tenantId = member.tenant_id;
      memberId = member.id;
    }

    // ── Identidade do veículo ──
    let codigo_fipe = (typeof body.codigo_fipe === "string" && body.codigo_fipe) || null;
    let model_slug = (typeof body.modelo_slug === "string" && body.modelo_slug) || null;
    let fuel_acronym = (typeof body.fuel_acronym === "string" && body.fuel_acronym) || null;
    const ano = Number.isFinite(Number(body.ano)) ? Number(body.ano) : null;
    const zero_km = body.zero_km === true || ano === 0;
    let sigla = siglaCombustivel(body.combustivel);
    let marcaTxt: string | null = null, modeloTxt: string | null = null;
    const leadId = (typeof body.lead_id === "string" && body.lead_id) || null;
    const sellerVehicleId = (typeof body.seller_vehicle_id === "string" && body.seller_vehicle_id) || null;
    const placa = onlyDigits(body.placa) ? String(body.placa).toUpperCase().replace(/[^A-Z0-9]/g, "") : null;

    // Se veio só a placa, tenta puxar marca/modelo do cache de placa do tenant.
    if (!codigo_fipe && !model_slug && placa && tenantId) {
      const { data: pl } = await sb.from("vehicle_plate_lookups").select("vehicle").eq("tenant_id", tenantId).eq("plate", placa).maybeSingle();
      const v = (pl?.vehicle ?? {}) as Record<string, unknown>;
      marcaTxt = v.marca ? String(v.marca) : null;
      modeloTxt = v.modelo ? String(v.modelo) : null;
      if (!sigla) sigla = siglaCombustivel(v.combustivel);
    }
    if (typeof body.marca === "string") marcaTxt = body.marca;
    if (typeof body.modelo === "string") modeloTxt = body.modelo;

    const result = emptyResult();
    const ref = nowRef();

    // ── Resolver modelo FIPE (codigo_fipe/model_slug) ──
    // 1) confirmação explícita vinda da tela → grava de-para e segue
    const confirmar = (body.confirmar && typeof body.confirmar === "object") ? body.confirmar as Record<string, unknown> : null;
    if (confirmar) {
      codigo_fipe = (confirmar.codigo_fipe as string) || codigo_fipe;
      model_slug = (confirmar.model_slug as string) || model_slug;
      fuel_acronym = (confirmar.fuel_acronym as string) || fuel_acronym;
      if (marcaTxt && modeloTxt) {
        await sb.from("fipe_model_match").upsert({
          marca_texto: norm(marcaTxt), modelo_texto: norm(modeloTxt), ano_modelo: ano, sigla_combustivel: sigla,
          codigo_fipe, model_slug, fuel_acronym, nome_modelo_fipe: (confirmar.nome_modelo as string) ?? null,
          confirmado_por: memberId, tenant_id: tenantId, last_used_at: new Date().toISOString(),
        }, { onConflict: "marca_texto,modelo_texto,ano_modelo,sigla_combustivel" });
      }
    }

    // 2) de-para já conhecido
    if (!codigo_fipe && !model_slug && marcaTxt && modeloTxt) {
      const { data: mm } = await sb.from("fipe_model_match").select("*")
        .eq("marca_texto", norm(marcaTxt)).eq("modelo_texto", norm(modeloTxt))
        .eq("ano_modelo", ano ?? -1).eq("sigla_combustivel", sigla ?? "").maybeSingle();
      if (mm) {
        codigo_fipe = mm.codigo_fipe; model_slug = mm.model_slug; fuel_acronym = mm.fuel_acronym;
        await sb.from("fipe_model_match").update({ hits: (mm.hits ?? 1) + 1, last_used_at: new Date().toISOString() }).eq("id", mm.id);
      }
    }

    // 3) ainda sem modelo → autocomplete no fipeX (candidatos p/ a pessoa confirmar)
    if (!codigo_fipe && !model_slug && (modeloTxt || marcaTxt)) {
      const q = [marcaTxt, modeloTxt].filter(Boolean).join(" ");
      const r = await fetchJSON(`${FIPEX_BASE}/search/labels?${new URLSearchParams({ q, limit: "5" }).toString()}`, { headers: { Accept: "application/json" } });
      const list = Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []);
      result.precisa_confirmar_modelo = true;
      result.candidatos = list.slice(0, 5).map((c: any) => ({
        label: c.label ?? c.name ?? c.model ?? null,
        model_slug: c.model_slug ?? c.slug ?? null,
        codigo_fipe: c.fipe_code ?? c.codigo_fipe ?? null,
        fuel_acronym: c.fuel_acronym ?? null,
        nome_modelo: c.model ?? c.modelo ?? null,
        nome_marca: c.make ?? c.marca ?? null,
      }));
      return json(result); // sem preço até confirmar o modelo
    }

    fuel_acronym = fuel_acronym || sigla; // fallback

    // ── Cascata de PREÇO ──
    const idKey = { codigo_fipe, ano_modelo: ano, zero_km, fuel_acronym };

    // (a) cache do mês corrente
    if (codigo_fipe) {
      const { data: c } = await sb.from("fipe_price_cache").select("*")
        .eq("codigo_fipe", codigo_fipe).eq("ano_modelo", ano ?? -1).eq("zero_km", zero_km)
        .eq("fuel_acronym", fuel_acronym ?? "").order("fetched_at", { ascending: false }).limit(1).maybeSingle();
      if (c) {
        const sameMonth = c.ano_referencia === ref.ano && c.mes_referencia === ref.mes;
        const fetchedMonth = c.fetched_at && new Date(c.fetched_at).getUTCFullYear() === ref.ano && (new Date(c.fetched_at).getUTCMonth() + 1) === ref.mes;
        if (sameMonth || fetchedMonth) {
          const p = c.payload as any;
          result.fonte = "cache";
          result.veiculo = p.veiculo ?? null;
          result.preco = p.preco ?? null;
          result.analise = p.analise ?? result.analise;
          result.historico = p.historico ?? [];
          await sb.from("fipe_price_cache").update({ hits: (c.hits ?? 1) + 1 }).eq("id", c.id);
        }
      }
    }

    // (b) API fipeX
    if (!result.fonte && model_slug && fuel_acronym && ano != null) {
      const fx = await fipexPrice(model_slug, fuel_acronym, ano);
      if (fx) {
        const m = mapFipex(fx.full);
        codigo_fipe = codigo_fipe || m.codigo_fipe;
        result.fonte = "fipex";
        result.veiculo = { marca: m.nome_marca, modelo: m.nome_modelo, ano_modelo: m.ano_modelo, combustivel: fuel_acronym, codigo_fipe };
        result.preco = { valor_centavos: m.valor_centavos, mes_referencia: m.ref_ano && m.ref_mes ? `${m.ref_ano}-${String(m.ref_mes).padStart(2, "0")}` : null };
        result.analise = m.analise;
        result.historico = m.historico;
        // grava no cache global
        if (codigo_fipe && m.valor_centavos != null) {
          await sb.from("fipe_price_cache").upsert({
            codigo_fipe, model_slug, fuel_acronym, ano_modelo: ano, zero_km,
            ano_referencia: m.ref_ano ?? ref.ano, mes_referencia: m.ref_mes ?? ref.mes,
            payload: { veiculo: result.veiculo, preco: result.preco, analise: result.analise, historico: result.historico },
            fonte: "fipex", fetched_at: new Date().toISOString(),
          }, { onConflict: "codigo_fipe,ano_modelo,zero_km,fuel_acronym,ano_referencia,mes_referencia" });
        }
      }
    }

    // (c) dataset importado (fipe_prices) — release mais recente
    if (!result.fonte && codigo_fipe) {
      const { data: rows } = await sb.from("fipe_prices").select("*")
        .eq("codigo_fipe", codigo_fipe).eq("ano_modelo", ano ?? -1).eq("zero_km", zero_km)
        .order("ano_referencia", { ascending: false }).order("mes_referencia", { ascending: false }).limit(24);
      const arr = (rows ?? []).filter((r: any) => !sigla || r.sigla_combustivel === sigla);
      if (arr.length) {
        const latest = arr[0] as any;
        result.fonte = "dataset";
        result.veiculo = { marca: latest.nome_marca, modelo: latest.nome_modelo, ano_modelo: latest.ano_modelo, combustivel: latest.sigla_combustivel, codigo_fipe };
        result.preco = { valor_centavos: latest.valor_centavos, mes_referencia: `${latest.ano_referencia}-${String(latest.mes_referencia).padStart(2, "0")}` };
        result.historico = arr.map((r: any) => ({ ano: r.ano_referencia, mes: r.mes_referencia, valor_centavos: r.valor_centavos }));
      }
    }

    // (d) FIPE oficial (emergência) — só quando temos o código FIPE
    if (!result.fonte && codigo_fipe) {
      console.log(LOG, "fallback FIPE oficial p/", codigo_fipe);
      // POST https://veiculos.fipe.org.br/api/veiculos/ConsultarValorComTodosParametros com tipoConsulta:"codigo"
      // Implementação de emergência — habilitar com volume baixo (pode bloquear).
      // Deixado como TODO controlado: retorna sem preço, registrando a tentativa.
      result.fonte = null;
    }

    // ── Snapshot na captação (append-only) ──
    if (result.preco?.valor_centavos != null && (leadId || sellerVehicleId) && tenantId) {
      const [ry, rm] = String(result.preco.mes_referencia ?? "").split("-");
      await sb.from("vehicle_fipe_snapshot").insert({
        tenant_id: tenantId, lead_id: leadId, seller_vehicle_id: sellerVehicleId,
        codigo_fipe, model_slug, nome_marca: result.veiculo?.marca ?? marcaTxt, nome_modelo: result.veiculo?.modelo ?? modeloTxt,
        ano_modelo: ano, sigla_combustivel: sigla, valor_centavos: result.preco.valor_centavos,
        ano_referencia: ry ? Number(ry) : ref.ano, mes_referencia: rm ? Number(rm) : ref.mes,
        fonte: result.fonte, analise: result.analise, historico: result.historico, created_by: memberId,
      });
    }

    if (!result.fonte && !result.precisa_confirmar_modelo) {
      return json({ ...result, ok: false, motivo: "Sem preço FIPE: dataset não importado e/ou fipeX indisponível. Confirme o modelo ou tente mais tarde." });
    }
    return json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message }, 500);
  }
});
