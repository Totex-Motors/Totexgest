-- ============================================================================
-- Pipeline Webinário: novas etapas no início pra rastrear entrada na comunidade.
-- ============================================================================

DO $$ BEGIN
  -- 1) Vincula campanha de distribuição → webinário (sem FK pois webinar_config pode não existir)
  ALTER TABLE wa_community_campaigns
    ADD COLUMN IF NOT EXISTS webinar_config_id UUID;

  -- 2) Renomeia 'Novo' → 'Lead capturado' no pipeline Webinário
  UPDATE sales_pipeline_stages
  SET name = 'Lead capturado'
  WHERE pipeline_id = (SELECT id FROM sales_pipelines WHERE name = 'Webinário')
    AND name = 'Novo';

  -- 3) Desloca todas as etapas position >= 2 em +2 pra abrir espaço
  UPDATE sales_pipeline_stages
  SET position = position + 2
  WHERE pipeline_id = (SELECT id FROM sales_pipelines WHERE name = 'Webinário')
    AND position >= 2;

  -- 4) Insere as duas etapas novas
  INSERT INTO sales_pipeline_stages (pipeline_id, name, position, color, is_won, is_lost)
  VALUES
    ((SELECT id FROM sales_pipelines WHERE name = 'Webinário'),
     'Entrou na comunidade', 2, '#10B981', false, false),
    ((SELECT id FROM sales_pipelines WHERE name = 'Webinário'),
     'Não entrou na comunidade', 3, '#F97316', false, false);

EXCEPTION WHEN OTHERS THEN NULL; END $$;
