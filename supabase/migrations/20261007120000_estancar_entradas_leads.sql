-- ============================================================================
-- ESTANCAR ENTRADAS DE LEADS — passo 1 (2026-10-07)
-- Base: docs/ENTRADAS-DE-LEADS.md. Desliga o legado do template "IA na Prática"
-- e fecha o "tenant fantasma". Nada aqui cria lead — só remove e guarda.
-- Verificado em produção antes: pain_registrations vazia; tenant …0001 não
-- existe em `tenants`, tem 0 leads e 0 membros.
-- ============================================================================

-- ─── 1) Legado PAIN ──────────────────────────────────────────────────────────
-- Trigger que criava lead + deal "PAIN R$ 25.000" a cada pain_registrations.
-- Não é o negócio Totex (venda/intermediação de veículos).
DROP TRIGGER IF EXISTS trigger_create_lead_deal_on_pain_registration ON public.pain_registrations;
DROP FUNCTION IF EXISTS public.create_lead_and_deal_from_pain_registration();

-- ─── 2) Guarda contra o tenant fantasma ──────────────────────────────────────
-- leads.tenant_id tem DEFAULT get_tenant_id(), que cai em
-- 00000000-0000-0000-0000-000000000001 quando não há tenant no JWT (inserts via
-- service-role sem tenant_id). Esse tenant NÃO existe. A partir daqui, lead sem
-- loja real é REJEITADO com erro claro, em vez de sumir num lugar que ninguém olha.
-- (O DEFAULT da coluna roda ANTES do trigger BEFORE ROW, então o valor fantasma
-- já está em NEW.tenant_id e é pego aqui.)
CREATE OR REPLACE FUNCTION public.trg_leads_require_real_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS NULL
     OR NEW.tenant_id = '00000000-0000-0000-0000-000000000001'::uuid
     OR NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Lead sem loja (tenant) definida: informe um tenant_id válido. (origem: %)',
      coalesce(NEW.source, NEW.utm_source, 'desconhecida')
      USING ERRCODE = '23514',
            HINT = 'Toda porta de entrada precisa resolver a loja antes de criar o lead (docs/ENTRADAS-DE-LEADS.md §3.6).';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_leads_require_real_tenant ON public.leads;
CREATE TRIGGER trg_leads_require_real_tenant
  BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_leads_require_real_tenant();

-- ─── 3) RPC que o book-meeting (/agendar) chamava e NÃO existia ──────────────
-- Acha lead pelo telefone normalizado (últimos 8 dígitos), dentro de um tenant,
-- resultado determinístico (o mais recente). Sem tenant = busca global (evitar).
CREATE OR REPLACE FUNCTION public.find_lead_by_phone_normalized(p_phone text, p_tenant uuid DEFAULT NULL)
RETURNS SETOF public.leads
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.*
  FROM public.leads l
  WHERE length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 8
    AND l.phone IS NOT NULL
    AND right(regexp_replace(l.phone, '\D', '', 'g'), 8) = right(regexp_replace(p_phone, '\D', '', 'g'), 8)
    AND (p_tenant IS NULL OR l.tenant_id = p_tenant)
  ORDER BY l.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.find_lead_by_phone_normalized(text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_lead_by_phone_normalized(text, uuid) TO service_role, authenticated;

COMMENT ON FUNCTION public.trg_leads_require_real_tenant() IS
  'Guarda: rejeita lead sem tenant real (ou no tenant fantasma …0001). Passo 1 de docs/ENTRADAS-DE-LEADS.md.';
