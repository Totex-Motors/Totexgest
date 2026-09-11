import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// Captação (promotoras) — validação da etapa "Anunciado" da jornada do carro.
//
// Modos (body.mode):
//   - listings    : cron `capture-listings` (2×/dia) ou botão "Sincronizar agora".
//                   Pra cada tenant com loja configurada, baixa o estoque da loja
//                   no marketplace Totex (1 request por página, não por carro) e
//                   casa com os carros captados em captado/preparação/anunciado.
//                   Achou → capture_listing_sync_apply(found=true) → vira Anunciado
//                   (link/preço guardados). Sumiu → found=false → 2ª checagem
//                   seguida abre tarefa pro especialista ("vendeu ou tirou?").
//   - dealerships : lista as lojas do marketplace (id, nome, nº de carros) pra
//                   UI de Configurações › Captação escolher a loja.
//
// Sem JWT (cron). Quando vem Authorization de usuário (botão da UI), exige
// admin do tenant e aceita tenant_id/force. Só lê o marketplace — nunca escreve.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const DEFAULT_BASE = "https://totexmotors.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** Entre syncs manuais: evita spam no botão (cron passa direto). */
const MIN_INTERVAL_MS = 60_000;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

interface StockVehicle {
  id: string;
  brand: string;
  model: string;
  version: string;
  year: number | null;
  mileage: number | null;
  price: number | null;
  plate: string | null;
  status: string | null;
  title: string;
}

