-- ============================================================================
-- CARD DA SIMULAÇÃO (ideia do Marco, 2026-10-15): a Nina "roda o simulador" e manda a
-- IMAGEM da simulação no WhatsApp (edge fn simulacao-card + _shared/simulacao-card.ts).
-- Tool do agente-stand: enviar_simulacao (edge_function simulacao-card).
-- Prompt do agente: bullet em "## FERRAMENTAS" + MODO REAQUECIMENTO usa enviar_simulacao.
-- (aplicado em produção via SQL; aqui a versão idempotente)
-- ============================================================================
INSERT INTO agents_tools (agent_id, tenant_id, name, description, action_type, action_config, parameters_schema, usage_mode, is_active, requires_approval, provider)
SELECT agent_id, tenant_id, 'enviar_simulacao',
  'RODA O SIMULADOR DA CARDOSO E MANDA A IMAGEM da simulação no WhatsApp do cliente (carro, preço, entrada, parcela em destaque, outros prazos e a jogada do décimo terceiro). Use SEMPRE que o cliente perguntar parcela, financiamento ou "quanto fica": antes de chamar, diga em uma frase que vai rodar no simulador ("deixa eu rodar aqui no simulador da Cardoso, me dá um minutinho"). Passe o nome do carro (ou o valor do consultar_estoque). A imagem é enviada pela própria ferramenta: depois só comente a jogada em uma frase e faça UMA pergunta. Nunca cite taxa. Não passe valor do carro do cliente na troca.',
  'edge_function', '{"name":"simulacao-card","verify_jwt":false}'::jsonb,
  '{"type":"object","properties":{"carro":{"type":"string","description":"Nome do carro (ex.: GWM Ora 03 GT). Se não passar, usa o carro de interesse do cliente."},"valor":{"type":"number","description":"Preço do carro em reais, só número (do consultar_estoque), se tiver."},"entrada":{"type":"number","description":"Entrada em reais, se o cliente falou. Sem isso, usa 20%."},"prazo":{"type":"number","description":"Prazo em meses, se o cliente escolheu (24, 36, 48 ou 60)."},"extra":{"type":"number","description":"Décimo terceiro, férias, PLR ou FGTS em reais, se o cliente citou."}}}'::jsonb,
  'always', true, false, NULL
FROM agents_tools WHERE name = 'simular_plano' AND tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'
  AND NOT EXISTS (SELECT 1 FROM agents_tools t2 WHERE t2.name = 'enviar_simulacao' AND t2.tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f');

INSERT INTO config (key, value) VALUES ('SIMULACAO_CARD_DELAY_MS', '6000') ON CONFLICT (key) DO NOTHING;
