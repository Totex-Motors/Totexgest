-- No-show no funil de Venda (Pipeline Padrão): nova etapa entre Test Drive e
-- Avaliação/Proposta + regras (mover, follow-up, alerta). Renumera do maior
-- pro menor pra não colidir posições.
-- NOTA: stage_id/pipeline_id específicos do tenant Totex Motors.
UPDATE public.sales_pipeline_stages SET position=7, updated_at=now() WHERE id='09394fbb-2155-4dc3-b235-f432ae89b3de';
UPDATE public.sales_pipeline_stages SET position=6, updated_at=now() WHERE id='3628c72f-dc47-4130-aba1-df225d70bbf8';
UPDATE public.sales_pipeline_stages SET position=5, updated_at=now() WHERE id='af0a2ff3-5e4c-47f9-9427-3c4c68df0d5e';
UPDATE public.sales_pipeline_stages SET position=4, updated_at=now() WHERE id='b0949a75-a1ba-4ab1-9be0-c430851d9d71';

INSERT INTO public.sales_pipeline_stages (id, name, position, color, pipeline_id, tenant_id)
VALUES ('7f3d1c9a-4b2e-4a10-9c88-2b6e5f0a1d33', 'No-show', 3, 'red',
        '9d74ad1f-10d2-418d-9309-fb26eff3609a', 'c13681e3-5db9-48d1-9c5c-856e6041d77f')
ON CONFLICT (id) DO NOTHING;

UPDATE public.sales_automation_rules SET action_config = action_config || '{"only_if_position_less_than":4}'::jsonb, updated_at=now()
  WHERE tenant_id='c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name='Agendou apresentação → Test Drive';
UPDATE public.sales_automation_rules SET action_config = action_config || '{"only_if_position_less_than":4}'::jsonb, updated_at=now()
  WHERE tenant_id='c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name='Apresentação realizada → Avaliação / Proposta';
UPDATE public.sales_automation_rules SET action_config = action_config || '{"only_if_position_less_than":5}'::jsonb, updated_at=now()
  WHERE tenant_id='c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name='Proposta enviada → Financiamento';

INSERT INTO public.sales_automation_rules
  (tenant_id, name, description, trigger_type, trigger_conditions, action_type, action_config, is_active, team, priority)
VALUES
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','Não compareceu → No-show','Cliente não compareceu na apresentação move o deal pra etapa No-show.','meeting_no_show','{"task_types":["video_call","visit"]}'::jsonb,'move_deal_stage','{"target_stage_id":"7f3d1c9a-4b2e-4a10-9c88-2b6e5f0a1d33","only_if_position_less_than":4}'::jsonb,true,'sales',5),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','No-show → criar follow-up','No-show gera uma tarefa de follow-up pro vendedor remarcar.','meeting_no_show','{"task_types":["video_call","visit"]}'::jsonb,'create_task','{"task_template":{"name":"Remarcar — cliente não compareceu","task_type":"follow_up","days_offset":0}}'::jsonb,true,'sales',6),
  ('c13681e3-5db9-48d1-9c5c-856e6041d77f','No-show → alertar vendas','No-show gera um alerta interno pra ação imediata.','meeting_no_show','{"task_types":["video_call","visit"]}'::jsonb,'send_notification','{"type":"no_show","message":"{{cliente}} não compareceu — remarcar o quanto antes"}'::jsonb,true,'sales',7);
