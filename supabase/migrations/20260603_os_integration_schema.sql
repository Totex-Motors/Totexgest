-- Integração TotexMotors OS ↔ CRM: schema delta (seção 4.1 do INTEGRATIONAIFIRST.md)

-- 1. Campos no tenants para linkar ao lojista do OS
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS external_dealership_id UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS external_source        TEXT DEFAULT 'totex_os',
  ADD COLUMN IF NOT EXISTS metadata               JSONB DEFAULT '{}'::JSONB;

CREATE INDEX IF NOT EXISTS tenants_external_dealership_idx
  ON public.tenants(external_dealership_id);

-- 2. Campos nos leads para rastrear origem e transferências
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS external_source_id       TEXT,
  ADD COLUMN IF NOT EXISTS transferred_from_tenant  UUID;

-- 3. Fila de eventos a sincronizar com o OS (auditoria + idempotência + retry)
CREATE TABLE IF NOT EXISTS public.os_sync_events (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type        TEXT        NOT NULL,
  tenant_id         UUID        REFERENCES public.tenants(id) ON DELETE SET NULL,
  external_event_id TEXT        UNIQUE,
  payload           JSONB       NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  attempts          INT         NOT NULL DEFAULT 0,
  last_error        TEXT,
  processed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS os_sync_events_status_idx  ON public.os_sync_events(status);
CREATE INDEX IF NOT EXISTS os_sync_events_created_idx ON public.os_sync_events(created_at DESC);

ALTER TABLE public.os_sync_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "os_sync_service_only" ON public.os_sync_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Trigger: deal ganho → enfileira evento para o OS
CREATE OR REPLACE FUNCTION public.fn_enqueue_deal_won()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.won_at IS NOT NULL AND OLD.won_at IS NULL THEN
    INSERT INTO public.os_sync_events (
      event_type, tenant_id, external_event_id, payload
    ) VALUES (
      'deal_won',
      NEW.tenant_id,
      'deal_won_' || NEW.id::text,
      jsonb_build_object(
        'deal_id',          NEW.id,
        'tenant_id',        NEW.tenant_id,
        'lead_id',          NEW.lead_id,
        'title',            NEW.title,
        'negotiated_price', COALESCE(NEW.negotiated_price, 0),
        'won_at',           NEW.won_at
      )
    )
    ON CONFLICT (external_event_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_won ON public.deals;
CREATE TRIGGER trg_deal_won
  AFTER UPDATE ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.fn_enqueue_deal_won();
