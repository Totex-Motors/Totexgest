-- ============================================================================
-- NINA — cadência quando o cliente NÃO ATENDE (decisão do Marco, 2026-10-15)
--   1ª não atendida → liga de novo em 15 min
--   2ª não atendida → mensagem de curiosidade no WhatsApp + liga de novo em 1 h
--   3ª não atendida → 2ª mensagem 3 h depois e encerra (no_answer)
-- Código: _shared/nina-cadence.ts (voice-agent-postcall + nina-dialer).
-- Templates Meta (fora da janela de 24 h): nina_curiosidade_1 / nina_curiosidade_2,
-- criados pela API com {{1}} nome, {{2}} assinatura, {{3}} assunto ("o Nivus que você viu").
-- ============================================================================
INSERT INTO config (key, value) VALUES
  ('NINA_RETRY_1_MIN', '15'),
  ('NINA_RETRY_2_MIN', '60'),
  ('NINA_MSG2_HOURS', '3')
ON CONFLICT (key) DO NOTHING;
