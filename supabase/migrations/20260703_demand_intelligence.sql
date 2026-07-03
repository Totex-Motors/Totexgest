-- ============================================================================
-- Inteligência de Demanda — view analítica achatada dos leads.
--
-- Uma linha por lead com tudo que o dashboard /comercial/inteligencia precisa:
-- origem, veículo do clique (marketplace/totem) x veículo pedido na conversa
-- (capturar_perfil_compra), perfil de compra, qualificação do agente
-- (stand-handoff) e encaminhamento. Casts protegidos: metadata é jsonb livre —
-- valor fora do formato vira NULL em vez de quebrar a view inteira.
--
-- security_invoker: respeita a RLS de quem consulta (não vaza entre tenants).
-- ============================================================================

create or replace view public.vw_inteligencia_leads
with (security_invoker = true) as
select
  l.id,
  l.tenant_id,
  l.created_at,
  coalesce(nullif(btrim(l.source), ''), 'direto')                     as origem,
  l.metadata->>'marketplace_origin'                                    as origem_marketplace,
  nullif(btrim(concat(l.metadata->'vehicle'->>'brand', ' ',
                      l.metadata->'vehicle'->>'model')), '')           as veiculo_clique,
  case when (l.metadata->'vehicle'->>'price') ~ '^\d+(\.\d+)?$'
       then (l.metadata->'vehicle'->>'price')::numeric end             as veiculo_clique_preco,
  l.metadata->>'veiculo_interesse_texto'                               as veiculo_conversa,
  case when (l.metadata->>'faixa_preco_min') ~ '^\d+(\.\d+)?$'
       then (l.metadata->>'faixa_preco_min')::numeric end              as faixa_preco_min,
  case when (l.metadata->>'faixa_preco_max') ~ '^\d+(\.\d+)?$'
       then (l.metadata->>'faixa_preco_max')::numeric end              as faixa_preco_max,
  case when l.metadata->>'precisa_financiar' in ('true','false')
       then (l.metadata->>'precisa_financiar')::boolean end            as precisa_financiar,
  case when (l.metadata->>'entrada_disponivel') ~ '^\d+(\.\d+)?$'
       then (l.metadata->>'entrada_disponivel')::numeric end           as entrada_disponivel,
  case when l.metadata->>'tem_veiculo_troca' in ('true','false')
       then (l.metadata->>'tem_veiculo_troca')::boolean end            as tem_veiculo_troca,
  l.metadata->>'forma_pagamento'                                       as forma_pagamento,
  l.metadata->>'urgencia'                                              as urgencia,
  l.metadata->'qualificacao'->>'categoria'                             as categoria,
  l.metadata->'qualificacao'->>'temperatura'                           as temperatura,
  case when l.metadata->'qualificacao'->>'interesse_test_drive' in ('true','false')
       then (l.metadata->'qualificacao'->>'interesse_test_drive')::boolean
       else false end                                                  as interesse_test_drive,
  case when l.metadata->'qualificacao'->>'interesse_visita' in ('true','false')
       then (l.metadata->'qualificacao'->>'interesse_visita')::boolean
       else false end                                                  as interesse_visita,
  case when l.metadata->'handoff'->>'encaminhado' in ('true','false')
       then (l.metadata->'handoff'->>'encaminhado')::boolean
       else false end                                                  as encaminhado,
  l.sales_score,
  (l.metadata->>'veiculo_interesse_texto' is not null
    or l.metadata->>'faixa_preco_max' is not null
    or l.metadata->>'faixa_preco_min' is not null
    or l.metadata->>'precisa_financiar' is not null
    or l.metadata->>'tem_veiculo_troca' is not null)                   as tem_perfil
from public.leads l;

comment on view public.vw_inteligencia_leads is
  'Inteligência de demanda: uma linha por lead com origem, veículo (clique x conversa), perfil de compra, qualificação e encaminhamento. Alimenta /comercial/inteligencia.';
