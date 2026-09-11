-- ============================================================================
-- Captação — jornada do carro com VALIDAÇÃO REAL (2026-09-11)
--
-- Problema: "Anunciado", "Negociação" e "Vendido" eram um <select> manual no
-- detalhe do lead, sem fonte de verdade. Esta migration liga cada etapa a um
-- fato verificável:
--
--   • Anunciado  ← o carro aparece no estoque da loja no marketplace Totex
--                  (cron `capture-listings` 2×/dia → edge fn capture-listing-sync
--                  → capture_listing_sync_apply). Guarda id/link/preço do anúncio.
--                  Sumiu do anúncio por 2 checagens seguidas → tarefa pro
--                  especialista ("vendeu ou tirou?").
--   • Negociação ← negócio do COMPRADOR (lead com metadata.vehicle.id = id do
--                  anúncio) entra em Proposta/Negociação/Financiamento.
--   • Vendido    ← (a) negócio do comprador fecha como Ganho (automático), ou
--                  (b) time comercial marca na mão, mas agora é OBRIGATÓRIO
--                  informar valor + vincular o negócio do comprador OU descrever
--                  a venda. Quem marcou fica gravado. O bônus de venda nasce
--                  PENDENTE com a evidência na observação → gestor aprova em
--                  Configurações › Prêmios › Aprovações (validação dupla).
--
-- Config nova em capture_handoff_config: marketplace_store_id (loja no
-- marketplace), listing_sync_enabled, listing_last_sync_at/_result.
-- ============================================================================

-- ─── 1) Colunas ──────────────────────────────────────────────────────────────
ALTER TABLE public.seller_vehicles
  ADD COLUMN IF NOT EXISTS marketplace_vehicle_id  text,
  ADD COLUMN IF NOT EXISTS listing_url             text,
  ADD COLUMN IF NOT EXISTS listing_price           numeric,
  ADD COLUMN IF NOT EXISTS listing_first_seen_at   timestamptz,
  ADD COLUMN IF NOT EXISTS listing_last_seen_at    timestamptz,
  ADD COLUMN IF NOT EXISTS listing_missing_since   timestamptz,
  ADD COLUMN IF NOT EXISTS listing_checked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS listing_alert_task_id   uuid,
  ADD COLUMN IF NOT EXISTS sold_deal_id            uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sold_note               text,
  ADD COLUMN IF NOT EXISTS sold_marked_by          uuid REFERENCES public.team_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS seller_vehicles_tenant_status_idx ON public.seller_vehicles(tenant_id, status);
CREATE INDEX IF NOT EXISTS seller_vehicles_marketplace_idx ON public.seller_vehicles(tenant_id, marketplace_vehicle_id)
  WHERE marketplace_vehicle_id IS NOT NULL;

ALTER TABLE public.capture_handoff_config
  ADD COLUMN IF NOT EXISTS marketplace_store_id     text,
  ADD COLUMN IF NOT EXISTS listing_sync_enabled     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS listing_last_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS listing_last_sync_result text;

-- R$ no padrão brasileiro (to_char usa vírgula como separador de milhar em C locale)
CREATE OR REPLACE FUNCTION public.capture_fmt_brl(p numeric, p_cents boolean DEFAULT true) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p IS NULL THEN NULL
              WHEN p_cents THEN 'R$ ' || translate(to_char(p, 'FM999G999G999G990D00'), ',.', '.,')
              ELSE 'R$ ' || translate(to_char(p, 'FM999G999G999G990'), ',.', '.,') END;
$$;

