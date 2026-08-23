-- No mercado automotivo o ponto-chave é trazer o cliente à loja: a etapa
-- "Test Drive" vira "Agendamento" (pedido do Marco). Só muda o nome de exibição.
-- NOTA: stage_id específico do tenant Totex Motors.
UPDATE public.sales_pipeline_stages
  SET name = 'Agendamento', updated_at = now()
  WHERE id = '0ff28255-dd1b-450a-8aae-e4f7641dfaa4';

UPDATE public.sales_automation_rules
  SET name = 'Agendou apresentação → Agendamento',
      description = 'Chamada de vídeo ou visita/test drive agendada move o deal pra etapa Agendamento.',
      updated_at = now()
  WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name = 'Agendou apresentação → Test Drive';
