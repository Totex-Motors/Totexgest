-- 08/11 — "Ativar no Playbook" caía com "Erro ao ativar leads": a RPC ativar_leads_no_playbook
-- escrevia em colunas que nunca existiram no banco (dia_do_playbook, tentativas_de_contato,
-- status_de_resposta, ultima_acao) e a RPC increment_tentativas não existia. JÁ APLICADO em produção.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS dia_do_playbook integer DEFAULT 1;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS tentativas_de_contato integer DEFAULT 0;
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS status_de_resposta text DEFAULT 'NAO_RESPONDEU';
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ultima_acao text;

CREATE OR REPLACE FUNCTION public.increment_tentativas(lead_id uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE v int;
BEGIN
  UPDATE leads SET tentativas_de_contato = COALESCE(tentativas_de_contato, 0) + 1 WHERE id = lead_id AND tenant_id = public.get_tenant_id() RETURNING tentativas_de_contato INTO v;
  RETURN COALESCE(v, 0);
END $f$;
GRANT EXECUTE ON FUNCTION public.increment_tentativas(uuid) TO authenticated;

-- aceita lead sem acao_de_hoje (todos os 767 estavam nulos) e preserva etapa_funil já preenchida
CREATE OR REPLACE FUNCTION public.ativar_leads_no_playbook(lead_ids uuid[], max_leads integer DEFAULT 20)
RETURNS TABLE(id uuid, name text) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_tid uuid;
BEGIN
  v_tid := (SELECT public.get_tenant_id());
  RETURN QUERY
  UPDATE leads l
  SET acao_de_hoje = 'ENVIAR_MENSAGEM', etapa_funil = COALESCE(l.etapa_funil, 'novo'), dia_do_playbook = 1,
      tentativas_de_contato = 0, status_de_resposta = 'NAO_RESPONDEU', ultima_acao = NULL
  WHERE l.id = ANY(lead_ids)
    AND l.tenant_id = v_tid
    AND (l.acao_de_hoje IS NULL OR l.acao_de_hoje IN ('AGUARDAR', 'ENCERRAR'))
    AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.primary_contact_id = l.id AND o.tenant_id = v_tid)
    AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.status = 'won' AND d.tenant_id = v_tid)
  RETURNING l.id, l.name;
END $f$;
GRANT EXECUTE ON FUNCTION public.ativar_leads_no_playbook(uuid[], integer) TO authenticated;
