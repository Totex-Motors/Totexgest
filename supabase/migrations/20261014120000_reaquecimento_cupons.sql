-- ============================================================================
-- REAQUECIMENTO — cupons de desconto na parcela (2026-10-14)
--
-- Decisão do Marco: o agente de reaquecimento fecha com um CUPOM de desconto na
-- PARCELA, válido por 48 h, honrado pela Grazi (agente financeira, 17 bancos).
-- A Grazi só é avisada quando o lead respondeu e mostrou intenção.
-- Cupom nosso (CRM) ≠ "BONUS1" do Simulador da Cardoso (bônus na troca, lido de
-- formula.json). O agente pode citar os dois quando os dois valerem.
--
-- Aplicar no SQL Editor (CREATE TABLE trava pelo MCP).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reaquecimento_cupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT public.get_tenant_id(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  codigo text NOT NULL UNIQUE,                       -- ex.: TX-7K2M9Q (sem 0/O/1/I)
  desconto_parcela_cents integer NOT NULL CHECK (desconto_parcela_cents > 0),
  carro text,                                        -- carro da conversa (nome falado)
  parcela_base_cents integer,                        -- parcela simulada antes do cupom
  prazo integer,
  simulacao jsonb NOT NULL DEFAULT '{}'::jsonb,      -- saída do simulador-cardoso no momento
  gerado_por text NOT NULL DEFAULT 'agente-reaquecimento',
  valido_ate timestamptz NOT NULL DEFAULT now() + interval '48 hours',
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','usado','expirado','cancelado')),
  grazi_avisada_em timestamptz,
  usado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reaquecimento_cupons_lead_idx ON public.reaquecimento_cupons (lead_id, status);
CREATE INDEX IF NOT EXISTS reaquecimento_cupons_tenant_idx ON public.reaquecimento_cupons (tenant_id, created_at DESC);

ALTER TABLE public.reaquecimento_cupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reaquecimento_cupons_tenant ON public.reaquecimento_cupons;
CREATE POLICY reaquecimento_cupons_tenant ON public.reaquecimento_cupons
  FOR ALL USING (tenant_id = public.get_tenant_id() OR public.is_platform_superadmin())
  WITH CHECK (tenant_id = public.get_tenant_id() OR public.is_platform_superadmin());

-- Gera o código (6 chars sem 0/O/1/I) e grava. 1 cupom ATIVO por lead: gerar de novo
-- cancela o anterior (o cliente sempre tem um código só na mão).
CREATE OR REPLACE FUNCTION public.reaquecimento_gerar_cupom(
  p_lead_id uuid, p_desconto_parcela_cents integer, p_carro text DEFAULT NULL,
  p_parcela_base_cents integer DEFAULT NULL, p_prazo integer DEFAULT NULL,
  p_simulacao jsonb DEFAULT '{}'::jsonb, p_horas integer DEFAULT 48, p_gerado_por text DEFAULT 'agente-reaquecimento'
) RETURNS TABLE(codigo text, valido_ate timestamptz, desconto_parcela_cents integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_cod text; v_alf text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; v_ate timestamptz;
BEGIN
  SELECT l.tenant_id INTO v_tenant FROM leads l WHERE l.id = p_lead_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'lead não encontrado'; END IF;
  IF coalesce(p_desconto_parcela_cents, 0) <= 0 THEN RAISE EXCEPTION 'desconto inválido'; END IF;

  UPDATE reaquecimento_cupons SET status = 'cancelado' WHERE lead_id = p_lead_id AND status = 'ativo';

  LOOP
    v_cod := 'TX-';
    FOR i IN 1..6 LOOP v_cod := v_cod || substr(v_alf, 1 + floor(random() * length(v_alf))::int, 1); END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM reaquecimento_cupons c WHERE c.codigo = v_cod);
  END LOOP;
  v_ate := now() + make_interval(hours => greatest(1, coalesce(p_horas, 48)));

  INSERT INTO reaquecimento_cupons (tenant_id, lead_id, codigo, desconto_parcela_cents, carro, parcela_base_cents, prazo, simulacao, valido_ate, gerado_por)
  VALUES (v_tenant, p_lead_id, v_cod, p_desconto_parcela_cents, p_carro, p_parcela_base_cents, p_prazo, coalesce(p_simulacao, '{}'::jsonb), v_ate, p_gerado_por);

  RETURN QUERY SELECT v_cod, v_ate, p_desconto_parcela_cents;
END $$;
REVOKE ALL ON FUNCTION public.reaquecimento_gerar_cupom(uuid, integer, text, integer, integer, jsonb, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reaquecimento_gerar_cupom(uuid, integer, text, integer, integer, jsonb, integer, text) TO authenticated, service_role;

-- Expira sozinho (cron diário já existente pode chamar; também vale no SELECT da tela)
CREATE OR REPLACE FUNCTION public.reaquecimento_expirar_cupons() RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE reaquecimento_cupons SET status = 'expirado' WHERE status = 'ativo' AND valido_ate < now() RETURNING 1)
  SELECT count(*)::int FROM u;
$$;
