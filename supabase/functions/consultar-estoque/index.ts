/**
 * consultar-estoque — consulta o estoque conjunto do Totex Motors marketplace.
 *
 * Tool do agente do stand (action_type=edge_function, name=consultar-estoque).
 * Chamada pelo agent-runner com body { arguments, user_id, session_id }.
 *
 * Usa a API PÚBLICA do marketplace (GET /api/vehicles) — sem auth. Cada veículo já
 * traz a loja dona aninhada (dealership.name), então o agente consegue desambiguar
 * "tive interesse no Palio" mostrando as opções reais (loja, ano, preço, cidade) e
 * depois repassar o lead pra loja certa pelo NOME (matchLojaByName no stand-handoff).
 *
 * Base URL configurável via config.TOTEX_MARKETPLACE_API_URL (fallback p/ totexmotors.com).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";
import { getTenantIdFromRequest } from "../_shared/tenant.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const DEFAULT_BASE = "https://totexmotors.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function brl(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

const norm = (s: string) =>
  String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * A API do marketplace casa por SUBSTRING (ex: search=gol traz "Golf"). Aqui exigimos que
 * cada palavra (>=3 letras) do que o cliente pediu apareça como PALAVRA INTEIRA no título —
 * "gol" casa "Gol" mas não "Golf". Tokens não-alfabéticos (ex: "1.6") são ignorados no filtro.
 */
function matchesQuery(titulo: string, termo: string): boolean {
  const tokens = norm(termo).split(/\s+/).filter((t) => /^[a-z]{3,}$/.test(t));
  if (tokens.length === 0) return true;
  const t = norm(titulo);
  return tokens.every((tok) => new RegExp(`\\b${tok}\\b`).test(t));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();
    const args = (body.arguments || {}) as Record<string, unknown>;

    const busca = String(args.busca ?? args.search ?? "").trim();
    const marca = String(args.marca ?? "").trim();
    const modelo = String(args.modelo ?? "").trim();
    const cidade = String(args.cidade ?? "").trim();
    const estado = String(args.estado ?? "").trim();
    const precoMax = Number(args.preco_max ?? args.precoMax ?? 0);
    const limite = Math.min(Math.max(Number(args.limite ?? 6) || 6, 1), 24);
    // formato=completo: payload cru pro CRM (fotos, link, preço numérico) —
    // usado pelo "Inserir veículo do estoque" do editor de templates de email.
    // O formato default (resumido) continua sendo o do agente.
    const formato = String(args.formato ?? "").trim();

    if (!busca && !marca && !modelo) {
      return json({ error: "Informe ao menos 'busca', 'marca' ou 'modelo'." }, 400);
    }

    // Base URL do marketplace (configurável — sem hardcode rígido)
    const cfgUrl = await getIntegrationKey(supabase, "TOTEX_MARKETPLACE_API_URL");
    const base = (cfgUrl || DEFAULT_BASE).replace(/\/$/, "");

    // Escopo por loja (multi-tenant): se o chamador é um usuário do CRM cuja
    // loja tem mapping no marketplace, filtra o estoque pra ela. Chamadas do
    // agente (service key, sem tenant no JWT) e tenants sem mapping (Stand,
    // porta única) veem o estoque CONJUNTO — comportamento intencional.
    const callerTenant = getTenantIdFromRequest(req);
    let dealershipId: string | null = null;
    if (callerTenant) {
      const { data: mapping } = await supabase
        .from("marketplace_store_mappings")
        .select("marketplace_store_id")
        .eq("tenant_id", callerTenant)
        .eq("active", true)
        .maybeSingle();
      dealershipId = mapping?.marketplace_store_id ?? null;
    }

    const qs = new URLSearchParams();
    if (busca) qs.set("search", busca);
    if (marca) qs.set("brand", marca);
    if (modelo) qs.set("model", modelo);
    if (cidade) qs.set("city", cidade);
    if (estado) qs.set("state", estado);
    if (precoMax > 0) qs.set("maxPrice", String(precoMax));
    if (dealershipId) qs.set("dealershipId", dealershipId);
    qs.set("limit", String(limite));
    qs.set("sort", "price_asc");

    const url = `${base}/api/vehicles?${qs.toString()}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`[consultar-estoque] ${res.status} em ${url}`);
      return json({ error: `Estoque indisponível (${res.status}).`, veiculos: [], total: 0 }, 200);
    }
    const data = await res.json();
    const list: any[] = Array.isArray(data?.data) ? data.data : [];

    if (formato === "completo") {
      // Browse humano: matching por substring da API é o desejado (busca parcial),
      // então NÃO aplicamos o filtro de palavra inteira do agente.
      const completos = list.map((v) => ({
        id: String(v.id),
        title: [v.brand, v.model, v.version].filter(Boolean).join(" "),
        year: v.year ?? null,
        price: Number.isFinite(Number(v.price)) ? Number(v.price) : null,
        mileage: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null,
        color: v.color ?? null,
        fuel: v.fuel ?? null,
        transmission: v.transmission ?? null,
        city: v.city ?? null,
        state: v.state ?? null,
        dealership: v.dealership?.name ?? null,
        images: Array.isArray(v.images)
          ? [...v.images]
              .sort((a, b) => (b?.isPrimary ? 1 : 0) - (a?.isPrimary ? 1 : 0) || (a?.order ?? 0) - (b?.order ?? 0))
              .map((i) => i?.url)
              .filter(Boolean)
          : [],
        url: `${base}/veiculo/${v.id}`,
      }));
      return json({
        total: Number(data?.total) || completos.length, // total REAL no marketplace
        mostrando: completos.length,
        veiculos: completos,
      });
    }

    const veiculos = list.map((v) => ({
      vehicle_id: v.id,
      titulo: [v.brand, v.model, v.version].filter(Boolean).join(" "),
      ano: v.year ?? null,
      preco: brl(v.price),
      km: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null,
      cor: v.color ?? null,
      cambio: v.transmission ?? null,
      combustivel: v.fuel ?? null,
      cidade: v.city ?? null,
      estado: v.state ?? null,
      loja: v.dealership?.name ?? null,
      loja_telefone: v.dealership?.phone ?? null,
    }));

    // Refina pelo termo pedido (palavra inteira) — evita "Golf" quando pediram "Gol".
    const termo = modelo || busca;
    const filtrados = termo ? veiculos.filter((v) => matchesQuery(v.titulo, termo)) : veiculos;

    // Se o filtro zerou (a API só trouxe parecidos, não o modelo pedido), retorna vazio
    // de propósito — o agente avisa que não tem esse modelo agora, sem empurrar outro.
    const semExato = termo && veiculos.length > 0 && filtrados.length === 0;

    return json({
      total: filtrados.length,
      mostrando: filtrados.length,
      veiculos: filtrados,
      observacao: semExato
        ? `Não há "${termo}" no estoque agora (a busca só trouxe modelos de nome parecido). Ofereça buscar outro modelo ou avisar quando chegar.`
        : (data?.total ?? 0) > veiculos.length
          ? "Há mais resultados; refine por ano, faixa de preço ou cidade."
          : null,
    });
  } catch (err) {
    console.error("[consultar-estoque] error:", (err as Error).message);
    return json({ error: (err as Error).message, veiculos: [], total: 0 }, 200);
  }
});
