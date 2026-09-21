-- ============================================================================
-- REPASSE POR INDICAÇÃO — Fase A: banco (2026-09-16)
-- Novo ganho da promotora: ela entrega um cartão NFC que leva a uma telinha
-- "Você foi convidado por <promotora>, confirme seu WhatsApp" → registra a
-- indicação (rastreio exato por telefone) → mostra o link do grupo de repasses.
-- Quando essa pessoa COMPRA um carro (venda gerada por dentro, via intermediação),
-- a promotora que a trouxe ganha R$ 150 (idempotente por indicação).
-- Regra de ouro: um telefone conta para UMA promotora (primeira confirmação vence).
-- ============================================================================

-- ─── 1) Código do link da promotora (cartão NFC) ─────────────────────────────
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS repasse_code text;
CREATE UNIQUE INDEX IF NOT EXISTS team_members_repasse_code_idx ON public.team_members(repasse_code) WHERE repasse_code IS NOT NULL;

-- gera/garante o código da promotora (6 chars base36). Admin pode gerar de outra.
CREATE OR REPLACE FUNCTION public.repasse_ensure_code(p_member uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_target uuid; v_code text; v_try int := 0;
BEGIN
  v_target := coalesce(p_member, public.current_member_id());
  IF v_target IS NULL THEN RAISE EXCEPTION 'Sem membro'; END IF;
  IF v_target <> public.current_member_id() AND NOT (public.is_admin() OR public.is_superadmin()) THEN
    RAISE EXCEPTION 'Só admin gera código de outra pessoa';
  END IF;
  SELECT repasse_code INTO v_code FROM team_members WHERE id = v_target;
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'code', v_code); END IF;
  LOOP
    v_try := v_try + 1;
    -- md5(gen_random_uuid) evita depender de gen_random_bytes (pgcrypto fica no schema `extensions` em prod, fora do search_path)
    v_code := lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, 6));
    BEGIN
      UPDATE team_members SET repasse_code = v_code WHERE id = v_target AND repasse_code IS NULL;
      EXIT;
    EXCEPTION WHEN unique_violation THEN IF v_try > 8 THEN RAISE; END IF; END;
  END LOOP;
  SELECT repasse_code INTO v_code FROM team_members WHERE id = v_target;
  RETURN jsonb_build_object('ok', true, 'code', v_code);
END;
$$;
GRANT EXECUTE ON FUNCTION public.repasse_ensure_code(uuid) TO authenticated;

-- ─── 2) Indicações ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.repasse_referrals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  promoter_id    uuid NOT NULL,
  phone          text NOT NULL,                 -- só dígitos, com DDI 55
  name           text,
  status         text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','joined','converted','invalid')),
  buyer_lead_id  uuid,
  reward_ledger_id uuid,
  joined_at      timestamptz,
  converted_at   timestamptz,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)                      -- um telefone = uma promotora (primeira vence)
);
CREATE INDEX IF NOT EXISTS repasse_referrals_promoter_idx ON public.repasse_referrals(tenant_id, promoter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS repasse_referrals_phone_idx ON public.repasse_referrals(phone);
ALTER TABLE public.repasse_referrals ENABLE ROW LEVEL SECURITY;
-- promotora vê as suas; gestor vê as do tenant
DROP POLICY IF EXISTS repasse_referrals_select ON public.repasse_referrals;
CREATE POLICY repasse_referrals_select ON public.repasse_referrals FOR SELECT TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND (NOT public.is_promotora() OR promoter_id = public.current_member_id())));
GRANT SELECT ON public.repasse_referrals TO authenticated;
GRANT ALL ON public.repasse_referrals TO service_role;

-- ─── 3) Config + regra de prêmio (R$ 150) ────────────────────────────────────
INSERT INTO public.config (key, value)
SELECT 'REPASSE_GROUP_LINK', 'https://chat.whatsapp.com/BRF0cC9xd0fDIFYBr90jYp'
WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'REPASSE_GROUP_LINK');
INSERT INTO public.config (key, value) SELECT 'REPASSE_DAILY_GOAL', '5' WHERE NOT EXISTS (SELECT 1 FROM config WHERE key = 'REPASSE_DAILY_GOAL');

-- event_type: adiciona 'repasse_converted'
ALTER TABLE public.capture_reward_rules DROP CONSTRAINT IF EXISTS capture_reward_rules_event_type_check;
ALTER TABLE public.capture_reward_rules ADD CONSTRAINT capture_reward_rules_event_type_check
  CHECK (event_type IN ('lead_validated','vehicle_captured','vehicle_sold','monthly_champion','intermediation_formalized','intermediation_completed','repasse_converted'));
ALTER TABLE public.capture_events DROP CONSTRAINT IF EXISTS capture_events_event_type_check;
ALTER TABLE public.capture_events ADD CONSTRAINT capture_events_event_type_check
  CHECK (event_type IN ('lead_submitted','lead_validated','lead_invalidated','vehicle_captured','vehicle_sold','monthly_champion',
                        'reward_approved','reward_paid','reward_cancelled','intermediation_formalized','intermediation_completed','repasse_converted'));

