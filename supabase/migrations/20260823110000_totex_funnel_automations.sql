-- Fase 2 do funil: automações que movem o deal conforme a interação acontece.
-- O move_deal_stage escopa pelo pipeline da etapa destino, então regra de
-- Venda só mexe em deal do Pipeline Padrão e de Captação só no Tamboré.
-- NOTA: os stage_id abaixo são específicos do tenant Totex Motors — em outro
-- ambiente as regras precisam ser recriadas com os UUIDs das etapas locais.
UPDATE public.sales_automation_rules
  SET is_active = false, updated_at = now()
  WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name = 'Teste';

INSERT INTO public.sales_automation_rules
  (tenant_id, name, description, trigger_type, trigger_conditions, action_type, action_config, is_active, team, priority)
VALUES
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Agendou apresentação → Test Drive','Chamada de vídeo ou visita/test drive agendada move o deal pra etapa Test Drive.','meeting_scheduled','{"task_types":["video_call","visit"]}'::jsonb,'move_deal_stage','{"target_stage_id":"0ff28255-dd1b-450a-8aae-e4f7641dfaa4","only_if_position_less_than":2}'::jsonb,true,'sales',10),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Apresentação realizada → Avaliação / Proposta','Cliente compareceu (vídeo/visita concluída) move o deal pra Avaliação / Proposta.','meeting_completed','{"task_types":["video_call","visit"]}'::jsonb,'move_deal_stage','{"target_stage_id":"b0949a75-a1ba-4ab1-9be0-c430851d9d71","only_if_position_less_than":3}'::jsonb,true,'sales',10),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Proposta enviada → Financiamento','Proposta/simulação concluída move o deal pra Financiamento (Credere).','meeting_completed','{"task_types":["proposal"]}'::jsonb,'move_deal_stage','{"target_stage_id":"af0a2ff3-5e4c-47f9-9427-3c4c68df0d5e","only_if_position_less_than":4}'::jsonb,true,'sales',10),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Agendou levar o carro → Agendou','Visita agendada na captação move o deal pra etapa Agendou.','meeting_scheduled','{"task_types":["visit"]}'::jsonb,'move_deal_stage','{"target_stage_id":"a120c132-657a-4f83-b3aa-04ad23ea50fc","only_if_position_less_than":2}'::jsonb,true,'sales',20),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Sessão de fotos → Veio à loja p/ fotos','Sessão de fotos concluída move o deal pra Veio loja P/ fotos.','meeting_completed','{"task_types":["photo_session"]}'::jsonb,'move_deal_stage','{"target_stage_id":"a9a203c8-9bd5-4754-a473-917171a24f13","only_if_position_less_than":4}'::jsonb,true,'sales',20);