-- ─── 2) Sync do anúncio (chamado pela edge fn com service_role) ──────────────
-- Retorna a ação tomada: anunciado | seen | not_listed | missing_1 | missing |
-- alert | ignored.
CREATE OR REPLACE FUNCTION public.capture_listing_sync_apply(
  p_vehicle_id uuid, p_found boolean, p_marketplace_id text DEFAULT NULL,
  p_url text DEFAULT NULL, p_price numeric DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v seller_vehicles%ROWTYPE; l record; v_task uuid; v_desc text;
BEGIN
  SELECT * INTO v FROM seller_vehicles WHERE id = p_vehicle_id;
  IF v.id IS NULL THEN RETURN 'ignored'; END IF;
  SELECT id, tenant_id, name, sales_rep_id, captured_by_member_id INTO l FROM leads WHERE id = v.lead_id;
  IF l.captured_by_member_id IS NULL THEN RETURN 'ignored'; END IF;
  v_desc := coalesce(v.description, nullif(concat_ws(' ', v.brand, v.model), ''), 'veículo') || coalesce(' ' || v.year_model::text, '');

  IF p_found THEN
    UPDATE seller_vehicles SET
      marketplace_vehicle_id = coalesce(p_marketplace_id, marketplace_vehicle_id),
      listing_url            = coalesce(p_url, listing_url),
      listing_price          = coalesce(p_price, listing_price),
      listing_first_seen_at  = coalesce(listing_first_seen_at, now()),
      listing_last_seen_at   = now(),
      listing_missing_since  = NULL,
      listing_checked_at     = now()
    WHERE id = v.id;
    IF v.status IN ('captado', 'preparacao') THEN
      UPDATE seller_vehicles SET status = 'anunciado', status_changed_at = now() WHERE id = v.id;
      RETURN 'anunciado';
    END IF;
    RETURN 'seen';
  END IF;

  -- não achou no estoque
  UPDATE seller_vehicles SET listing_checked_at = now() WHERE id = v.id;
  IF v.status <> 'anunciado' THEN RETURN 'not_listed'; END IF;
  IF v.listing_missing_since IS NULL THEN
    UPDATE seller_vehicles SET listing_missing_since = now() WHERE id = v.id;
    RETURN 'missing_1';
  END IF;
  -- 2ª checagem seguida sem o anúncio (≥ 8h) → tarefa pro especialista, uma vez só
  IF v.listing_alert_task_id IS NULL AND now() - v.listing_missing_since >= interval '8 hours' THEN
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed,
      due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (l.tenant_id, 'Carro captado sumiu do anúncio: ' || v_desc || ' — vendeu ou tirou?',
      'O anúncio de ' || v_desc || ' (captado por promotora, cliente ' || coalesce(l.name, '?') || ') não aparece mais no estoque do marketplace desde '
        || to_char(v.listing_missing_since AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')
        || '. Se vendeu: abra o lead › aba Comercial › card Captação e marque VENDIDO (valor + negócio do comprador). Se só tirou do ar, marque Em preparação.',
      'follow_up', 'high', 'not_started', false, now(), l.id, l.sales_rep_id, 'sales', 'captacao', l.id,
      jsonb_build_object('captacao', true, 'listing_missing', true, 'vehicle_id', v.id))
    RETURNING id INTO v_task;
    UPDATE seller_vehicles SET listing_alert_task_id = v_task WHERE id = v.id;
    RETURN 'alert';
  END IF;
  RETURN 'missing';
END;
$$;
REVOKE ALL ON FUNCTION public.capture_listing_sync_apply(uuid, boolean, text, text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_listing_sync_apply(uuid, boolean, text, text, numeric) TO service_role;

-- ─── 3) Marcar status na mão: Vendido exige evidência ────────────────────────
DROP FUNCTION IF EXISTS public.set_seller_vehicle_status(uuid, text, numeric);
CREATE OR REPLACE FUNCTION public.set_seller_vehicle_status(
  p_vehicle_id uuid, p_status text, p_sold_price numeric DEFAULT NULL,
  p_sold_deal_id uuid DEFAULT NULL, p_sold_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_tenant uuid; v_lead uuid; v_deal record; v_note text := nullif(trim(coalesce(p_sold_note, '')), '');
BEGIN
  IF public.is_promotora() THEN RAISE EXCEPTION 'Promotora não altera status do veículo'; END IF;
  SELECT tenant_id, lead_id INTO v_tenant, v_lead FROM seller_vehicles WHERE id = p_vehicle_id;
  IF v_tenant IS NULL OR (v_tenant <> public.get_tenant_id() AND NOT public.is_superadmin()) THEN RAISE EXCEPTION 'Veículo não encontrado'; END IF;
  IF p_status NOT IN ('lead', 'avaliacao', 'captado', 'preparacao', 'anunciado', 'negociacao', 'vendido', 'perdido') THEN
    RAISE EXCEPTION 'Status inválido: %', p_status;
  END IF;

  IF p_status = 'vendido' THEN
    IF coalesce(p_sold_price, 0) <= 0 THEN RAISE EXCEPTION 'Informe o valor da venda'; END IF;
    IF p_sold_deal_id IS NULL AND (v_note IS NULL OR length(v_note) < 3) THEN
      RAISE EXCEPTION 'Vincule o negócio do comprador ou descreva a venda (comprador / nº do documento)';
    END IF;
    IF p_sold_deal_id IS NOT NULL THEN
      SELECT id, lead_id, tenant_id INTO v_deal FROM deals WHERE id = p_sold_deal_id;
      IF v_deal.id IS NULL OR v_deal.tenant_id <> v_tenant THEN RAISE EXCEPTION 'Negócio do comprador não encontrado'; END IF;
      IF v_deal.lead_id = v_lead THEN RAISE EXCEPTION 'Esse negócio é do próprio dono do carro — vincule o negócio do COMPRADOR'; END IF;
    END IF;
  END IF;

  UPDATE seller_vehicles SET
    status            = p_status,
    status_changed_at = now(),
    captured_at       = CASE WHEN p_status = 'captado' THEN coalesce(captured_at, now()) ELSE captured_at END,
    sold_price        = CASE WHEN p_status = 'vendido' THEN coalesce(p_sold_price, sold_price) ELSE sold_price END,
    sold_deal_id      = CASE WHEN p_status = 'vendido' THEN coalesce(p_sold_deal_id, sold_deal_id) ELSE sold_deal_id END,
    sold_note         = CASE WHEN p_status = 'vendido' THEN coalesce(v_note, sold_note) ELSE sold_note END,
    sold_marked_by    = CASE WHEN p_status = 'vendido' THEN public.current_member_id() ELSE sold_marked_by END
  WHERE id = p_vehicle_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_seller_vehicle_status(uuid, text, numeric, uuid, text) TO authenticated;

-- ─── 4) Status do carro → evento/prêmio (agora com evidência da venda) ───────
CREATE OR REPLACE FUNCTION public.trg_capture_vehicle_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  l record; ev record; r capture_reward_rules%ROWTYPE; v_desc text; v_ledger uuid;
  v_evidence text; v_deal_title text; v_buyer text; v_marker text;
BEGIN
  SELECT id, tenant_id, name, captured_by_member_id, capture_campaign_id INTO l FROM leads WHERE id = NEW.lead_id;
  IF l.captured_by_member_id IS NULL THEN RETURN NEW; END IF;
  v_desc := coalesce(NEW.description, nullif(concat_ws(' ', NEW.brand, NEW.model), ''), 'veículo') || coalesce(' ' || NEW.year_model::text, '');

  IF NEW.status = 'captado' AND OLD.status IS DISTINCT FROM 'captado' THEN
    SELECT * INTO ev FROM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'vehicle_captured', 'vehicle_captured:' || NEW.lead_id, NEW.lead_id, NULL, NEW.id);
    IF ev.created THEN
      FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = l.tenant_id AND active AND event_type = 'vehicle_captured'
               AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
        PERFORM capture_award(r, l.captured_by_member_id, ev.event_id, NEW.lead_id, capture_period_start('month'),
                              'rule:' || r.id || ':lead:' || NEW.lead_id, r.name || ' — ' || v_desc);
      END LOOP;
    END IF;

  ELSIF NEW.status = 'vendido' AND OLD.status IS DISTINCT FROM 'vendido' THEN
    UPDATE seller_vehicles SET sold_at = coalesce(sold_at, now()) WHERE id = NEW.id AND sold_at IS NULL;

    -- Evidência da venda (vai pra observação do lançamento → gestor vê na aprovação)
    v_evidence := 'Venda ' || coalesce(capture_fmt_brl(NEW.sold_price), 'sem valor informado');
    IF NEW.sold_deal_id IS NOT NULL THEN
      SELECT d.title, lb.name INTO v_deal_title, v_buyer FROM deals d LEFT JOIN leads lb ON lb.id = d.lead_id WHERE d.id = NEW.sold_deal_id;
      v_evidence := v_evidence || ' · negócio: ' || coalesce(v_deal_title, '?') || coalesce(' (comprador: ' || v_buyer || ')', '');
    END IF;
    IF NEW.sold_note IS NOT NULL THEN v_evidence := v_evidence || ' · ' || NEW.sold_note; END IF;
    IF NEW.sold_marked_by IS NOT NULL THEN
      SELECT name INTO v_marker FROM team_members WHERE id = NEW.sold_marked_by;
      v_evidence := v_evidence || ' · marcado por ' || coalesce(v_marker, '?');
    ELSE
      v_evidence := v_evidence || ' · automático (negócio do comprador fechado como Ganho)';
    END IF;

    SELECT * INTO ev FROM capture_emit_event(l.tenant_id, l.captured_by_member_id, 'vehicle_sold', 'vehicle_sold:' || NEW.lead_id, NEW.lead_id, NEW.sold_deal_id, NEW.id,
                                             jsonb_build_object('sold_price', NEW.sold_price, 'evidence', v_evidence));
    IF ev.created THEN
      PERFORM capture_add_event(NEW.lead_id, 'sold', '🎉 VENDEU! ' || v_desc, 'O carro que você captou foi vendido.');
      FOR r IN SELECT * FROM capture_reward_rules WHERE tenant_id = l.tenant_id AND active AND event_type = 'vehicle_sold'
               AND (campaign_id IS NULL OR campaign_id = l.capture_campaign_id) LOOP
        v_ledger := capture_award(r, l.captured_by_member_id, ev.event_id, NEW.lead_id, capture_period_start('month'),
                                  'rule:' || r.id || ':lead:' || NEW.lead_id, r.name || ' — ' || v_desc);
        IF v_ledger IS NOT NULL THEN UPDATE capture_reward_ledger SET note = v_evidence WHERE id = v_ledger; END IF;
      END LOOP;
    END IF;

  ELSIF NEW.status = 'anunciado' AND OLD.status IS DISTINCT FROM 'anunciado' THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', '📢 ' || v_desc || ' foi anunciado!',
      'Já está no site da Totex' || coalesce(' por ' || capture_fmt_brl(NEW.listing_price, false), '') || '. Agora é atrair comprador.');
  ELSIF NEW.status = 'negociacao' AND OLD.status IS DISTINCT FROM 'negociacao' THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', '🤝 ' || v_desc || ' em negociação', 'Tem comprador interessado e proposta na mesa.');
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM capture_add_event(NEW.lead_id, 'stage', v_desc || ' → ' || initcap(NEW.status), NULL);
  END IF;
  RETURN NEW;
