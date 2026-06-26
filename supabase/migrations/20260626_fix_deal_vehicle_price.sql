-- Corrige o trigger auto_create_deal_for_channel_lead para extrair o valor do
-- veículo do metadata do lead e gravá-lo em negotiated_price.
-- Canais suportados:
--   credere    → metadata->'vehicle'->>'assets_value' (em reais, já convertido pelo webhook)
--   marketplace → metadata->'vehicle'->>'price'
--   stand       → metadata->'vehicle'->>'price'

CREATE OR REPLACE FUNCTION public.auto_create_deal_for_channel_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tid                  uuid := NEW.tenant_id;
  v_channel              text := lower(coalesce(NEW.source, NEW.utm_source, ''));
  v_pipeline_id          uuid;
  v_default_sales_rep_id uuid;
  v_stage_id             uuid;
  v_price                numeric := 0;
BEGIN
  -- Só canais externos que NÃO criam deal por conta própria.
  IF v_channel NOT IN ('credere', 'marketplace', 'stand') THEN
    RETURN NEW;
  END IF;

  IF v_tid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Extrai valor do veículo do metadata (ambos os formatos de canal).
  v_price := COALESCE(
    (NEW.metadata -> 'vehicle' ->> 'price')::numeric,
    (NEW.metadata -> 'vehicle' ->> 'assets_value')::numeric,
    0
  );

  -- Pipeline padrão ativo do tenant (fallback: qualquer pipeline ativo).
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

  -- Primeira etapa do pipeline (ignora ganho/perdido).
  SELECT id INTO v_stage_id
  FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND tenant_id = v_tid
    AND is_won = false AND is_lost = false
  ORDER BY position
  LIMIT 1;

  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotência: não cria se o lead já tem deal.
  IF EXISTS (SELECT 1 FROM deals WHERE lead_id = NEW.id AND tenant_id = v_tid) THEN
    RETURN NEW;
  END IF;

  INSERT INTO deals (
    lead_id, pipeline_id, pipeline_stage_id, sales_rep_id,
    original_price, negotiated_price, status, notes, created_at, tenant_id
  ) VALUES (
    NEW.id, v_pipeline_id, v_stage_id, v_default_sales_rep_id,
    v_price, v_price, 'open',
    'Criado automaticamente a partir do canal: ' || v_channel,
    NOW(), v_tid
  );

  -- Sincroniza etapa no lead + responsável padrão (se ainda não tiver).
  UPDATE leads
  SET pipeline_stage_id = v_stage_id,
      sales_rep_id      = COALESCE(sales_rep_id, v_default_sales_rep_id),
      updated_at        = NOW()
  WHERE id = NEW.id AND tenant_id = v_tid;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_create_deal_for_channel_lead ON public.leads;

CREATE TRIGGER trg_auto_create_deal_for_channel_lead
AFTER INSERT ON public.leads
FOR EACH ROW
EXECUTE FUNCTION public.auto_create_deal_for_channel_lead();

-- Backfill: atualiza deals existentes com negotiated_price = 0 que vieram de
-- canais externos e cujo lead tem valor no metadata.
UPDATE deals d
SET
  original_price    = v.preco,
  negotiated_price  = v.preco,
  updated_at        = NOW()
FROM (
  SELECT
    l.id AS lead_id,
    l.tenant_id,
    COALESCE(
      (l.metadata -> 'vehicle' ->> 'price')::numeric,
      (l.metadata -> 'vehicle' ->> 'assets_value')::numeric
    ) AS preco
  FROM leads l
  WHERE lower(coalesce(l.source, l.utm_source, '')) IN ('credere', 'marketplace', 'stand')
    AND (
      (l.metadata -> 'vehicle' ->> 'price')::numeric > 0
      OR (l.metadata -> 'vehicle' ->> 'assets_value')::numeric > 0
    )
) v
WHERE d.lead_id    = v.lead_id
  AND d.tenant_id  = v.tenant_id
  AND d.negotiated_price = 0
  AND d.original_price   = 0;
