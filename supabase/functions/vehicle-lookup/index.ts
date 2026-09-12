import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

// CAPTAÇÃO — Consulta de veículo por placa (autopreenche o cadastro).
//
// Chamada pelo app com o JWT do usuário (verify_jwt = true). Provedor: PuxaPlaca
// (GET /v2/consulta/{placa}, header `token`); mantém o legado API Brasil (POST) se a
// URL configurada apontar pra lá. Token por tenant: PUXAPLACA_TOKEN (getIntegrationKey).
//
//   • cache por (tenant, placa) 30 dias — cada consulta ao provedor é cobrada
//   • limite diário por membro (promotora 20 / demais 100) — só bate no provedor além do cache
//   • promotora recebe só marca/modelo/ano/cor/combustível; chassi/Renavam só admin/comercial/closer
//   • avisa se a placa já foi captada por outro lead do tenant
//
// Nunca logar o token nem a resposta bruta do provedor.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const LOG = "[vehicle-lookup]";
const CACHE_DAYS = 30;
const DOC_ROLES = new Set(["admin", "comercial", "closer"]); // veem chassi/Renavam
const DAILY_LIMIT: Record<string, number> = { promotora: 20 };
const DEFAULT_DAILY_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 20_000;

interface Member { id: string; tenant_id: string; role: string; name: string | null }
interface Normalized {
  marca: string | null; modelo: string | null; ano_fabricacao: number | null; ano_modelo: number | null;
  cor: string | null; combustivel: string | null; chassi: string | null; renavam: string | null;
  municipio: string | null; uf: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Placa válida (antiga AAA9999 ou Mercosul AAA9A99), normalizada em MAIÚSCULAS sem separador. */
function normalizePlate(raw: unknown): string | null {
  const p = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(p) ? p : null;
}

// achata o JSON em pares chave->valor (chave minúscula, sem separadores) para busca tolerante
function flatten(obj: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v && typeof v === "object") flatten(v, out);
    else {
      const key = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (out[key] == null && v != null && v !== "") out[key] = v;
    }
  }
  return out;
}
function pick(flat: Record<string, unknown>, candidates: string[]): string | null {
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (flat[key] != null) return String(flat[key]);
  }
  return null;
}
const toInt = (v: string | null) => { const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10); return Number.isFinite(n) ? n : null; };
const titleCase = (s: string | null) => s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s;

function normalizeVehicle(data: unknown): Normalized {
  const flat = flatten(data);
  return {
    marca: titleCase(pick(flat, ["marca", "fabricante", "marcamodelo"])),
    modelo: titleCase(pick(flat, ["modelo", "submodelo", "versao", "marcamodelo"])),
    ano_fabricacao: toInt(pick(flat, ["anofabricacao", "ano", "anofab"])),
    ano_modelo: toInt(pick(flat, ["anomodelo", "anomod", "ano"])),
    cor: titleCase(pick(flat, ["cor", "corveiculo"])),
    combustivel: titleCase(pick(flat, ["combustivel", "tipocombustivel"])),
    chassi: pick(flat, ["chassi", "chassis"]),
    renavam: pick(flat, ["renavam"]),
    municipio: titleCase(pick(flat, ["municipio", "cidade"])),
    uf: pick(flat, ["uf", "estado"]),
  };
}

/** Remove chassi/Renavam pra quem não pode ver (promotora). */
function publicView(v: Normalized): Omit<Normalized, "chassi" | "renavam"> {
  const { chassi: _c, renavam: _r, ...rest } = v;
  return rest;
}

async function resolveMember(sb: SupabaseClient, user: { id: string; email?: string }): Promise<Member | null> {
  const cols = "id, tenant_id, role, name";
  if (user.email) {
    const { data } = await sb.from("team_members").select(cols)
      .eq("email", user.email).eq("is_active", true).order("created_at").limit(1).maybeSingle();
    if (data) return data as Member;
  }
  const { data } = await sb.from("team_members").select(cols)
    .eq("auth_user_id", user.id).eq("is_active", true).order("created_at").limit(1).maybeSingle();
  return (data as Member | null) ?? null;
}

async function alreadyCaptured(sb: SupabaseClient, tenantId: string, plate: string, excludeLead: string | null) {
  const { data, error } = await sb.rpc("seller_vehicle_by_plate", { p_tenant: tenantId, p_plate: plate, p_exclude_lead: excludeLead });
  if (error) { console.warn(LOG, "seller_vehicle_by_plate:", error.message); return null; }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    lead_id: (row as Record<string, unknown>).lead_id as string,
    lead_name: (row as Record<string, unknown>).lead_name as string | null,
    vehicle_status: (row as Record<string, unknown>).vehicle_status as string | null,
    promoter_name: (row as Record<string, unknown>).promoter_name as string | null,
    created_at: (row as Record<string, unknown>).created_at as string | null,
  };
}

