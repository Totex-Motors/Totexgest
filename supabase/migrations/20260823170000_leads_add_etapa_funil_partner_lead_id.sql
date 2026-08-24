-- Drift de schema: o frontend (funil, workspace, merge, mudança de etapa) e o
-- trigger sync_partner_pipeline_stage esperam estas colunas em leads, mas elas
-- não existiam neste banco. Faltando 'partner_lead_id', o trigger que dispara ao
-- mudar de etapa acessava NEW.partner_lead_id e QUEBRAVA toda mudança manual de
-- etapa ("Erro ao atualizar estágio"). Faltando 'etapa_funil', várias telas de
-- funil/merge davam erro de coluna inexistente.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS partner_lead_id uuid;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS etapa_funil text;

CREATE INDEX IF NOT EXISTS idx_leads_partner_lead_id
  ON public.leads(partner_lead_id) WHERE partner_lead_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