END;
$$;

-- ─── 5) Negócio do COMPRADOR move o carro captado ───────────────────────────
-- Lead comprador tem metadata.vehicle.id (id do anúncio no marketplace — gravado
-- pelo webhook do marketplace / stand-handoff / "Vincular veículo de interesse").
CREATE OR REPLACE FUNCTION public.trg_capture_buyer_deal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s record; v_mkt text; v_captured uuid; v record;
BEGIN
  SELECT l.captured_by_member_id, coalesce(NEW.metadata->'vehicle'->>'id', l.metadata->'vehicle'->>'id')
    INTO v_captured, v_mkt FROM leads l WHERE l.id = NEW.lead_id;
  IF v_mkt IS NULL OR v_mkt = '' THEN RETURN NEW; END IF;
  SELECT * INTO v FROM seller_vehicles
   WHERE tenant_id = NEW.tenant_id AND marketplace_vehicle_id = v_mkt AND lead_id <> NEW.lead_id
     AND status IN ('anunciado', 'negociacao')
   ORDER BY created_at DESC LIMIT 1;
  IF v.id IS NULL THEN RETURN NEW; END IF;
  SELECT name, is_won INTO s FROM sales_pipeline_stages WHERE id = NEW.pipeline_stage_id;

  IF coalesce(s.is_won, false) THEN
    UPDATE seller_vehicles SET
      status = 'vendido', status_changed_at = now(), sold_deal_id = NEW.id,
      sold_price = coalesce(NEW.negotiated_price, NEW.original_price, sold_price, listing_price)
    WHERE id = v.id;
  ELSIF v.status = 'anunciado' AND (s.name ILIKE '%propost%' OR s.name ILIKE '%negocia%' OR s.name ILIKE '%financ%') THEN
    UPDATE seller_vehicles SET status = 'negociacao', status_changed_at = now() WHERE id = v.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_buyer_deal ON public.deals;
