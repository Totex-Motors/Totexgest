/**
 * FATOS DA LIGAÇÃO → CADASTRO (2026-10-14, pedido do Marco depois da ligação do Gabriel:
 * "ela não cadastrou o carro de interesse, nem o básico do perfil de compra, nem o carro
 * da troca"). Depois de cada ligação da Nina, a transcrição vira dados estruturados e
 * preenche os MESMOS campos que a tela usa:
 *  - Veículo de interesse → leads.metadata.vehicle / vehicles (+ veiculo_interesse_texto)
 *  - Perfil de compra → metadata.faixa_preco_min/max, precisa_financiar, tem_veiculo_troca,
 *    entrada_disponivel, forma_pagamento (BuyerProfileCard)
 *  - Veículo na troca → trade_in_vehicles (TradeInVehicleCard; linha mais nova do lead)
 *  - Instagram → leads.instagram (só se vazio)
 * Regra: só PREENCHE o que está vazio ou veio mais específico; nunca apaga o que a equipe
 * digitou. Aplica no lead e nos "irmãos" (mesmo telefone: lead da Totex + cópia da loja).
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { askClaudeJson } from "./claude-json.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export type CallFacts = {
  carro_interesse?: string | null;
  perfil?: {
    faixa_preco_min?: number | null; faixa_preco_max?: number | null;
    precisa_financiar?: boolean | null; tem_veiculo_troca?: boolean | null;
    entrada_disponivel?: number | null; forma_pagamento?: "a_vista" | "financiamento" | "consorcio" | "leasing" | null;
  } | null;
  carro_troca?: { marca?: string | null; modelo?: string | null; versao?: string | null; ano?: number | null; km?: number | null; placa?: string | null; valor_pedido?: number | null } | null;
  instagram?: string | null;
  nao_contatar?: boolean | null;
};

/** Leads do mesmo cliente (mesmo telefone) em qualquer loja: o da Totex + a cópia distribuída. */
export async function siblingLeads(sb: SupabaseClient, leadId: string): Promise<Array<{ id: string; tenant_id: string; metadata: Record<string, any>; instagram: string | null }>> {
  const { data: me } = await sb.from("leads").select("id, tenant_id, phone, metadata, instagram").eq("id", leadId).maybeSingle();
  if (!me) return [];
  const phone = String(me.phone || "").replace(/\D/g, "");
  if (phone.length < 10) return [me as any];
  const { data: all } = await sb.from("leads").select("id, tenant_id, phone, metadata, instagram")
    .or(`phone.eq.${phone},phone.eq.+${phone}`).order("created_at", { ascending: true }).limit(5);
  const list = (all || []) as any[];
  if (!list.find((l) => l.id === me.id)) list.unshift(me);
  return list.map((l) => ({ id: l.id, tenant_id: l.tenant_id, metadata: (l.metadata || {}) as Record<string, any>, instagram: l.instagram || null }));
}

