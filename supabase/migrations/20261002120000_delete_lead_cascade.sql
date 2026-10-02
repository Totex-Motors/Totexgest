-- ============================================================================
-- delete_lead_cascade — exclusão COMPLETA de um lead (2026-10-02)
-- O delete do app só limpava 4 tabelas; qualquer lead com venda/ligação/atividade
-- dava "Erro ao excluir lead" (FK bloqueando). Esta função descobre DINAMICAMENTE
-- todas as tabelas que travam (as que referenciam leads E as que referenciam as
-- negociações do lead, com ON DELETE NO ACTION/RESTRICT), limpa na ordem e apaga
-- o lead. O resto resolve sozinho: deals/intermediations (CASCADE) e comissões/
-- prêmios (SET NULL — preservados, só desvinculam).
--
-- À prova de futuro: tabela nova que referencie lead/deal já entra no laço.
-- SECURITY DEFINER (bypassa RLS de propósito); gate por admin/superadmin + tenant.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.delete_lead_cascade(p_lead_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  r record;
BEGIN
  -- Permissão: só admin da loja ou superadmin de verdade (não promotora/comercial).
  IF NOT (public.is_admin() OR public.is_platform_superadmin()) THEN
    RAISE EXCEPTION 'Sem permissão para excluir leads';
  END IF;

  SELECT tenant_id INTO v_tenant FROM leads WHERE id = p_lead_id;
  IF v_tenant IS NULL THEN RETURN; END IF;  -- lead já não existe

  -- Só apaga lead da própria loja (ou superadmin cross-tenant).
  IF v_tenant <> public.get_tenant_id() AND NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'Lead de outra loja';
  END IF;

  -- Caso especial: organização que tem este lead como contato principal → desvincula
  -- (não apaga a organização inteira por causa de um lead).
  UPDATE public.organizations SET primary_contact_id = NULL WHERE primary_contact_id = p_lead_id;

  -- 1) Filhos das NEGOCIAÇÕES do lead que bloqueiam (FK deal_id = NO ACTION/RESTRICT).
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'public.deals'::regclass
      AND c.confdeltype IN ('a','r')
  LOOP
    EXECUTE format(
      'DELETE FROM public.%I WHERE %I IN (SELECT id FROM public.deals WHERE lead_id = $1)',
      r.tbl, r.col) USING p_lead_id;
  END LOOP;

  -- 2) Filhos do LEAD que bloqueiam (FK p/ leads = NO ACTION/RESTRICT), menos organizations
  --    (tratada acima com SET NULL).
  FOR r IN
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'public.leads'::regclass
      AND c.confdeltype IN ('a','r')
      AND c.conrelid <> 'public.organizations'::regclass
  LOOP
    EXECUTE format('DELETE FROM public.%I WHERE %I = $1', r.tbl, r.col) USING p_lead_id;
  END LOOP;

  -- 3) Apaga o lead — CASCADE/SET NULL cuidam do resto.
  DELETE FROM public.leads WHERE id = p_lead_id;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_lead_cascade(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_lead_cascade(uuid) TO authenticated;
