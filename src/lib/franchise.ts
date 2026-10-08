/**
 * Franqueados — recrutamento de lojista/franqueado (lead_kind = 'franchise').
 *
 * O funil é um pipeline PRÓPRIO ("Recrutamento de Franqueados"), separado do funil
 * de venda de carro. No HQ (Totex Motors) ele tem UUID fixo (migration
 * 20261009120000_funil_franqueados.sql); em outra loja é reconhecido pelo nome.
 * O banco (franchise_recruitment_pipeline) usa a MESMA regra — manter em sincronia.
 */
export const FRANCHISE_PIPELINE_ID = "fdec0000-0000-4000-a000-000000000000";
export const FRANCHISE_PIPELINE_NAME = "Recrutamento de Franqueados";

export function isFranchisePipeline(
  p: { id?: string | null; name?: string | null } | null | undefined,
): boolean {
  if (!p) return false;
  if (p.id === FRANCHISE_PIPELINE_ID) return true;
  return (p.name || "").trim().toLowerCase() === FRANCHISE_PIPELINE_NAME.toLowerCase();
}

export function isFranchiseLead(
  lead: { lead_kind?: string | null } | null | undefined,
): boolean {
  return lead?.lead_kind === "franchise";
}