-- NOTA: a comissão padrão de R$ 150 por indicação convertida foi REMOVIDA do template
-- (decisão do dono). O repasse continua sendo rastreado/convertido, mas sem comissão
-- automática. Para reativar, crie uma regra 'repasse_converted' em capture_reward_rules
-- (ou em Configurações > Prêmios da captação). Removido também via migration
-- 20260922200000_repasse_sem_comissao.sql para bases que já tinham aplicado este seed.
--
-- (INSERT/UPDATE da regra R$150 removidos de propósito.)

-- ─── 4) Registrar o toque/confirmação (chamado pela edge fn pública) ─────────
-- Resolve a promotora pelo código, grava a indicação (dedupe), devolve o link do grupo.
CREATE OR REPLACE FUNCTION public.repasse_track(p_code text, p_phone text, p_name text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m team_members%ROWTYPE; v_phone text; v_existing repasse_referrals%ROWTYPE; v_link text; v_id uuid;
BEGIN
  SELECT * INTO m FROM team_members WHERE repasse_code = lower(btrim(p_code)) AND is_active;
  IF m.id IS NULL THEN RAISE EXCEPTION 'Código inválido'; END IF;
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  IF length(v_phone) IN (10,11) THEN v_phone := '55' || v_phone; END IF;
  IF length(v_phone) < 12 OR length(v_phone) > 13 THEN RAISE EXCEPTION 'WhatsApp inválido'; END IF;
  SELECT value INTO v_link FROM config WHERE key = 'REPASSE_GROUP_LINK';

  SELECT * INTO v_existing FROM repasse_referrals WHERE tenant_id = m.tenant_id AND phone = v_phone;
  IF v_existing.id IS NOT NULL THEN
    -- telefone já indicado: primeira promotora vence; só atualiza nome/toque
    UPDATE repasse_referrals SET name = coalesce(nullif(btrim(p_name),''), name), updated_at = now(),
           meta = meta || jsonb_build_object('last_touch', now(), 'touch_code', p_code)
    WHERE id = v_existing.id;
    RETURN jsonb_build_object('ok', true, 'already', v_existing.promoter_id <> m.id, 'group_link', v_link);
  END IF;

  INSERT INTO repasse_referrals (tenant_id, promoter_id, phone, name, status)
  VALUES (m.tenant_id, m.id, v_phone, nullif(btrim(p_name),''), 'confirmed')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'already', false, 'referral_id', v_id, 'group_link', v_link, 'promoter_name', m.name);