export async function extractCallFacts(sb: SupabaseClient, tenantId: string | null, transcript: string, contexto: string): Promise<CallFacts | null> {
  if (!transcript || transcript.length < 40) return null;
  const system = [
    "Você lê a transcrição de uma ligação entre a Nina (atendente de uma rede de lojas de carros) e um cliente, e extrai SÓ o que o CLIENTE disse ou confirmou, em JSON.",
    "Nunca invente. Campo sem informação = null. Números em reais inteiros (R$ 120 mil → 120000). Km em número inteiro.",
    'Formato exato: {"carro_interesse": "marca modelo versão ano que ele quer COMPRAR/VER (ex.: Volkswagen Nivus Highline 2025) ou null",',
    '"perfil": {"faixa_preco_min": null, "faixa_preco_max": null, "precisa_financiar": true|false|null, "tem_veiculo_troca": true|false|null, "entrada_disponivel": null, "forma_pagamento": "a_vista"|"financiamento"|"consorcio"|"leasing"|null},',
    '"carro_troca": {"marca": null, "modelo": null, "versao": null, "ano": null, "km": null, "placa": null, "valor_pedido": null} ou null se ele não tem carro na troca,',
    '"instagram": "@usuario se ele disse o @ dele, senão null", "nao_contatar": true só se ele pediu pra não ligar mais, senão false}',
    "Se o cliente corrigiu uma informação (disse Golf e depois disse que é um Onix), vale a ÚLTIMA. Responda só o JSON.",
  ].join("\n");
  const user = `CONTEXTO DO CRM: ${contexto || "(nenhum)"}\n\nTRANSCRIÇÃO:\n${transcript.slice(0, 12000)}`;
  const j = await askClaudeJson(sb, tenantId, system, user, { maxTokens: 700, tag: "facts" });
  if (!j) return null;
  const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
  const str = (v: unknown, max = 120) => { const s = String(v ?? "").trim(); return s && s.toLowerCase() !== "null" ? s.slice(0, max) : null; };
  const p = (j.perfil || {}) as Record<string, unknown>;
  const t = (j.carro_troca || null) as Record<string, unknown> | null;
  const forma = (["a_vista", "financiamento", "consorcio", "leasing"].includes(String(p.forma_pagamento)) ? String(p.forma_pagamento) : null) as any;
  return {
    carro_interesse: str(j.carro_interesse),
    perfil: {
      faixa_preco_min: num(p.faixa_preco_min), faixa_preco_max: num(p.faixa_preco_max),
      precisa_financiar: bool(p.precisa_financiar), tem_veiculo_troca: bool(p.tem_veiculo_troca),
      entrada_disponivel: num(p.entrada_disponivel), forma_pagamento: forma,
    },
    carro_troca: t && (str(t.marca) || str(t.modelo)) ? { marca: str(t.marca, 40), modelo: str(t.modelo, 60), versao: str(t.versao, 60), ano: num(t.ano), km: num(t.km), placa: str(t.placa, 10)?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null, valor_pedido: num(t.valor_pedido) } : null,
    instagram: str(j.instagram, 60)?.replace(/^@+/, "").replace(/\s/g, "") || null,
    nao_contatar: bool(j.nao_contatar) || false,
  };
}

