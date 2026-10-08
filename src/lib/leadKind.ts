/**
 * Tipo de pessoa do lead (passo 3 — docs/ENTRADAS-DE-LEADS.md §3.1) e origem legível.
 *
 * lead_kind (coluna em leads):
 *   seller    = quer VENDER/trocar o carro (captação / intermediação)
 *   buyer     = quer COMPRAR (totem, site, WhatsApp da loja, stand, Credere…)
 *   franchise = lojista/franqueado (recrutamento, sala de demo)
 *   contact   = decisor/sócio/indicação — não é lead, só contato de um lead
 */
export type LeadKind = "seller" | "buyer" | "franchise" | "contact";

export const LEAD_KIND_LABEL: Record<LeadKind, string> = {
  seller: "Vendedor",
  buyer: "Comprador",
  franchise: "Franqueado",
  contact: "Contato",
};

export const LEAD_KIND_CLASS: Record<LeadKind, string> = {
  seller: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  buyer: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-900",
  franchise: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  contact: "bg-muted text-muted-foreground border-border",
};

/** Lead de captação (vendedor) — com fallback pra base ainda sem lead_kind. */
export function isSellerLead(lead: { lead_kind?: string | null; captured_by_member_id?: string | null } | null | undefined): boolean {
  if (!lead) return false;
  return lead.lead_kind === "seller" || !!lead.captured_by_member_id;
}

/**
 * Origem em palavra que pessoa comum entende (docs/ENTRADAS-DE-LEADS.md §3.4).
 * Hoje `source`/`utm_source` guardam ~25 valores técnicos; aqui vira uma lista curta.
 * Só EXIBIÇÃO — não altera o que está gravado.
 */
export function leadSourceLabel(source?: string | null, utm?: string | null): string {
  const s = (source || "").trim().toLowerCase();
  const u = (utm || "").trim().toLowerCase();
  const v = s || u;
  if (!v) return "Origem não informada";
  if (v === "captacao" || v === "promotora" || u === "promotora" || v === "stand-vinculo") return "Promotora";
  if (v.startsWith("totem")) return "Totem";
  if (v === "credere") return "Financiamento (Credere)";
  if (v === "marketplace" || u === "site_marketplace" || u === "stand_shopping") return "Site / Marketplace";
  if (v === "whatsapp" || v === "distribuicao") return "WhatsApp";
  if (v.startsWith("stand")) return "Stand";
  if (v === "indicacao" || u === "indicacao" || u === "lojista_parceiro") return "Indicação";
  if (v === "import_csv" || v === "importacao") return "Importação";
  if (v.startsWith("meta lead ads") || u === "facebook" || u === "instagram" || v === "instagram" || u.startsWith("instagram")) return "Anúncio (Meta)";
  if (v.includes("franquia") || v.includes("franchise") || u === "prospeccao_franqueado") return "Franquia";
  if (v === "manual") return "Manual";
  if (v === "api" || s.includes("rd") || v.includes("form") || v.includes("site") || v.includes("elementor")) return "Site / Formulário";
  return source || utm || "—";
}
