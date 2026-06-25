-- =====================================================================
-- Correção: leads dos canais externos não entravam no Pipeline.
--
--   Causa 1 (Totem): o stand-handoff insere o lead na loja dona com
--     utm_source = 'stand_totex', mas o trigger só aceitava
--     ('credere','marketplace','stand') -> esse lead nunca virava deal.
--   Causa 2 (geral): leads antigos sem deal (backfill anterior pulou
--     tenants que ainda não tinham pipeline configurado).
--
-- Esta migration:
--   1) Amplia o trigger para aceitar qualquer canal 'stand%'
--      (stand, stand_totex) além de credere/marketplace.
--   2) Reexecuta o backfill (idempotente) com a regra ampliada.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.auto_create_deal_for_channel_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tid uuid := NEW.tenant_id;
  v_channel text := lower(coalesce(NEW.source, NEW.utm_source, ''));
  v_pipeline_id uuid;
  v_default_sales_rep_id uuid;
  v_stage_id uuid;
BEGIN
  -- Canais externos que NÃO criam deal por conta própria.
  -- 'stand%' cobre 'stand' (intake no tenant do stand) e
  -- 'stand_totex' (handoff para a loja dona).
  IF NOT (v_channel IN ('credere', 'marketplace') OR v_channel LIKE 'stand%') THEN
    RETURN NEW;
  END IF;

  IF v_tid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
  FROM sales_pipelines
  WHERE tenant_id = v_tid AND is_default = true AND is_active = true
  ORDER BY position
  LIMIT 1;

  IF v_pipeline_id IS NULL THEN
    SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
    FROM sales_pipelines
    WHERE tenant_id = v_tid AND is_active = true
    ORDER BY is_default DESC, position
    LIMIT 1;
  END IF;

  IF v_pipeline_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_stage_id
  FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND tenant_id = v_tid
    AND is_won = false AND is_lost = false
  ORDER BY position
  LIMIT 1;

  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM deals WHERE lead_id = NEW.id AND tenant_id = v_tid) THEN
    RETURN NEW;
  END IF;

  INSERT INTO deals (
    lead_id, pipeline_id, pipeline_stage_id, sales_rep_id,
    negotiated_price, status, notes, created_at, tenant_id
  ) VALUES (
    NEW.id, v_pipeline_id, v_stage_id, v_default_sales_rep_id,
    0, 'open',
    'Criado automaticamente a partir do canal: ' || v_channel,
    NOW(), v_tid
  );

  UPDATE leads
  SET pipeline_stage_id = v_stage_id,
      sales_rep_id = COALESCE(sales_rep_id, v_default_sales_rep_id),
      updated_at = NOW()
  WHERE id = NEW.id AND tenant_id = v_tid;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_create_deal_for_channel_lead ON public.leads;

CREATE TRIGGER trg_auto_create_deal_for_channel_lead
AFTER INSERT ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.auto_create_deal_for_channel_lead();

-- ---------------------------------------------------------------------
-- Backfill ampliado: cria deals para leads de canal já existentes
-- (credere / marketplace / stand%) que ainda não têm deal.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_pipeline_id uuid;
  v_default_sales_rep_id uuid;
  v_stage_id uuid;
BEGIN
  FOR r IN
    SELECT l.id, l.tenant_id,
           lower(coalesce(l.source, l.utm_source, '')) AS channel
    FROM leads l
    WHERE (lower(coalesce(l.source, l.utm_source, '')) IN ('credere', 'marketplace')
           OR lower(coalesce(l.source, l.utm_source, '')) LIKE 'stand%')
      AND l.tenant_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.tenant_id = l.tenant_id
      )
  LOOP
    SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
    FROM sales_pipelines
    WHERE tenant_id = r.tenant_id AND is_default = true AND is_active = true
    ORDER BY position
    LIMIT 1;

    IF v_pipeline_id IS NULL THEN
      SELECT id, default_sales_rep_id INTO v_pipeline_id, v_default_sales_rep_id
      FROM sales_pipelines
      WHERE tenant_id = r.tenant_id AND is_active = true
      ORDER BY is_default DESC, position
      LIMIT 1;
    END IF;

    IF v_pipeline_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT id INTO v_stage_id
    FROM sales_pipeline_stages
    WHERE pipeline_id = v_pipeline_id AND tenant_id = r.tenant_id
      AND is_won = false AND is_lost = false
    ORDER BY position
    LIMIT 1;

    IF v_stage_id IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO deals (
      lead_id, pipeline_id, pipeline_stage_id, sales_rep_id,
      negotiated_price, status, notes, created_at, tenant_id
    ) VALUES (
      r.id, v_pipeline_id, v_stage_id, v_default_sales_rep_id,
      0, 'open',
      'Backfill: importado do canal ' || r.channel,
      NOW(), r.tenant_id
    );

    UPDATE leads
    SET pipeline_stage_id = v_stage_id,
        sales_rep_id = COALESCE(sales_rep_id, v_default_sales_rep_id),
        updated_at = NOW()
    WHERE id = r.id AND tenant_id = r.tenant_id;
  END LOOP;
END $$;