/** Procura o carro de interesse no estoque (consultar-estoque) e devolve no formato do VehicleOfInterestCard. */
async function findVehicleInStock(busca: string, tenantId?: string | null): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/consultar-estoque`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      body: JSON.stringify({ arguments: { busca, limite: 5, ...(tenantId ? { tenant_id: tenantId } : {}) }, session_id: null, user_id: null }),
    });
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j?.veiculos) ? j.veiculos : [];
    if (!list.length) return null;
    const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const toks = norm(busca).split(/\s+/).filter((t) => t.length >= 3 && !/^\d{4}$/.test(t));
    const scored = list.map((v: any) => ({ v, s: toks.filter((t) => norm(v.titulo).includes(t)).length }));
    scored.sort((a: any, b: any) => b.s - a.s);
    const best = scored[0];
    if (!best || best.s < Math.min(2, toks.length)) return null; // precisa bater marca+modelo (ou tudo, se só 1 token)
    const v = best.v;
    const parts = String(v.titulo || "").split(/\s+/);
    return {
      id: v.vehicle_id, description: v.titulo, brand: v.marca || parts[0] || null, model: v.modelo || parts[1] || null,
      year: v.ano ?? null, mileage: v.km ?? null, price_formatted: v.preco ?? null, store_name: v.loja ?? null, linked_by: "nina-voz",
    };
  } catch { return null; }
}

/** Grava os fatos no lead e nos irmãos. Devolve o que mudou (pra log/nota). */
export async function applyCallFacts(sb: SupabaseClient, leadId: string, facts: CallFacts, opts: { storeTenantId?: string | null } = {}): Promise<string[]> {
  const changed: string[] = [];
  const leads = await siblingLeads(sb, leadId);
  if (!leads.length) return changed;

  // carro de interesse → vínculo com o estoque (uma busca só, vale pra todos)
  let vehicle: Record<string, unknown> | null = null;
  if (facts.carro_interesse) vehicle = await findVehicleInStock(facts.carro_interesse, opts.storeTenantId || null);

  for (const l of leads) {
    const md = { ...l.metadata };
    const patch: Record<string, unknown> = {};
    let touched = false;

    if (facts.carro_interesse) {
      // a ligação é o dado mais recente: se ele mudou de carro (Toro → Nivus), vale o novo;
      // o anterior continua em metadata.vehicles.
      const atual = String(md.veiculo_interesse_texto || "").toLowerCase();
      const novo = facts.carro_interesse.toLowerCase();
      if (!atual || (!atual.includes(novo) && !novo.includes(atual))) {
        md.veiculo_interesse_texto = facts.carro_interesse; touched = true; changed.push(`interesse=${facts.carro_interesse}`);
      }
      if (vehicle && (!md.vehicle || String(md.vehicle?.id || "") !== String(vehicle.id))) {
        const list = Array.isArray(md.vehicles) ? md.vehicles.filter((v: any) => String(v?.id || "") !== String(vehicle!.id)) : (md.vehicle ? [md.vehicle] : []);
        md.vehicle = vehicle; md.vehicles = [vehicle, ...list].slice(0, 5); touched = true; changed.push(`vehicle=${vehicle.description}`);
      }
    }
    const p = facts.perfil || {};
    for (const k of ["faixa_preco_min", "faixa_preco_max", "precisa_financiar", "tem_veiculo_troca", "entrada_disponivel", "forma_pagamento"] as const) {
      const v = (p as any)[k];
      if (v === null || v === undefined) continue;
      if (md[k] === null || md[k] === undefined || md[k] === "") { md[k] = v; touched = true; changed.push(`${k}=${v}`); }
    }
    if (facts.carro_troca && md.tem_veiculo_troca !== true) { md.tem_veiculo_troca = true; touched = true; }
    if (facts.nao_contatar) { md.nao_contatar = true; md.nao_contatar_em = new Date().toISOString(); touched = true; changed.push("nao_contatar"); }
    if (touched) patch.metadata = md;
    if (facts.instagram && !l.instagram) { patch.instagram = "@" + facts.instagram; changed.push(`instagram=@${facts.instagram}`); }
    if (Object.keys(patch).length) {
      const { error } = await sb.from("leads").update(patch).eq("id", l.id);
      if (error) console.warn("[call-facts] lead", l.id, error.message);
    }

    // carro na troca → trade_in_vehicles (linha mais nova do lead; só preenche vazio)
    const t = facts.carro_troca;
    if (t) {
      const { data: row } = await sb.from("trade_in_vehicles").select("id, marca, modelo, versao, ano, km, placa, valor_pedido")
        .eq("lead_id", l.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const up: Record<string, unknown> = {};
      const fill = (k: keyof typeof t, cur: unknown) => { if (t[k] !== null && t[k] !== undefined && (cur === null || cur === undefined || cur === "")) up[k] = t[k]; };
      if (row) {
        fill("marca", row.marca); fill("modelo", row.modelo); fill("versao", row.versao); fill("ano", row.ano); fill("km", row.km); fill("placa", row.placa); fill("valor_pedido", row.valor_pedido);
        // modelo diferente do que está lá (ele corrigiu "Golf" → "Onix") → atualiza marca/modelo/versão/ano/km
        if (t.modelo && row.modelo && t.modelo.toLowerCase() !== String(row.modelo).toLowerCase()) { up.marca = t.marca; up.modelo = t.modelo; up.versao = t.versao; up.ano = t.ano; up.km = t.km; }
        if (Object.keys(up).length) {
          const { error } = await sb.from("trade_in_vehicles").update({ ...up, observacoes: "Atualizado pela Nina (ligação)" }).eq("id", row.id);
          if (!error) changed.push(`troca=${[up.marca || row.marca, up.modelo || row.modelo].filter(Boolean).join(" ")}`);
        }
      } else {
        const { error } = await sb.from("trade_in_vehicles").insert({
          tenant_id: l.tenant_id, lead_id: l.id, modalidade: "troca", marca: t.marca, modelo: t.modelo, versao: t.versao, ano: t.ano, km: t.km, placa: t.placa, valor_pedido: t.valor_pedido,
          observacoes: "Informado na ligação com a Nina",
        });
        if (error) console.warn("[call-facts] trade_in", l.id, error.message); else changed.push(`troca=${[t.marca, t.modelo].filter(Boolean).join(" ")}`);
      }
    }
  }
  return [...new Set(changed)];
}