END;
$$;
REVOKE ALL ON FUNCTION public.repasse_track(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repasse_track(text, text, text) TO service_role;

-- ─── 5) Entrou no grupo (chamado pelo webhook do WhatsApp) ────────────────────
CREATE OR REPLACE FUNCTION public.repasse_register_join(p_tenant uuid, p_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_phone text; v_n int;
BEGIN
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  IF length(v_phone) IN (10,11) THEN v_phone := '55' || v_phone; END IF;
  UPDATE repasse_referrals SET status = CASE WHEN status = 'confirmed' THEN 'joined' ELSE status END,
         joined_at = coalesce(joined_at, now()), updated_at = now()
  WHERE tenant_id = p_tenant AND phone = v_phone AND status IN ('confirmed');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'matched', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.repasse_register_join(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repasse_register_join(uuid, text) TO service_role;

-- ─── 6) Conversão → R$ 150 (chamado na conclusão da venda) ───────────────────
-- Casa o telefone do comprador com uma indicação e paga a promotora que a trouxe.
CREATE OR REPLACE FUNCTION public.repasse_convert_for_buyer(p_tenant uuid, p_phone text, p_buyer_lead uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r repasse_referrals%ROWTYPE; v_phone text; ev record; rule capture_reward_rules%ROWTYPE; v_ledger uuid;
BEGIN
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  IF length(v_phone) IN (10,11) THEN v_phone := '55' || v_phone; END IF;
  IF length(v_phone) < 12 THEN RETURN jsonb_build_object('ok', true, 'matched', false); END IF;
  SELECT * INTO r FROM repasse_referrals WHERE tenant_id = p_tenant AND phone = v_phone;
  IF r.id IS NULL OR r.status = 'converted' THEN RETURN jsonb_build_object('ok', true, 'matched', r.id IS NOT NULL, 'already', r.status = 'converted'); END IF;

  SELECT * INTO ev FROM capture_emit_event(p_tenant, r.promoter_id, 'repasse_converted', 'repasse_converted:' || r.id, p_buyer_lead, NULL, NULL);
  IF ev.created THEN
    FOR rule IN SELECT * FROM capture_reward_rules WHERE tenant_id = p_tenant AND active AND event_type = 'repasse_converted' LOOP
      v_ledger := capture_award(rule, r.promoter_id, ev.event_id, p_buyer_lead, capture_period_start('month'),
                                'repasse:' || rule.id || ':' || r.id, rule.name || ' — ' || coalesce(r.name, r.phone));
    END LOOP;
  END IF;
  UPDATE repasse_referrals SET status = 'converted', converted_at = now(), buyer_lead_id = coalesce(p_buyer_lead, buyer_lead_id),
         reward_ledger_id = coalesce(v_ledger, reward_ledger_id), updated_at = now() WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'matched', true, 'promoter_id', r.promoter_id, 'ledger_id', v_ledger);
END;
$$;
REVOKE ALL ON FUNCTION public.repasse_convert_for_buyer(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.repasse_convert_for_buyer(uuid, text, uuid) TO authenticated, service_role;

-- ─── 7) Plugar na conclusão da venda da intermediação ────────────────────────
CREATE OR REPLACE FUNCTION public.intermediation_conclude_sale(p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i intermediations%ROWTYPE; v_vid uuid; v_note text; v_buyer_phone text;
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Sem acesso'; END IF;
  SELECT * INTO i FROM intermediations WHERE id = p_id;
  IF i.id IS NULL OR (i.tenant_id <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Intermediação não encontrada'; END IF;
  IF i.status = 'completed' THEN RETURN jsonb_build_object('ok', true, 'already', true, 'code', i.code); END IF;
  IF i.status <> 'active' THEN RAISE EXCEPTION 'A intermediação precisa estar ativa pra concluir (status %)', i.status; END IF;
  IF i.sale_contract_status NOT IN ('signed', 'imported') THEN RAISE EXCEPTION 'Antes de concluir, o Termo de Compra e Venda precisa estar assinado'; END IF;
  IF i.payment_status <> 'satisfied' THEN RAISE EXCEPTION 'Antes de concluir, confirme o pagamento do comprador'; END IF;
  IF coalesce(i.sale_price, 0) <= 0 THEN RAISE EXCEPTION 'Valor da venda não definido'; END IF;

  UPDATE intermediations SET transfer_status = 'completed', delivered_at = coalesce(delivered_at, now()), updated_by = public.current_member_id() WHERE id = p_id;

  SELECT id INTO v_vid FROM seller_vehicles WHERE lead_id = i.owner_lead_id ORDER BY created_at DESC LIMIT 1;
  IF v_vid IS NULL THEN RAISE EXCEPTION 'Veículo da intermediação não encontrado'; END IF;
  v_note := coalesce(nullif(btrim(p_note), ''), 'Venda concluída pela intermediação ' || i.code);
  PERFORM set_seller_vehicle_status(v_vid, 'vendido', i.sale_price, i.buyer_deal_id, v_note);

  -- Repasse: se o comprador veio de uma indicação por cartão NFC, paga R$ 150 à promotora
  v_buyer_phone := coalesce(nullif(i.buyer_data->>'phone',''), (SELECT phone FROM leads WHERE id = i.buyer_lead_id));
  IF v_buyer_phone IS NOT NULL THEN
    PERFORM public.repasse_convert_for_buyer(i.tenant_id, v_buyer_phone, i.buyer_lead_id);
  END IF;

  PERFORM intermediation_log(p_id, 'sale_concluded', jsonb_build_object('sale_price', i.sale_price, 'buyer_deal_id', i.buyer_deal_id), 'sale_concluded:' || p_id);
  RETURN jsonb_build_object('ok', true, 'code', i.code, 'status', 'completed');
END;
$$;
GRANT EXECUTE ON FUNCTION public.intermediation_conclude_sale(uuid, text) TO authenticated;

-- ─── 8) Painel da promotora (link, meta diária, indicações, ganhos) ──────────
CREATE OR REPLACE FUNCTION public.repasse_my_stats(p_period text DEFAULT 'week')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_tenant uuid := public.get_tenant_id(); v_ps timestamptz; v_today date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_goal int; v_code text;
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro'; END IF;
  v_ps := CASE p_period WHEN 'month' THEN date_trunc('month', now()) WHEN 'all' THEN '2000-01-01'::timestamptz ELSE date_trunc('week', now()) END;
  SELECT coalesce(value::int, 5) INTO v_goal FROM config WHERE key = 'REPASSE_DAILY_GOAL';
  v_goal := coalesce(v_goal, 5);
  SELECT repasse_code INTO v_code FROM team_members WHERE id = v_member;
  RETURN jsonb_build_object(
    'code', v_code, 'group_link', (SELECT value FROM config WHERE key='REPASSE_GROUP_LINK'), 'daily_goal', v_goal,
    'hoje', (SELECT count(*) FROM repasse_referrals WHERE promoter_id = v_member AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = v_today),
    'total_periodo', (SELECT count(*) FROM repasse_referrals WHERE promoter_id = v_member AND created_at >= v_ps),
    'entraram', (SELECT count(*) FROM repasse_referrals WHERE promoter_id = v_member AND status IN ('joined','converted')),
    'converteram', (SELECT count(*) FROM repasse_referrals WHERE promoter_id = v_member AND status = 'converted'),
    'ganho_cents', coalesce((SELECT sum(amount_cents) FROM capture_reward_ledger WHERE promoter_id = v_member AND rule_id IN (SELECT id FROM capture_reward_rules WHERE event_type='repasse_converted') AND status <> 'cancelled'), 0)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.repasse_my_stats(text) TO authenticated;