async function fetchFromProvider(sb: SupabaseClient, tenantId: string, plate: string): Promise<{ vehicle: Normalized; raw: unknown }> {
  const token = await getIntegrationKey(sb, "PUXAPLACA_TOKEN", tenantId);
  if (!token) throw new HttpError(412, "Consulta de placa não configurada (Configurações > Integrações > PuxaPlaca)");
  const cfgUrl = (await getIntegrationKey(sb, "PUXAPLACA_URL", tenantId)) || "";
  const isLegacy = /apibrasil|gateway/i.test(cfgUrl);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    let data: unknown = {};
    if (isLegacy) {
      const url = cfgUrl || "https://gateway.apibrasil.io/api/v2/vehicles/dados";
      const res = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ placa: plate }),
      });
      data = await res.json().catch(() => ({}));
      console.log(LOG, "provedor apibrasil", res.status, `${Date.now() - t0}ms`);
      if (!res.ok) throw new HttpError(502, providerMessage(data, res.status));
    } else {
      const base = (/puxaplaca/i.test(cfgUrl) ? cfgUrl : "https://api.puxaplaca.app").replace(/\/+$/, "");
      const res = await fetch(`${base}/v2/consulta/${encodeURIComponent(plate)}`, {
        signal: ctrl.signal, headers: { token, Accept: "application/json" },
      });
      data = await res.json().catch(() => ({}));
      console.log(LOG, "provedor puxaplaca", res.status, `${Date.now() - t0}ms`);
      if (!res.ok) throw new HttpError(502, providerMessage(data, res.status));
    }
    return { vehicle: normalizeVehicle(data), raw: data };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error && err.name === "AbortError" ? "tempo esgotado" : (err instanceof Error ? err.message : String(err));
    throw new HttpError(502, `Provedor de placa indisponível: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

function providerMessage(data: unknown, status: number): string {
  const d = (data && typeof data === "object") ? data as Record<string, unknown> : {};
  const m = d.message ?? d.error ?? d.erro;
  if (status === 401 || status === 403) return "Token da consulta de placa inválido ou sem crédito";
  if (status === 404) return "Placa não encontrada na base do provedor";
  return typeof m === "string" && m ? m : `Provedor respondeu ${status}`;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return json({ error: "Função sem configuração do Supabase" }, 500);

  try {
    const auth = req.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) return json({ error: "Sem autenticação" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Sessão inválida ou expirada" }, 401);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const member = await resolveMember(sb, user);
    if (!member) return json({ error: "Membro do time não encontrado" }, 403);

    const body = await req.json().catch(() => ({})) as { placa?: unknown; lead_id?: unknown; force?: unknown };
    const plate = normalizePlate(body.placa);
    if (!plate) return json({ error: "Placa inválida. Use o padrão ABC1D23 ou ABC-1234." }, 400);
    const excludeLead = typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null;
    const canSeeDocs = DOC_ROLES.has(member.role);

    const captured = await alreadyCaptured(sb, member.tenant_id, plate, excludeLead);

    // 1) cache
    const { data: cacheRow } = await sb.from("vehicle_plate_lookups")
      .select("id, vehicle, found, fetched_at, hits").eq("tenant_id", member.tenant_id).eq("plate", plate).maybeSingle();
    const fresh = cacheRow && cacheRow.fetched_at &&
      (Date.now() - new Date(cacheRow.fetched_at as string).getTime()) < CACHE_DAYS * 86_400_000;

    if (fresh && body.force !== true) {
      await sb.from("vehicle_plate_lookups")
        .update({ hits: ((cacheRow!.hits as number) ?? 1) + 1, last_used_at: new Date().toISOString() })
        .eq("id", cacheRow!.id as string);
      const v = cacheRow!.vehicle as Normalized;
      return json({
        ok: true, plate, cached: true, found: cacheRow!.found as boolean,
        vehicle: canSeeDocs ? v : publicView(v), already_captured: captured,
      });
    }

    // 2) limite diário por membro (só antes de bater no provedor)
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await sb.from("vehicle_plate_lookups")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", member.tenant_id).eq("requested_by", member.id).gte("fetched_at", since);
    const limit = DAILY_LIMIT[member.role] ?? DEFAULT_DAILY_LIMIT;
    if ((count ?? 0) >= limit) {
      return json({ error: `Limite de ${limit} consultas de placa por dia atingido. Tente amanhã ou peça ao admin.` }, 429);
    }

    // 3) provedor + grava no cache
    const { vehicle, raw } = await fetchFromProvider(sb, member.tenant_id, plate);
    const found = Object.values(vehicle).some((x) => x != null);
    const { error: upErr } = await sb.from("vehicle_plate_lookups").upsert({
      tenant_id: member.tenant_id, plate, provider: "puxaplaca", vehicle, raw, found,
      requested_by: member.id, hits: 1, fetched_at: new Date().toISOString(), last_used_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,plate" });
    if (upErr) console.warn(LOG, "cache upsert:", upErr.message);

    console.log(LOG, `placa ${plate} consultada por ${member.role} ${member.id} — found=${found}`);
    return json({
      ok: true, plate, cached: false, found,
      vehicle: canSeeDocs ? vehicle : publicView(vehicle),
      warning: found ? undefined : "sem_dados_reconhecidos", already_captured: captured,
    });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG, "erro:", message);
    return json({ error: message }, 500);
  }
});
