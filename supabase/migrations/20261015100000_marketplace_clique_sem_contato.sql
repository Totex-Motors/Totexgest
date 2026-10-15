-- ============================================================================
-- BOTÃO DO WHATSAPP DO SITE (2026-10-15, teste do Marco com o Kardian)
--
-- O marketplace cria no clique um lead SEM telefone ("Cliente (não identificado)",
-- source 'marketplace', metadata.vehicle + 1 deal). O número só chega com a mensagem:
-- o whatsapp-cloud-webhook (absorbMarketplaceClick) funde clique + número.
-- Quem clica e NUNCA manda mensagem fica sem número pra sempre — depois de 24 h sai do
-- funil: lead vira "Clique sem contato (site)" (status clique_sem_contato, sem etapa) e o
-- deal vira perdido com motivo claro. Cron diário.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.marketplace_cliques_sem_contato(p_horas integer DEFAULT 24)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0;
BEGIN
  WITH alvo AS (
    SELECT l.id FROM leads l
     WHERE l.phone IS NULL AND l.source = 'marketplace'
       AND l.created_at < now() - make_interval(hours => greatest(1, coalesce(p_horas, 24)))
       AND coalesce(l.status, '') <> 'clique_sem_contato'
       AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.lead_id = l.id)
  ), d AS (
    UPDATE deals SET status = 'lost', lost_reason = 'Clique no WhatsApp do site sem mensagem (número desconhecido)'
     WHERE lead_id IN (SELECT id FROM alvo) AND status NOT IN ('won', 'lost')
     RETURNING 1
  ), u AS (
    UPDATE leads SET name = 'Clique sem contato (site)', status = 'clique_sem_contato',
           pipeline_stage_id = NULL, etapa_funil = NULL,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('clique_sem_contato', true, 'clique_sem_contato_em', now())
     WHERE id IN (SELECT id FROM alvo)
     RETURNING 1
  )
  SELECT count(*) INTO n FROM u;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.marketplace_cliques_sem_contato(integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.marketplace_cliques_sem_contato(integer) TO service_role;

SELECT cron.unschedule('marketplace-cliques-sem-contato') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'marketplace-cliques-sem-contato');
SELECT cron.schedule('marketplace-cliques-sem-contato', '23 6 * * *', $$ SELECT public.marketplace_cliques_sem_contato(24) $$);