CREATE TRIGGER trg_capture_buyer_deal AFTER UPDATE OF pipeline_stage_id ON public.deals
  FOR EACH ROW WHEN (OLD.pipeline_stage_id IS DISTINCT FROM NEW.pipeline_stage_id)
  EXECUTE FUNCTION public.trg_capture_buyer_deal();

-- ─── 6) Lista da promotora: link do anúncio ──────────────────────────────────
DROP FUNCTION IF EXISTS public.list_my_capture_vehicles(uuid);
CREATE OR REPLACE FUNCTION public.list_my_capture_vehicles(p_member_id uuid DEFAULT NULL)
RETURNS TABLE (
  vehicle_id uuid, lead_id uuid, lead_name text, description text, brand text, model text, year_model integer, km integer,
  status text, status_changed_at timestamptz, captured_at timestamptz, sold_at timestamptz,
  stage_name text, sales_rep_name text, reward_captured_cents integer, reward_sold_cents integer,
  ledger_captured_status text, ledger_sold_status text,
  listing_url text, listing_price numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_target uuid; v_tenant uuid;
BEGIN
  IF v_member IS NULL THEN RETURN; END IF;
  v_target := CASE WHEN p_member_id IS NOT NULL AND (public.is_admin() OR public.is_superadmin()) THEN p_member_id ELSE v_member END;
  SELECT tenant_id INTO v_tenant FROM team_members WHERE id = v_target;
  RETURN QUERY
  SELECT v.id, l.id, l.name, v.description, v.brand, v.model, v.year_model, v.km,
         v.status, v.status_changed_at, v.captured_at, v.sold_at,
         s.name, tm.name,
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'vehicle_captured' ORDER BY position LIMIT 1),
         (SELECT amount_cents FROM capture_reward_rules WHERE tenant_id = v_tenant AND active AND event_type = 'vehicle_sold' ORDER BY position LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type = 'vehicle_captured' ORDER BY lg.earned_at DESC LIMIT 1),
         (SELECT lg.status FROM capture_reward_ledger lg JOIN capture_reward_rules rr ON rr.id = lg.rule_id
           WHERE lg.lead_id = l.id AND rr.event_type = 'vehicle_sold' ORDER BY lg.earned_at DESC LIMIT 1),
         v.listing_url, v.listing_price
  FROM leads l
  JOIN LATERAL (SELECT * FROM seller_vehicles sv WHERE sv.lead_id = l.id ORDER BY sv.created_at DESC LIMIT 1) v ON true
  LEFT JOIN sales_pipeline_stages s ON s.id = l.pipeline_stage_id
  LEFT JOIN team_members tm ON tm.id = l.sales_rep_id
  WHERE l.captured_by_member_id = v_target
  ORDER BY CASE v.status WHEN 'vendido' THEN 0 WHEN 'negociacao' THEN 1 WHEN 'anunciado' THEN 2 WHEN 'preparacao' THEN 3 WHEN 'captado' THEN 4 WHEN 'avaliacao' THEN 5 ELSE 6 END,
           coalesce(v.status_changed_at, v.created_at) DESC;
END;
$$;
GRANT EXECUTE ON FUNCTION public.list_my_capture_vehicles(uuid) TO authenticated;

-- ─── 7) Cron: 2×/dia (08h e 18h BRT = 11h e 21h UTC) ─────────────────────────
DO $$
DECLARE v_url text; v_cmd text; j record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron ausente — cron capture-listings não agendado (ambiente local?)';
    RETURN;
  END IF;
  SELECT value INTO v_url FROM public.config WHERE key = 'SUPABASE_PROJECT_URL';
  v_url := rtrim(coalesce(v_url, ''), '/');
  IF v_url = '' OR v_url NOT LIKE 'http%' THEN
    RAISE WARNING 'SUPABASE_PROJECT_URL ausente — cron capture-listings NAO agendado.';
    RETURN;
  END IF;
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'capture-listings' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
  v_cmd := format(
    $f$SELECT net.http_post(url := %L, headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"mode":"listings"}'::jsonb)$f$,
    v_url || '/functions/v1/capture-listing-sync');
  PERFORM cron.schedule('capture-listings', '0 11,21 * * *', v_cmd);
END $$;
