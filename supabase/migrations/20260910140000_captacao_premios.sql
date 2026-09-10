-- ============================================================================
-- Captação — Gamificação: PRÊMIOS por meta (ex.: 40 leads na semana →
-- Voucher Outback R$ 100).
--
--   capture_rewards        — catálogo do tenant (nome, imagem, meta, estoque)
--   capture_reward_claims  — resgates (1 por promotora/prêmio/período)
--   capture_reward_progress() — prêmios ativos + progresso da promotora logada
--   claim_capture_reward()    — resgate validado no servidor (meta + estoque)
--   bucket capture-rewards    — imagens dos prêmios (público)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.capture_rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT public.get_tenant_id(),
  name        text NOT NULL,
  description text,
  image_url   text,
  -- Critério: leads captados na semana | pontos na semana (10/lead + 20/quente) | leads no mês
  goal_type   text NOT NULL DEFAULT 'leads_semana'
              CHECK (goal_type IN ('leads_semana', 'pontos_semana', 'leads_mes')),
  goal_value  integer NOT NULL CHECK (goal_value > 0),
  stock       integer CHECK (stock IS NULL OR stock >= 0),   -- NULL = ilimitado
  is_active   boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capture_rewards_tenant_idx ON public.capture_rewards(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS public.capture_reward_claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  reward_id      uuid NOT NULL REFERENCES public.capture_rewards(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL REFERENCES public.team_members(id) ON DELETE CASCADE,
  period_start   date NOT NULL,
  achieved_value integer,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  delivered_by   uuid REFERENCES public.team_members(id) ON DELETE SET NULL,
  UNIQUE (reward_id, member_id, period_start)
);
CREATE INDEX IF NOT EXISTS capture_reward_claims_tenant_idx ON public.capture_reward_claims(tenant_id, status);

DO $$ BEGIN
  CREATE TRIGGER update_capture_rewards_updated_at BEFORE UPDATE ON public.capture_rewards
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.capture_rewards, public.capture_reward_claims TO authenticated, service_role;
ALTER TABLE public.capture_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_reward_claims ENABLE ROW LEVEL SECURITY;

-- Prêmios: todo o tenant vê (promotora inclusive); escreve admin.
DROP POLICY IF EXISTS capture_rewards_select ON public.capture_rewards;
CREATE POLICY capture_rewards_select ON public.capture_rewards
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() OR public.is_superadmin());
DROP POLICY IF EXISTS capture_rewards_write ON public.capture_rewards;
CREATE POLICY capture_rewards_write ON public.capture_rewards
  FOR ALL TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- Resgates: promotora vê só os dela; gestor vê todos e marca entregue. Criação só via RPC.
DROP POLICY IF EXISTS capture_reward_claims_select ON public.capture_reward_claims;
CREATE POLICY capture_reward_claims_select ON public.capture_reward_claims
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() OR public.is_superadmin())
         AND (NOT public.is_promotora() OR member_id = public.current_member_id()));
DROP POLICY IF EXISTS capture_reward_claims_update ON public.capture_reward_claims;
CREATE POLICY capture_reward_claims_update ON public.capture_reward_claims
  FOR UPDATE TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin())
  WITH CHECK ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- Bucket público das imagens (mesmo padrão do email-assets)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('capture-rewards', 'capture-rewards', true, 5242880)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                 AND policyname = 'capture_rewards_authenticated_all') THEN
    CREATE POLICY capture_rewards_authenticated_all ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id = 'capture-rewards') WITH CHECK (bucket_id = 'capture-rewards');
  END IF;
END $$;

