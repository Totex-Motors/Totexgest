-- ============================================================================
-- SALA DE DEMO — Fase 1 (funil): pipeline "Recrutamento de Franqueados" (2026-09-28)
-- A sala de demo é pra RECRUTAR lojista/franqueado — público diferente do
-- comprador de carro. Então o funil da demo é um pipeline PRÓPRIO, no tenant HQ
-- (Totex Motors), SEM tocar nos funis de venda de carro das lojas.
--
-- Etapas: Novo → Contato → Demo enviada → Demo assistida → Call agendada →
--         Call realizada → Proposta → Fechado(ganho) / Perdido.
-- UUIDs fixos + ON CONFLICT DO NOTHING = idempotente.
-- Tenant HQ: c13681e3-5db9-48d1-9c5c-856e6041d77f (Totex Motors).
-- ============================================================================

INSERT INTO public.sales_pipelines (id, tenant_id, name, description, position, is_default, is_active)
VALUES ('fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f',
        'Recrutamento de Franqueados',
        'Funil de recrutamento de lojistas/franqueados via sala de demo personalizada.',
        10, false, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.sales_pipeline_stages (id, name, position, color, is_won, is_lost, pipeline_id, tenant_id)
VALUES
  ('fdec0000-0000-4000-a000-000000000001','Novo',           0, 'gray',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000002','Contato',        1, 'blue',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000003','Demo enviada',   2, 'indigo', false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000004','Demo assistida', 3, 'cyan',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000005','Call agendada',  4, 'amber',  false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000006','Call realizada', 5, 'teal',   false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000007','Proposta',       6, 'orange', false, false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000008','Fechado',        7, 'green',  true,  false, 'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f'),
  ('fdec0000-0000-4000-a000-000000000009','Perdido',        8, 'red',    false, true,  'fdec0000-0000-4000-a000-000000000000', 'c13681e3-5db9-48d1-9c5c-856e6041d77f')
ON CONFLICT (id) DO NOTHING;

-- As etapas "Demo enviada" (…003) e "Demo assistida" (…004) são CONSEQUÊNCIA:
-- a create-demo seta 003; a handle-milestone seta 004. Sem regra de automação
-- criando demo (evita envio duplicado) — ver docs/SALA-DEMO-ADAPTACAO.md §2.