interface CapturedVehicle {
  id: string;
  lead_id: string;
  status: string;
  brand: string | null;
  model: string | null;
  version: string | null;
  description: string | null;
  year_model: number | null;
  km: number | null;
  plate_last4: string | null;
  marketplace_vehicle_id: string | null;
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Palavras que não identificam o carro (aparecem em qualquer anúncio). */
const STOP = new Set([
  "flex", "aut", "auto", "automatico", "automatic", "manual", "mec", "mecanico", "gasolina", "diesel", "alcool",
  "etanol", "hibrido", "eletrico", "completo", "completa", "sedan", "seda", "hatch", "suv", "pick", "pickup", "cabine",
  "dupla", "simples", "portas", "lugares", "turbo", "tsi", "tfsi", "cvt", "at", "mt", "com", "sem", "de", "do", "da",
  "e", "the", "carro", "veiculo", "usado", "novo", "km", "ano", "cor", "unico", "dono", "novissimo",
]);

function tokens(s: unknown): string[] {
  return norm(s).split(/[^a-z0-9]+/).filter((t) => /^[a-z]{2,}$/.test(t) && !STOP.has(t));
}

function toStock(v: Row): StockVehicle {
  const brand = String(v.brand ?? "");
  const model = String(v.model ?? "");
  const version = String(v.version ?? "");
  return {
    id: String(v.id),
    brand, model, version,
    year: Number.isFinite(Number(v.year)) ? Number(v.year) : null,
    mileage: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null,
    price: Number.isFinite(Number(v.price)) && Number(v.price) > 0 ? Number(v.price) : null,
    plate: v.plate ? String(v.plate) : null,
    status: v.status ? String(v.status) : null,
    title: [brand, model, version].filter(Boolean).join(" "),
  };
}

/** Baixa o estoque inteiro da loja (paginado). Uma chamada por página, não por carro. */
async function fetchStoreStock(base: string, storeId: string): Promise<StockVehicle[]> {
  const out: StockVehicle[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const qs = new URLSearchParams({ dealershipId: storeId, limit: String(PAGE_SIZE), page: String(page) });
    const res = await fetch(`${base}/api/vehicles?${qs}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`marketplace ${res.status} ao listar estoque da loja ${storeId}`);
    const data = await res.json();
    const list: Row[] = Array.isArray(data?.data) ? data.data : [];
    out.push(...list.map(toStock));
    const totalPages = Number(data?.totalPages ?? 1);
    if (list.length < PAGE_SIZE || page >= totalPages) break;
  }
  return out.filter((v) => !v.status || v.status.toUpperCase() === "ACTIVE");
}

/**
 * Casa um carro captado com o estoque. Regras (todas precisam bater):
 *  1. id do marketplace já conhecido → só confere se ainda está ativo;
 *  2. modelo: a 1ª palavra identificadora do carro captado (model, senão
 *     description sem o ano) tem que aparecer como PALAVRA INTEIRA no anúncio
 *     ("gol" casa "Gol", não "Golf");
 *  3. marca (se informada) tem que bater;
 *  4. ano (se informado) tem que ser igual;
 *  5. placa final (se os dois lados tiverem) tem que bater;
 *  6. km (se os dois lados tiverem) dentro de ±25%.
 * Desempate: mais palavras em comum; depois km mais próximo. Empate real → não
 * casa (melhor ficar em "Captado" do que marcar o carro errado).
 */
function matchVehicle(v: CapturedVehicle, stock: StockVehicle[]): StockVehicle | null {
  if (v.marketplace_vehicle_id) {
    return stock.find((s) => s.id === v.marketplace_vehicle_id) ?? null;
  }
  const brandTok = tokens(v.brand);
  const modelTok = tokens(v.model);
  const descTok = tokens(v.description).filter((t) => !brandTok.includes(t));
  const key = modelTok[0] ?? descTok[0];
  if (!key) return null;
  const extras = Array.from(new Set([...modelTok.slice(1), ...tokens(v.version), ...descTok.filter((t) => t !== key)]));

  const scored: { s: StockVehicle; score: number; kmDiff: number }[] = [];
  for (const s of stock) {
    const hay = norm(s.title);
    if (!new RegExp(`\\b${key}\\b`).test(hay)) continue;
    if (brandTok.length && !brandTok.some((b) => new RegExp(`\\b${b}\\b`).test(norm(s.brand)) || new RegExp(`\\b${b}\\b`).test(hay))) continue;
    if (v.year_model && s.year && v.year_model !== s.year) continue;
    if (v.plate_last4 && s.plate) {
      const last4 = norm(s.plate).replace(/[^a-z0-9]/g, "").slice(-4);
      if (last4 && last4 !== norm(v.plate_last4).replace(/[^a-z0-9]/g, "").slice(-4)) continue;
    }
    let kmDiff = 0;
    if (v.km != null && v.km > 0 && s.mileage != null && s.mileage > 0) {
      kmDiff = Math.abs(s.mileage - v.km);
      if (kmDiff > v.km * 0.25) continue;
    }
    const score = extras.filter((t) => new RegExp(`\\b${t}\\b`).test(hay)).length;
    scored.push({ s, score, kmDiff });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.kmDiff - b.kmDiff);
  const best = scored[0];
  const tie = scored.filter((x) => x.score === best.score && x.kmDiff === best.kmDiff && x.s.id !== best.s.id);
  if (tie.length > 0) return null; // ambíguo
  return best.s;
}

async function syncTenant(sb: SupabaseClient, cfg: Row, base: string, storeFallback: string | null) {
  const tenantId = String(cfg.tenant_id);
  const storeId = (cfg.marketplace_store_id as string | null) || storeFallback;
  const summary: Row = { tenant_id: tenantId, store_id: storeId, vehicles: 0, anunciado: 0, seen: 0, missing: 0, alert: 0, not_listed: 0, skipped: 0 };

  const { data: vehicles, error } = await sb
    .from("seller_vehicles")
    .select("id, lead_id, status, brand, model, version, description, year_model, km, plate_last4, marketplace_vehicle_id, leads!inner(captured_by_member_id)")
    .eq("tenant_id", tenantId)
    .in("status", ["captado", "preparacao", "anunciado"])
    .not("leads.captured_by_member_id", "is", null);
  if (error) throw error;
  const list = (vehicles ?? []) as unknown as CapturedVehicle[];
  summary.vehicles = list.length;

  if (list.length === 0) {
    summary.result = "nenhum carro captado aguardando anúncio";
  } else if (!storeId) {
    summary.result = "loja no marketplace não configurada — configure em Configurações › Captação";
    summary.skipped = list.length;
  } else {
    const stock = await fetchStoreStock(base, storeId);
    summary.stock = stock.length;
    for (const v of list) {
      const m = matchVehicle(v, stock);
      const { data: action, error: aErr } = await sb.rpc("capture_listing_sync_apply", {
        p_vehicle_id: v.id,
        p_found: !!m,
        p_marketplace_id: m?.id ?? null,
        p_url: m ? `${base}/veiculo/${m.id}` : null,
        p_price: m?.price ?? null,
      });
      if (aErr) { console.error("[capture-listing-sync] apply", v.id, aErr.message); summary.skipped++; continue; }
      const a = String(action);
      if (a === "anunciado") summary.anunciado++;
      else if (a === "seen") summary.seen++;
      else if (a === "alert") summary.alert++;
      else if (a.startsWith("missing")) summary.missing++;
      else if (a === "not_listed") summary.not_listed++;
      else summary.skipped++;
    }
    summary.result = `${stock.length} no estoque · ${summary.anunciado} viraram Anunciado · ${summary.seen} seguem anunciados · ${summary.not_listed} ainda sem anúncio · ${summary.missing} sumiram · ${summary.alert} tarefas abertas`;
  }

  await sb.from("capture_handoff_config")
    .update({ listing_last_sync_at: new Date().toISOString(), listing_last_sync_result: String(summary.result) })
    .eq("tenant_id", tenantId);
  return summary;
}

/** Usuário logado (botão da UI): precisa ser admin; devolve o tenant dele. */
async function callerTenant(sb: SupabaseClient, req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === SERVICE_KEY || token === ANON_KEY) return null;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user?.email) return null;
  const { data: tm } = await sb.from("team_members").select("tenant_id, role").eq("email", user.email).limit(1).maybeSingle();
  if (!tm || tm.role !== "admin") return null;
  return tm.tenant_id as string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = (await req.json().catch(() => ({}))) as Row;
    const mode = String(body.mode ?? "listings");
    const cfgUrl = await getIntegrationKey(sb, "TOTEX_MARKETPLACE_API_URL");
    const base = (cfgUrl || DEFAULT_BASE).replace(/\/$/, "");

    if (mode === "dealerships") {
      const res = await fetch(`${base}/api/dealerships?limit=100`, { headers: { Accept: "application/json" } });
      if (!res.ok) return jsonRes({ error: `marketplace ${res.status}`, dealerships: [] }, 200);
      const data = await res.json();
      const list: Row[] = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      return jsonRes({
        dealerships: list
          .filter((d) => d.isActive !== false)
          .map((d) => ({ id: String(d.id), name: String(d.name ?? ""), vehicles: Number(d._count?.vehicles ?? 0) }))
          .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
      });
    }

    if (mode !== "listings") return jsonRes({ error: `modo desconhecido: ${mode}` }, 400);

    // Quem chamou? Cron (sem auth) = todos os tenants. UI = só o tenant do admin.
    const uiTenant = await callerTenant(sb, req);
    let q = sb.from("capture_handoff_config").select("tenant_id, marketplace_store_id, listing_sync_enabled, listing_last_sync_at");
    if (uiTenant) q = q.eq("tenant_id", uiTenant);
    else q = q.eq("listing_sync_enabled", true);
    const { data: cfgs, error } = await q;
    if (error) throw error;
    if (!cfgs || cfgs.length === 0) return jsonRes({ ok: true, tenants: 0, note: uiTenant ? "sem config de captação pra esse tenant" : "nenhum tenant com sync ligado" });

    const results: Row[] = [];
    for (const cfg of cfgs) {
      if (uiTenant && cfg.listing_last_sync_at && !body.force
        && Date.now() - new Date(cfg.listing_last_sync_at).getTime() < MIN_INTERVAL_MS) {
        results.push({ tenant_id: cfg.tenant_id, result: "sincronizado há menos de 1 minuto — aguarde" });
        continue;
      }
      const { data: map } = await sb.from("marketplace_store_mappings")
        .select("marketplace_store_id").eq("tenant_id", cfg.tenant_id).eq("active", true).maybeSingle();
      try {
        results.push(await syncTenant(sb, cfg, base, map?.marketplace_store_id ?? null));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[capture-listing-sync] tenant", cfg.tenant_id, msg);
        await sb.from("capture_handoff_config")
          .update({ listing_last_sync_at: new Date().toISOString(), listing_last_sync_result: `erro: ${msg}` })
          .eq("tenant_id", cfg.tenant_id);
        results.push({ tenant_id: cfg.tenant_id, error: msg });
      }
    }
    return jsonRes({ ok: true, tenants: results.length, results });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[capture-listing-sync]", msg);
    return jsonRes({ error: msg }, 500);
  }
});
