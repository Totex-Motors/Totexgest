-- ============================================================================
-- FOLLOW-UP AUTOMÁTICO DO AGENTE DE TEXTO (decisão do Marco, 2026-10-15)
-- O agente nunca chamava agendar_lembrete (0 em 14 dias). Agora o agent-runner agenda
-- sozinho depois de cada resposta no WhatsApp (_shared/followup-auto.ts):
--   passo 1 → 3 h (8h–20h; senão 9h30 do dia seguinte)
--   passo 2 → 9h30 do dia seguinte
--   passo 3 → 48 h: mensagem de PAUSA com botões (Continuar / Me chama outro dia / Encerrar)
-- Botões tratados pelo whatsapp-cloud-webhook (handlePausaReply). Fora da janela de 24 h:
-- templates retomada_conversa (3 vars) e pausa_conversa (2 vars + QUICK_REPLY), criados na Meta.
-- ============================================================================
INSERT INTO config (key, value) VALUES
  ('FOLLOWUP_AUTO_ENABLED', 'true'),
  ('FOLLOWUP_1_HOURS', '3'),
  ('FOLLOWUP_PAUSA_ENABLED', 'true'),
  ('FOLLOWUP_PAUSA_HOURS', '48')
ON CONFLICT (key) DO NOTHING;

-- agente-stand: template de retomada fora da janela (3 variáveis: nome, assinatura, assunto)
UPDATE agents_registry
   SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('followup_template_name', 'retomada_conversa', 'followup_template_params', 3)
 WHERE slug = 'agente-stand' AND tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f';