-- ─── Progresso da promotora num critério ───────────────────────────────────
-- Retorna (period_start, value). Semana/mês no fuso de São Paulo.
CREATE OR REPLACE FUNCTION public.capture_member_progress(p_member uuid, p_goal_type text)
RETURNS TABLE (period_start date, value integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start timestamptz;
  v_leads integer;
  v_quentes integer;
BEGIN
  v_start := CASE WHEN p_goal_type = 'leads_mes'
    THEN date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
    ELSE date_trunc('week',  now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' END;

  SELECT count(*), count(*) FILTER (WHERE seller_qualification->>'temperatura' = 'quente')
    INTO v_leads, v_quentes
  FROM leads WHERE captured_by_member_id = p_member AND captured_at >= v_start;

  period_start := (v_start AT TIME ZONE 'America/Sao_Paulo')::date;
  value := CASE p_goal_type WHEN 'pontos_semana' THEN v_leads * 10 + v_quentes * 20 ELSE v_leads END;
  RETURN NEXT;
END;
$$;

-- ─── Prêmios ativos + progresso (tela da promotora) ────────────────────────
CREATE OR REPLACE FUNCTION public.capture_reward_progress(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  id uuid, name text, description text, image_url text,
  goal_type text, goal_value integer, stock integer,
  current_value integer, period_start date, eligible boolean,
  claim_id uuid, claim_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid := public.current_member_id();
  v_target uuid;
  v_tenant uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin())
                   THEN p_member_id ELSE v_member END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE team_members.id = v_target;

  RETURN QUERY
  SELECT r.id, r.name, r.description, r.image_url, r.goal_type, r.goal_value, r.stock,
         p.value, p.period_start,
         (p.value >= r.goal_value AND (r.stock IS NULL OR r.stock > 0)) AS eligible,
         c.id, c.status
  FROM capture_rewards r
  CROSS JOIN LATERAL public.capture_member_progress(v_target, r.goal_type) p
  LEFT JOIN capture_reward_claims c
         ON c.reward_id = r.id AND c.member_id = v_target AND c.period_start = p.period_start
  WHERE r.tenant_id = v_tenant AND r.is_active
  ORDER BY r.position, r.goal_value, r.created_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_member_progress(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.capture_reward_progress(uuid) TO authenticated;

-- ─── Resgate (validado no servidor) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_capture_reward(p_reward_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member uuid := public.current_member_id();
  v_tenant uuid;
  v_reward capture_rewards%ROWTYPE;
  v_prog record;
  v_claim capture_reward_claims%ROWTYPE;
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro ativo'; END IF;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_member;

  SELECT * INTO v_reward FROM capture_rewards WHERE id = p_reward_id AND tenant_id = v_tenant AND is_active;
  IF v_reward.id IS NULL THEN RAISE EXCEPTION 'Prêmio não encontrado ou inativo'; END IF;

  SELECT * INTO v_prog FROM public.capture_member_progress(v_member, v_reward.goal_type);
  IF v_prog.value < v_reward.goal_value THEN
    RAISE EXCEPTION 'Meta ainda não atingida (% de %)', v_prog.value, v_reward.goal_value;
  END IF;

  SELECT * INTO v_claim FROM capture_reward_claims
  WHERE reward_id = p_reward_id AND member_id = v_member AND period_start = v_prog.period_start;
  IF v_claim.id IS NOT NULL THEN
    RETURN jsonb_build_object('claim_id', v_claim.id, 'status', v_claim.status, 'already', true);
  END IF;

  IF v_reward.stock IS NOT NULL THEN
    IF v_reward.stock <= 0 THEN RAISE EXCEPTION 'Prêmio esgotado'; END IF;
    UPDATE capture_rewards SET stock = stock - 1 WHERE id = p_reward_id;
  END IF;

  INSERT INTO capture_reward_claims (tenant_id, reward_id, member_id, period_start, achieved_value)
  VALUES (v_tenant, p_reward_id, v_member, v_prog.period_start, v_prog.value)
  RETURNING * INTO v_claim;

  RETURN jsonb_build_object('claim_id', v_claim.id, 'status', v_claim.status, 'already', false,
                            'reward', v_reward.name);
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_capture_reward(uuid) TO authenticated;

-- ─── Seed: Voucher Outback (Totex Motors) — meta semanal de 40 leads ───────
INSERT INTO public.capture_rewards (tenant_id, name, description, image_url, goal_type, goal_value, stock, is_active)
SELECT 'c13681e3-5db9-48d1-9c5c-856e6041d77f', 'Voucher Outback R$ 100,00',
       'Prêmio pra promotora que bater a meta semanal de 40 clientes captados.',
       '/rewards/outback-vale-presente.jpg', 'leads_semana', 40, 25, true
WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f')
  AND NOT EXISTS (SELECT 1 FROM public.capture_rewards
                  WHERE tenant_id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f' AND name ILIKE 'Voucher Outback%');
