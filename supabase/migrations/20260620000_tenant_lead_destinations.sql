-- Destinos de repasse de lead por loja (tenant).
-- Onde o agente do stand "solta" o lead qualificado de cada loja dona.
-- Gerenciado SÓ pelo super-admin (Totex) via /configuracoes > Super Admin.
-- Lido cross-tenant pela edge fn stand-handoff (service_role bypassa RLS).

CREATE TABLE IF NOT EXISTS public.tenant_lead_destinations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  destination_type TEXT        NOT NULL DEFAULT 'number'
                                 CHECK (destination_type IN ('number', 'group')),
  whatsapp_target  TEXT        NOT NULL,   -- número (5511...) ou JID do grupo (...@g.us)
  label            TEXT,
  active           BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v1: 1 destino por loja. (Trocar p/ índice composto se for permitir vários depois.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_lead_destinations_tenant
  ON public.tenant_lead_destinations(tenant_id);

ALTER TABLE public.tenant_lead_destinations ENABLE ROW LEVEL SECURITY;

-- Super-admin enxerga/edita tudo (gestão central). Demais: ninguém via RLS —
-- o agente lê via service_role (bypassa RLS).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='tenant_lead_destinations'
       AND policyname='tld_superadmin_all'
  ) THEN
    CREATE POLICY tld_superadmin_all ON public.tenant_lead_destinations
      FOR ALL TO authenticated
      USING (public.is_superadmin())
      WITH CHECK (public.is_superadmin());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.update_tenant_lead_destinations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tld_updated_at ON public.tenant_lead_destinations;
CREATE TRIGGER trg_tld_updated_at
  BEFORE UPDATE ON public.tenant_lead_destinations
  FOR EACH ROW EXECUTE FUNCTION public.update_tenant_lead_destinations_updated_at();

COMMENT ON TABLE public.tenant_lead_destinations IS
  'WhatsApp de destino p/ repasse de lead qualificado por loja. Gerenciado pelo super-admin; lido pela edge fn stand-handoff.';
