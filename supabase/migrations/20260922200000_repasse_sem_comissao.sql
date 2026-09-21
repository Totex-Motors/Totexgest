-- Torna permanente a decisão de NÃO pagar comissão no repasse das promotoras.
-- O seed original (20260916140000_repasse_indicacoes.sql) criava a regra
-- 'Indicação de repasse convertida (comprou)' de R$ 150. Essa regra foi removida do
-- seed; esta migration remove qualquer regra 'repasse_converted' que já tenha sido
-- criada em bases que aplicaram o seed antigo — sem apagar histórico de pagamentos
-- (o ledger referencia o evento/ledger próprio, não a regra).
--
-- O repasse continua funcionando (indicação por cartão NFC é rastreada e marcada como
-- 'convertida' na venda), apenas sem comissão automática. Para reativar no futuro, basta
-- recriar uma regra 'repasse_converted' em capture_reward_rules
-- (ou por Configurações > Prêmios da captação).

DELETE FROM public.capture_reward_rules WHERE event_type = 'repasse_converted';
