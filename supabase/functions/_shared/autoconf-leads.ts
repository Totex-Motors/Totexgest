// LEADS → CRM DO AUTOCONF (lojas parceiras Autoconf; decisão do Marco 09/11/2026).
//
// Lojista Autoconf NÃO usa o Totexgest: o estoque dele aparece no marketplace/stand e os leads
// caem direto no CRM do Autoconf. Este módulo:
//   • acha a loja Autoconf de um carro/loja (autoconf_stores: pelo id da loja no marketplace ou nome);
//   • manda o lead em JSON POST pro destino dela — URL própria (lead_webhook_url) ou a URL global do
//     Autoconf (config AUTOCONF_LEADS_URL) com ?store_id=; token opcional (config AUTOCONF_LEADS_TOKEN,
//     header Authorization: Bearer);
//   • registra cada entrega em autoconf_lead_deliveries (status, HTTP, erro) pra auditoria/reenvio.
// Formato: o MESMO do marketplace (evento INTERESSE_VEICULO, cliente/veiculo/loja) + `qualificacao`
// da Nina — o Autoconf já recebe esse contrato dos leads do site.
import { getIntegrationKey } from "./config.ts";

export interface LojaAutoconf {
  store_id: string; name: string; marketplace_dealership_id: string | null; lead_webhook_url: string | null;
  email: string | null; phone: string | null; whatsapp: string | null; address: Record<string, unknown> | null;
}

export async function acharLojaAutoconf(
  supabase: any, opts: { marketplaceDealershipId?: string | null; nome?: string | null },
): Promise<LojaAutoconf | null> {
  const cols = "store_id, name, marketplace_dealership_id, lead_webhook_url, email, phone, whatsapp, address";
  if (opts.marketplaceDealershipId) {
    const { data } = await supabase.from("autoconf_stores").select(cols)
      .eq("marketplace_dealership_id", String(opts.marketplaceDealershipId)).eq("status", "ativo").maybeSingle();
    if (data) return data as LojaAutoconf;
  }
  const nome = String(opts.nome || "").trim();
  if (nome.length >= 3) {
    const { data } = await supabase.from("autoconf_stores").select(cols).eq("status", "ativo").ilike("name", nome).limit(1);
    if (data?.[0]) return data[0] as LojaAutoconf;
  }
  return null;
}

async function destino(supabase: any, loja: LojaAutoconf): Promise<string | null> {
  if (loja.lead_webhook_url && /^https:\/\//i.test(loja.lead_webhook_url)) return loja.lead_webhook_url;
  const global = String((await getIntegrationKey(supabase, "AUTOCONF_LEADS_URL")) || "").trim();
  if (!/^https:\/\//i.test(global)) return null;
  return `${global}${global.includes("?") ? "&" : "?"}store_id=${encodeURIComponent(loja.store_id)}`;
}

export interface LeadParaAutoconf {
  leadId: string | null;
  cliente: { nome: string; telefone: string; email?: string | null; mensagem?: string | null };
  veiculo?: { id?: string | null; marca?: string | null; modelo?: string | null; versao?: string | null; ano?: number | null; quilometragem?: number | null; preco?: number | null; precoFormatado?: string | null; descricao?: string | null } | null;
  qualificacao?: Record<string, unknown> | null;
  origem: "STAND_TOTEX" | "NINA_WHATSAPP" | string;
}

/** Entrega o lead no CRM do Autoconf. Nunca lança: devolve { ok, status, erro }. */
export async function enviarLeadAutoconf(supabase: any, loja: LojaAutoconf, lead: LeadParaAutoconf): Promise<{ ok: boolean; http: number | null; erro: string | null; url: string | null }> {
  const url = await destino(supabase, loja);
  const v = lead.veiculo || {};
  const payload = {
    evento: "INTERESSE_VEICULO",
    origem: lead.origem,
    leadId: lead.leadId,
    timestamp: new Date().toISOString(),
    cliente: { nome: lead.cliente.nome, email: lead.cliente.email || "", telefone: lead.cliente.telefone, mensagem: lead.cliente.mensagem || "" },
    veiculo: {
      id: v.id ?? null, marca: v.marca ?? null, modelo: v.modelo ?? null, versao: v.versao ?? null, ano: v.ano ?? null,
      quilometragem: v.quilometragem ?? null, preco: v.preco ?? null, precoFormatado: v.precoFormatado ?? null, placa: null,
      descricao: v.descricao ?? null,
    },
    loja: {
      id: loja.marketplace_dealership_id, autoconfStoreId: loja.store_id, nome: loja.name,
      email: loja.email || "", telefone: loja.whatsapp || loja.phone || "",
      cidade: (loja.address as any)?.city || "", estado: (loja.address as any)?.state || "", endereco: "",
    },
    qualificacao: lead.qualificacao || null,
  };
  let http: number | null = null; let erro: string | null = null;
  if (!url) {
    erro = "loja sem destino de leads (lead_webhook_url / AUTOCONF_LEADS_URL)";
  } else {
    try {
      const token = String((await getIntegrationKey(supabase, "AUTOCONF_LEADS_TOKEN")) || "").trim();
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      http = r.status;
      if (!r.ok) erro = `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`;
    } catch (e) {
      erro = (e as Error).message;
    }
  }
  const ok = !erro;
  await supabase.from("autoconf_lead_deliveries").insert({
    store_id: loja.store_id, lead_id: lead.leadId, origem: lead.origem, url, status: ok ? "entregue" : (url ? "falhou" : "sem_destino"),
    http_status: http, erro, payload,
  }).then(() => null, (e: Error) => console.error("[autoconf-leads] log:", e.message));
  return { ok, http, erro, url };
}
