-- Fecha o vazamento de permissão das promotoras na captação.
--
-- Contexto: is_superadmin() retorna true pra QUALQUER membro do tenant HQ
-- (is_super_admin=true) — e as promotoras vivem no HQ. Como muitas funções da
-- captação usavam `is_admin() OR is_superadmin()` como gate de "gestor", toda
-- promotora era tratada como gestor: via dados das outras e podia rodar ações
-- administrativas (marcar venda, aprovar/pagar comissão, fechar mês, invalidar
-- lead, etc.) via API.
--
-- Correção: troca esse gate composto pelo verificador por PAPEL REAL
-- (is_capture_manager = role='admin' OU flag pessoal is_superadmin). Guardas
-- cross-tenant que usam is_superadmin() SOZINHO são mantidas (protegem operação
-- entre tenants e já ficam atrás do gate de gestor). Feito programaticamente pra
-- não reescrever à mão corpos longos e arriscar erro.
DO $mig$
DECLARE
  p_oid oid;
  def text;
  alvo text[] := ARRAY[
    'capture_close_month','capture_home_stats','capture_invalidate_lead',
    'capture_ledger_set_status','capture_mark_buyer_sold','capture_ranking',
    'capture_reward_progress','capture_training_summary','capture_wallet',
    'ensure_capture_pipeline','list_my_capture_leads','list_my_capture_vehicles',
    'protect_captured_by','repasse_ensure_code','set_capture_profile',
    'update_my_capture_lead'
  ];
BEGIN
  FOR p_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY(alvo)
  LOOP
    def := pg_get_functiondef(p_oid);
    def := replace(def, 'public.is_admin() OR public.is_superadmin()', 'public.is_capture_manager()');
    EXECUTE def;
  END LOOP;
END $mig$;
