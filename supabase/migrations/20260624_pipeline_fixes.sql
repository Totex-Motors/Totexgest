-- =====================================================================
-- Correções de Pipeline:
--   1) Reaplica (idempotente) o trigger de auto-criação de deal para
--      leads dos canais externos (Credere / Marketplace / Stand).
--   2) Backfill: cria deals para os leads de canal JÁ EXISTENTES que
--      ainda não têm deal (o trigger só dispara em INSERT futuro).
--   3) Cria a função run_sql(sql) usada pelo assistente (chat-manager)
--      para consultas read-only, respeitando o RLS do usuário.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Trigger de auto-criação de deal por canal (idempotente)
-- ---------------------------------------------------------------------
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
  IF v_channel NOT IN ('credere', 'marketplace', 'stand') THEN
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
-- 2) Backfill dos leads de canal já existentes (sem deal)
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
    WHERE lower(coalesce(l.source, l.utm_source, '')) IN ('credere', 'marketplace', 'stand')
      AND l.tenant_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.tenant_id = l.tenant_id
      )
  LOOP
    -- Pipeline padrão do tenant (fallback: qualquer ativo)
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

-- ---------------------------------------------------------------------
-- 3) run_sql: usado pelo assistente (chat-manager) para SELECTs.
--    SECURITY INVOKER => roda com o papel do usuário => RLS por tenant
--    continua valendo (o assistente só enxerga dados do próprio tenant).
--    Bloqueia qualquer coisa que não seja leitura.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.run_sql(text);

CREATE OR REPLACE FUNCTION public.run_sql(sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  -- Remove espaços e ; nas pontas (modelo costuma mandar SQL terminando em ;)
  v_sql text := btrim(btrim(coalesce(sql, '')), E' \t\n;');
  v_clean text := lower(v_sql);
  v_result jsonb;
BEGIN
  -- Só permite SELECT / WITH (CTE). Bloqueia DML/DDL e múltiplos statements.
  IF v_clean !~ '^(select|with)\s' THEN
    RAISE EXCEPTION 'Apenas SELECT permitido';
  END IF;
  IF v_clean ~ '\m(insert|update|delete|drop|alter|truncate|create|grant|revoke)\M' THEN
    RAISE EXCEPTION 'Apenas queries de leitura permitidas';
  END IF;
  IF position(';' in v_sql) > 0 THEN
    RAISE EXCEPTION 'Apenas um statement permitido';
  END IF;

  EXECUTE 'SELECT COALESCE(jsonb_agg(t), ''[]''::jsonb) FROM (' || v_sql || ') t'
  INTO v_result;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.run_sql(text) TO authenticated;
