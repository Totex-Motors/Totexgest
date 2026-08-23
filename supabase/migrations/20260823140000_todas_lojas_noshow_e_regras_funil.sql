-- Padroniza o funil de Venda em TODAS as lojas (menos a Totex, que já foi feita
-- nas migrations 20260823110000 / 20260823120000). Para cada tenant com um
-- "Pipeline Padrão" no layout padrão (0 Novo Lead, 1 Em Qualificação,
-- 2 Agendamento, 3 Avaliação/Proposta, 4 Financiamento, 5 Ganho, 6 Perdido):
--   1. insere a etapa "No-show" na posição 3 (empurra 3+ pra frente);
--   2. cria as regras de automação que movem o deal conforme a interação
--      (agendou → Agendamento, compareceu → Avaliação/Proposta,
--       proposta → Financiamento) e o trio de No-show (mover, follow-up, alerta).
--
-- Identifica as etapas por POSIÇÃO (a estrutura é idêntica nas 5 lojas), não por
-- nome, pra ser robusto a variações ("Avaliação/Proposta" x "Avaliação / Proposta").
-- Idempotente: só age em pipeline sem etapa "No-show" e só cria regra cujo nome
-- ainda não existe no tenant. Não replica as regras de Captação (Tamboré), que
-- são exclusivas da Totex.

DO $$
DECLARE
  r RECORD;
  v_ag_id   uuid;  -- etapa Agendamento (posição 2)
  v_aval_id uuid;  -- etapa Avaliação/Proposta (posição 3, antes do shift)
  v_fin_id  uuid;  -- etapa Financiamento (posição 4, antes do shift)
  v_noshow_id uuid;
BEGIN
  FOR r IN
    SELECT p.id AS pipeline_id, p.tenant_id
    FROM public.sales_pipelines p
    WHERE p.name = 'Pipeline Padrão'
      -- Totex já padronizada nas migrations anteriores
      AND p.tenant_id <> 'c13681e3-5db9-48d1-9c5c-856e6041d77f'
      -- ainda não tem No-show neste pipeline
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_pipeline_stages s
        WHERE s.pipeline_id = p.id AND s.name ILIKE 'no-show'
      )
      -- precisa ter o layout esperado (posições 2, 3 e 4 presentes)
      AND EXISTS (SELECT 1 FROM public.sales_pipeline_stages s WHERE s.pipeline_id = p.id AND s.position = 2)
      AND EXISTS (SELECT 1 FROM public.sales_pipeline_stages s WHERE s.pipeline_id = p.id AND s.position = 3)
      AND EXISTS (SELECT 1 FROM public.sales_pipeline_stages s WHERE s.pipeline_id = p.id AND s.position = 4)
  LOOP
    -- Captura os IDs pelas posições ANTES de empurrar
    SELECT id INTO v_ag_id   FROM public.sales_pipeline_stages WHERE pipeline_id = r.pipeline_id AND position = 2 LIMIT 1;
    SELECT id INTO v_aval_id FROM public.sales_pipeline_stages WHERE pipeline_id = r.pipeline_id AND position = 3 LIMIT 1;
    SELECT id INTO v_fin_id  FROM public.sales_pipeline_stages WHERE pipeline_id = r.pipeline_id AND position = 4 LIMIT 1;

    -- Empurra tudo que está em 3+ uma posição pra frente (maior primeiro, evita colisão)
    UPDATE public.sales_pipeline_stages
      SET position = position + 1, updated_at = now()
      WHERE pipeline_id = r.pipeline_id AND position >= 3;

    -- Insere a etapa No-show na posição 3
    v_noshow_id := gen_random_uuid();
    INSERT INTO public.sales_pipeline_stages (id, name, position, color, pipeline_id, tenant_id)
    VALUES (v_noshow_id, 'No-show', 3, 'red', r.pipeline_id, r.tenant_id);

    -- Regras de movimento do funil (só cria se ainda não existir pelo nome)
    INSERT INTO public.sales_automation_rules
      (tenant_id, name, description, trigger_type, trigger_conditions, action_type, action_config, is_active, team, priority)
    SELECT r.tenant_id, x.name, x.description, x.trigger_type, x.trigger_conditions::jsonb, x.action_type, x.action_config::jsonb, true, 'sales', x.priority
    FROM (VALUES
      ('Agendou apresentação → Agendamento',
       'Chamada de vídeo ou visita agendada move o deal pra etapa Agendamento.',
       'meeting_scheduled', '{"task_types":["video_call","visit"]}',
       'move_deal_stage', json_build_object('target_stage_id', v_ag_id, 'only_if_position_less_than', 2)::text, 10),
      ('Apresentação realizada → Avaliação / Proposta',
       'Cliente compareceu (vídeo/visita concluída) move o deal pra Avaliação / Proposta.',
       'meeting_completed', '{"task_types":["video_call","visit"]}',
       'move_deal_stage', json_build_object('target_stage_id', v_aval_id, 'only_if_position_less_than', 4)::text, 10),
      ('Proposta enviada → Financiamento',
       'Proposta/simulação concluída move o deal pra Financiamento (Credere).',
       'meeting_completed', '{"task_types":["proposal"]}',
       'move_deal_stage', json_build_object('target_stage_id', v_fin_id, 'only_if_position_less_than', 5)::text, 10),
      ('Não compareceu → No-show',
       'Cliente não compareceu na apresentação move o deal pra etapa No-show.',
       'meeting_no_show', '{"task_types":["video_call","visit"]}',
       'move_deal_stage', json_build_object('target_stage_id', v_noshow_id, 'only_if_position_less_than', 4)::text, 5),
      ('No-show → criar follow-up',
       'No-show gera uma tarefa de follow-up pro vendedor remarcar.',
       'meeting_no_show', '{"task_types":["video_call","visit"]}',
       'create_task', '{"task_template":{"name":"Remarcar — cliente não compareceu","task_type":"follow_up","days_offset":0}}', 6),
      ('No-show → alertar vendas',
       'No-show gera um alerta interno pra ação imediata.',
       'meeting_no_show', '{"task_types":["video_call","visit"]}',
       'send_notification', '{"type":"no_show","title":"No-show","message":"{{cliente}} não compareceu — remarcar o quanto antes"}', 7)
    ) AS x(name, description, trigger_type, trigger_conditions, action_type, action_config, priority)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sales_automation_rules ar
      WHERE ar.tenant_id = r.tenant_id AND ar.name = x.name
    );

    RAISE NOTICE 'Loja % (pipeline %): No-show + regras de funil criadas.', r.tenant_id, r.pipeline_id;
  END LOOP;
END $$;
