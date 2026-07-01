-- ============================================================================
-- Qualificação automotiva: adiciona parâmetros de perfil de compra à ferramenta
-- qualify_lead do agente legado (ai-sales-agent / tabela ai_agent_tools).
--
-- Contexto: o agente vinha com qualificação B2B (faturamento, funcionários).
-- Para revenda de veículos, o agente precisa capturar o PERFIL DE COMPRA e
-- gravá-lo em leads.metadata (mesmos campos que a BuyerProfileCard lê na tela).
-- O handler no edge function ai-sales-agent já trata esses args; aqui apenas
-- EXPOMOS os parâmetros no schema para o LLM poder enviá-los.
--
-- Idempotente: faz merge das novas properties nas existentes (|| preserva as
-- chaves B2B atuais). Roda sobre todas as ferramentas com action_type
-- 'qualify_bant' (nome geralmente 'qualify_lead').
-- ============================================================================

UPDATE public.ai_agent_tools
SET parameters = jsonb_set(
  parameters,
  '{properties}',
  COALESCE(parameters -> 'properties', '{}'::jsonb) || jsonb_build_object(
    'veiculo_interesse', jsonb_build_object(
      'type', 'string',
      'description', 'Qual veículo o cliente quer (marca/modelo/versão/ano, texto livre)'
    ),
    'faixa_preco_min', jsonb_build_object(
      'type', 'number',
      'description', 'Orçamento mínimo do cliente para o veículo, em reais (só número)'
    ),
    'faixa_preco_max', jsonb_build_object(
      'type', 'number',
      'description', 'Orçamento máximo do cliente para o veículo, em reais (só número)'
    ),
    'precisa_financiar', jsonb_build_object(
      'type', 'boolean',
      'description', 'true se o cliente precisa/quer financiar; false se paga à vista'
    ),
    'entrada_disponivel', jsonb_build_object(
      'type', 'number',
      'description', 'Valor de entrada que o cliente tem disponível, em reais (só número)'
    ),
    'tem_veiculo_troca', jsonb_build_object(
      'type', 'boolean',
      'description', 'true se o cliente tem um veículo para dar na troca'
    ),
    'forma_pagamento', jsonb_build_object(
      'type', 'string',
      'description', 'Forma de pagamento pretendida',
      'enum', jsonb_build_array('a_vista', 'financiamento', 'consorcio', 'misto')
    ),
    'urgencia', jsonb_build_object(
      'type', 'string',
      'description', 'Urgência de compra do cliente',
      'enum', jsonb_build_array('imediata', 'ate_30_dias', 'ate_90_dias', 'pesquisando')
    )
  )
),
updated_at = now()
WHERE action_type = 'qualify_bant';
