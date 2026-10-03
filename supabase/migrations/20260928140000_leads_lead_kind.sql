-- ============================================================================
-- SALA DE DEMO — Fase 1 (separação): marcador lead_kind (2026-09-28)
-- Recrutar franqueado NÃO se mistura com venda/captação de carro. O prospect de
-- recrutamento reaproveita a tabela `leads` (pra herdar as telas de lead), mas é
-- MARCADO como 'franchise' e será ESCONDIDO das telas de venda de carro
-- (Leads, Cockpit, Dashboards) — filtro aplicado no frontend na Fase 3.
--
-- Default 'car' = todo lead existente continua igual (venda/captação de carro).
-- 'franchise' = prospect de recrutamento de franqueado (mundo da sala de demo).
-- ============================================================================

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS lead_kind text NOT NULL DEFAULT 'car'
  CHECK (lead_kind IN ('car','franchise'));

-- Índice parcial: acelera as consultas do recrutamento (poucos leads 'franchise').
CREATE INDEX IF NOT EXISTS leads_lead_kind_franchise_idx
  ON public.leads(tenant_id, created_at DESC)
  WHERE lead_kind = 'franchise';

COMMENT ON COLUMN public.leads.lead_kind IS
  'car (padrão, venda/captação) | franchise (recrutamento de franqueado — escondido das telas de carro).';

-- Fase 3 (frontend) — esconder lead_kind='franchise' das telas de venda de carro:
--   • useSalesLeads (lista de Leads)      → filtrar lead_kind='car'
--   • Cockpit / fila                       → só deals do funil de carro (por pipeline)
--   • Dashboards comerciais                → excluir 'franchise' das contagens
-- E mostrar 'franchise' SÓ no mundo do recrutamento (pipeline Recrutamento de Franqueados).
