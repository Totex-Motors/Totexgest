-- =============================================================================
-- VEÍCULO NA TROCA (TRADE-IN) — T3 Customização Automotiva
-- Tabela dedicada: permite histórico por lead/deal e relatórios futuros.
-- Valor avaliado é manual (vendedor digita); FIPE fica para T4.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.trade_in_vehicles (
    id              uuid    DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id       uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    lead_id         uuid    REFERENCES public.leads(id) ON DELETE SET NULL,
    deal_id         uuid    REFERENCES public.deals(id) ON DELETE SET NULL,
    marca           text,
    modelo          text,
    versao          text,
    ano             integer,
    km              integer,
    placa           text,
    -- otimo | bom | regular | ruim
    condicao        text    CHECK (condicao IN ('otimo', 'bom', 'regular', 'ruim')),
    valor_pedido    numeric(12,2),
    valor_avaliado  numeric(12,2),
    observacoes     text,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_in_lead_id   ON public.trade_in_vehicles (lead_id);
CREATE INDEX IF NOT EXISTS idx_trade_in_deal_id   ON public.trade_in_vehicles (deal_id);
CREATE INDEX IF NOT EXISTS idx_trade_in_tenant_id ON public.trade_in_vehicles (tenant_id);

ALTER TABLE public.trade_in_vehicles ENABLE ROW LEVEL SECURITY;

-- Membros do tenant fazem CRUD no próprio tenant; super-admin faz tudo
DO $$ BEGIN
  CREATE POLICY "trade_in_tenant_crud" ON public.trade_in_vehicles
    FOR ALL TO authenticated
    USING  (public.is_superadmin() OR tenant_id = public.get_tenant_id())
    WITH CHECK (public.is_superadmin() OR tenant_id = public.get_tenant_id());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Super-admin read cross-tenant (padrão 20260613)
DO $$ BEGIN
  CREATE POLICY "trade_in_vehicles_superadmin_read" ON public.trade_in_vehicles
    FOR SELECT TO authenticated
    USING (public.is_superadmin());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Trigger para atualizar updated_at
CREATE OR REPLACE FUNCTION public.set_trade_in_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_trade_in_updated_at ON public.trade_in_vehicles;
CREATE TRIGGER trg_trade_in_updated_at
  BEFORE UPDATE ON public.trade_in_vehicles
  FOR EACH ROW EXECUTE FUNCTION public.set_trade_in_updated_at();
