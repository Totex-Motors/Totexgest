-- ============================================================================
-- SEPARAR POR TIPO — passo 3a (2026-10-08). Base: docs/ENTRADAS-DE-LEADS.md §3.1
-- HOTFIX + modelo: a coluna leads.lead_kind existia só no repo (migration da sala
-- de demo nunca aplicada em produção) e a find_or_create_lead (passo 2) já grava
-- nela → criar lead novo pelas portas plugadas falhava. Aqui a coluna nasce de
-- verdade, com os 4 tipos de pessoa:
--   seller    = quer VENDER/trocar o carro (captação / intermediação)
--   buyer     = quer COMPRAR (totem, site, WhatsApp da loja, stand, Credere…)
--   franchise = lojista/franqueado (recrutamento, sala de demo)
--   contact   = decisor/sócio/indicação — não é lead, só contato de um lead
-- Idempotente: funciona tanto se a coluna não existe (produção) quanto se já
-- existe com o CHECK antigo ('car','franchise') do repo.
-- ============================================================================

-- 1) Coluna (sem default/NOT NULL ainda, pra poder fazer o backfill)
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS lead_kind text;
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_lead_kind_check;
ALTER TABLE public.leads ALTER COLUMN lead_kind DROP NOT NULL;
ALTER TABLE public.leads ALTER COLUMN lead_kind DROP DEFAULT;

-- 2) Backfill — regra por evidência no próprio lead:
--    captado por promotora → seller · já marcado franchise → franchise ·
--    associado (sócio/indicação) → contact · resto → buyer
UPDATE public.leads SET lead_kind = CASE
  WHEN captured_by_member_id IS NOT NULL THEN 'seller'
  WHEN lead_kind = 'franchise'           THEN 'franchise'
  WHEN partner_lead_id IS NOT NULL       THEN 'contact'
  ELSE 'buyer'
END
WHERE lead_kind IS NULL OR lead_kind NOT IN ('seller','buyer','franchise','contact');

-- contato que só existe como decisor em deal_contacts (sem negócio próprio) → contact
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='deal_contacts') THEN
    UPDATE public.leads l SET lead_kind = 'contact'
    WHERE l.lead_kind = 'buyer'
      AND l.captured_by_member_id IS NULL
      AND EXISTS (SELECT 1 FROM public.deal_contacts dc WHERE dc.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.lead_id = l.id);
  END IF;
END $$;

-- 3) Fecha o modelo: default buyer, NOT NULL, CHECK com os 4 tipos, índice por loja+tipo
ALTER TABLE public.leads ALTER COLUMN lead_kind SET DEFAULT 'buyer';
ALTER TABLE public.leads ALTER COLUMN lead_kind SET NOT NULL;
ALTER TABLE public.leads ADD CONSTRAINT leads_lead_kind_check
  CHECK (lead_kind IN ('seller','buyer','franchise','contact'));
CREATE INDEX IF NOT EXISTS leads_tenant_kind_idx ON public.leads(tenant_id, lead_kind);
COMMENT ON COLUMN public.leads.lead_kind IS
  'Tipo de pessoa: seller (quer vender/trocar — captação), buyer (quer comprar), franchise (lojista/franqueado), contact (decisor/sócio — não é lead).';

-- 4) Derivação automática: lead captado por promotora é seller mesmo que a porta
--    não tenha dito (create_capture_lead não passa lead_kind).
CREATE OR REPLACE FUNCTION public.trg_leads_derive_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_kind IS NULL THEN NEW.lead_kind := 'buyer'; END IF;
  IF NEW.captured_by_member_id IS NOT NULL AND NEW.lead_kind = 'buyer' THEN
    NEW.lead_kind := 'seller';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_leads_derive_kind ON public.leads;
CREATE TRIGGER trg_leads_derive_kind
  BEFORE INSERT OR UPDATE OF captured_by_member_id, lead_kind ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_leads_derive_kind();

-- 5) find_or_create_lead passa a aceitar os 4 tipos (default buyer)
CREATE OR REPLACE FUNCTION public.find_or_create_lead(
  p_tenant     uuid,
  p_phone      text,
  p_name       text  DEFAULT NULL,
  p_source     text  DEFAULT NULL,
  p_email      text  DEFAULT NULL,
  p_utm_source text  DEFAULT NULL,
  p_metadata   jsonb DEFAULT '{}'::jsonb,
  p_lead_kind  text  DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phone    text;
  v_name     text := nullif(btrim(p_name), '');
  v_email    text := nullif(lower(btrim(p_email)), '');
  v_existing public.leads%ROWTYPE;
  v_id       uuid;
BEGIN
  IF p_tenant IS NULL OR NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'find_or_create_lead: loja (tenant) inválida: %', p_tenant USING ERRCODE = '23514';
  END IF;
  IF auth.uid() IS NOT NULL
     AND p_tenant IS DISTINCT FROM public.get_tenant_id()
     AND NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'find_or_create_lead: sem acesso a essa loja' USING ERRCODE = '42501';
  END IF;

  v_phone := public.normalize_phone_br(p_phone);
  IF v_phone IS NULL OR length(v_phone) < 10 THEN
    RAISE EXCEPTION 'find_or_create_lead: telefone inválido: %', p_phone USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_tenant::text || ':' || right(v_phone, 8)));

  SELECT * INTO v_existing FROM public.find_lead_by_phone(p_tenant, v_phone);

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.leads SET
      name = CASE
               WHEN v_name IS NOT NULL AND (name IS NULL OR btrim(name) = '' OR name = phone OR name ~ '^\d+$') THEN v_name
               ELSE name END,
      email = coalesce(email, v_email),
      metadata = coalesce(p_metadata, '{}'::jsonb) || coalesce(metadata, '{}'::jsonb),
      last_interaction_at = now()
    WHERE id = v_existing.id;
    RETURN jsonb_build_object('lead_id', v_existing.id, 'created', false, 'phone', v_existing.phone,
                              'tenant_id', p_tenant, 'lead_kind', v_existing.lead_kind);
  END IF;

  INSERT INTO public.leads (tenant_id, name, phone, email, source, utm_source, metadata, lead_kind)
  VALUES (
    p_tenant,
    coalesce(v_name, v_phone),
    v_phone,
    v_email,
    nullif(btrim(p_source), ''),
    nullif(btrim(p_utm_source), ''),
    coalesce(p_metadata, '{}'::jsonb),
    CASE WHEN p_lead_kind IN ('seller','buyer','franchise','contact') THEN p_lead_kind ELSE 'buyer' END
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('lead_id', v_id, 'created', true, 'phone', v_phone, 'tenant_id', p_tenant,
                            'lead_kind', CASE WHEN p_lead_kind IN ('seller','buyer','franchise','contact') THEN p_lead_kind ELSE 'buyer' END);
END;
$$;
