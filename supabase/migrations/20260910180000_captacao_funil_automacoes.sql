-- ============================================================================
-- Captação — funil único (Captação Tamboré) + automações de etapa.
--
-- 1) Reorganiza as etapas do "Captação Tamboré" (Totex Motors):
--    Nova Captação → Contato feito → Avaliação agendada → Veio na loja / fotos
--    → Proposta → Nutrição (não agendou) → Ganho | Perdido
--    (só renomeia/reordena — ids preservados, nenhum lead/deal perdido)
-- 2) Lead da promotora passa a ter DEAL no funil (o Kanban é por deals):
--    capture_handoff cria o deal; deals.pipeline_stage_id é a fonte da verdade
--    e o trigger sync_lead_from_deal (já existente) espelha em leads.
-- 3) capture_move_stage(lead, 'padrão%'): move só pra frente, por nome.
-- 4) Automações:
--    - 1º contato (WhatsApp enviado / tarefa concluída) → "Contato feito"
--    - tarefa de avaliação/visita/reunião agendada        → "Avaliação agendada"
--    - tarefa de avaliação/visita/fotos concluída          → "Veio na loja / fotos"
--    - tarefa do tipo proposta                             → "Proposta"
--    - 3 dias em "Contato feito" sem agendamento           → tarefa de follow-up
--      (capture_stale_followups, chamada pelo cron do SLA) + aviso no grupo
-- 5) Corrige capture_handoff: company_activities.source_id é uuid.
-- ============================================================================

-- ─── 1) Etapas do Captação Tamboré ─────────────────────────────────────────
DO $$
DECLARE v_pipe uuid := '4fa600e7-cafe-4fa8-8c9b-379e791ad726';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM sales_pipelines WHERE id = v_pipe) THEN RETURN; END IF;

  -- tira todo mundo do caminho antes de reposicionar
  UPDATE sales_pipeline_stages SET position = position + 100 WHERE pipeline_id = v_pipe;

  UPDATE sales_pipeline_stages SET position = 1, color = 'slate'
    WHERE pipeline_id = v_pipe AND name = 'Nova Captação';
  UPDATE sales_pipeline_stages SET position = 2, name = 'Contato feito', color = 'amber',
    description = 'Especialista fez o 1º contato (WhatsApp/ligação). Automático.'
    WHERE pipeline_id = v_pipe AND name IN ('1° Contato Cliente', '1º Contato Cliente');
  UPDATE sales_pipeline_stages SET position = 3, name = 'Avaliação agendada', color = 'blue',
    description = 'Avaliação/visita marcada. Automático ao criar tarefa de avaliação com data.'
    WHERE pipeline_id = v_pipe AND name = 'Agendou';
  UPDATE sales_pipeline_stages SET position = 4, name = 'Veio na loja / fotos', color = 'yellow',
    description = 'Cliente compareceu; carro avaliado/fotografado. Automático ao concluir a tarefa.'
    WHERE pipeline_id = v_pipe AND name = 'Veio loja P/ fotos';
  IF NOT EXISTS (SELECT 1 FROM sales_pipeline_stages WHERE pipeline_id = v_pipe AND name = 'Proposta') THEN
    INSERT INTO sales_pipeline_stages (tenant_id, pipeline_id, name, position, color, description)
    SELECT tenant_id, v_pipe, 'Proposta', 5, 'orange', 'Proposta de intermediação/consignação apresentada.'
    FROM sales_pipelines WHERE id = v_pipe;
  ELSE
    UPDATE sales_pipeline_stages SET position = 5 WHERE pipeline_id = v_pipe AND name = 'Proposta';
  END IF;
  UPDATE sales_pipeline_stages SET position = 6, name = 'Nutrição (não agendou)', color = 'purple',
    description = 'Não quis agendar agora. Fica em nutrição até reaquecer.'
    WHERE pipeline_id = v_pipe AND name = 'Não Agendou';
  UPDATE sales_pipeline_stages SET position = 7, is_won = true  WHERE pipeline_id = v_pipe AND name = 'Ganho';
  UPDATE sales_pipeline_stages SET position = 8, is_lost = true WHERE pipeline_id = v_pipe AND name = 'Perdido';

  -- qualquer etapa que sobrou (não prevista) vai pro fim, na ordem antiga
  UPDATE sales_pipeline_stages SET position = position - 100 + 10
    WHERE pipeline_id = v_pipe AND position > 100;
END $$;

-- ─── 3) Mover etapa por nome (só pra frente) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_move_stage(p_lead_id uuid, p_pattern text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deal_id uuid;
  v_stage uuid;
  v_pipeline uuid;
  v_cur_pos integer;
  v_cur_won boolean;
  v_cur_lost boolean;
  v_target_id uuid;
  v_target_pos integer;
BEGIN
  SELECT d.id, d.pipeline_stage_id, d.pipeline_id INTO v_deal_id, v_stage, v_pipeline
  FROM deals d WHERE d.lead_id = p_lead_id AND d.status = 'negotiation'
  ORDER BY d.updated_at DESC LIMIT 1;

  IF v_deal_id IS NULL THEN
    SELECT pipeline_stage_id INTO v_stage FROM leads WHERE id = p_lead_id;
  END IF;
  IF v_stage IS NULL THEN RETURN false; END IF;

  SELECT coalesce(v_pipeline, s.pipeline_id), s.position, coalesce(s.is_won, false), coalesce(s.is_lost, false)
    INTO v_pipeline, v_cur_pos, v_cur_won, v_cur_lost
  FROM sales_pipeline_stages s WHERE s.id = v_stage;
  IF v_pipeline IS NULL OR v_cur_won OR v_cur_lost THEN RETURN false; END IF;

  SELECT id, position INTO v_target_id, v_target_pos FROM sales_pipeline_stages
  WHERE pipeline_id = v_pipeline AND name ILIKE p_pattern
  ORDER BY position LIMIT 1;
  IF v_target_id IS NULL OR v_target_pos <= coalesce(v_cur_pos, 0) THEN RETURN false; END IF;

  IF v_deal_id IS NOT NULL THEN
    UPDATE deals SET pipeline_stage_id = v_target_id, updated_at = now() WHERE id = v_deal_id;  -- sync_lead_from_deal espelha no lead
  ELSE
    UPDATE leads SET pipeline_stage_id = v_target_id WHERE id = p_lead_id;
  END IF;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_move_stage(uuid, text) TO authenticated;

-- ─── 2/5) capture_handoff: source_id uuid + cria o deal no funil ───────────
CREATE OR REPLACE FUNCTION public.capture_handoff(p_lead_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead leads%ROWTYPE;
  v_cfg capture_handoff_config%ROWTYPE;
  v_temp text;
  v_specialist uuid;
  v_spec_name text;
  v_promotora_name text;
  v_vehicle record;
  v_sla integer;
  v_task_id uuid;
  v_task_name text;
  v_priority text;
  v_due timestamptz;
  v_desc text;
  v_url text;
  v_q jsonb;
  v_stage uuid;
  v_pipeline uuid;
  v_deal_id uuid;
  v_veic text;
BEGIN
  SELECT * INTO v_lead FROM leads WHERE id = p_lead_id;
  IF v_lead.id IS NULL OR v_lead.captured_by_member_id IS NULL THEN
    RETURN jsonb_build_object('assigned', false, 'reason', 'not_capture_lead');
  END IF;
  IF v_lead.handoff_at IS NOT NULL AND NOT p_force THEN
    RETURN jsonb_build_object('assigned', v_lead.handoff_member_id IS NOT NULL,
                              'specialist_id', v_lead.handoff_member_id,
                              'status', v_lead.handoff_status, 'reason', 'already_done');
  END IF;

  SELECT * INTO v_cfg FROM capture_handoff_config WHERE tenant_id = v_lead.tenant_id;
  IF v_cfg.tenant_id IS NOT NULL AND NOT v_cfg.enabled THEN
    UPDATE leads SET handoff_status = 'skipped' WHERE id = p_lead_id;
    RETURN jsonb_build_object('assigned', false, 'reason', 'disabled');
  END IF;

  v_q := coalesce(v_lead.seller_qualification, '{}'::jsonb);
  v_temp := coalesce(v_q->>'temperatura', public.capture_temperature(coalesce(v_lead.sales_score, 0)));
  v_sla := CASE v_temp
             WHEN 'quente' THEN coalesce(v_cfg.sla_minutes_quente, 30)
             WHEN 'morno'  THEN coalesce(v_cfg.sla_minutes_morno, 240)
             ELSE 7 * 24 * 60 END;

  v_specialist := coalesce(v_lead.sales_rep_id, public.capture_pick_specialist(v_lead.tenant_id));
  IF v_specialist IS NULL THEN
    UPDATE leads SET handoff_at = now(), handoff_status = 'unassigned' WHERE id = p_lead_id;
    PERFORM public.capture_add_event(p_lead_id, 'info', 'Lead registrado — sem especialista disponível',
      'Nenhum vendedor ativo pra receber o lead. O gestor precisa configurar os especialistas em Configurações › Captação.');
    RETURN jsonb_build_object('assigned', false, 'reason', 'no_specialist', 'temperatura', v_temp);
  END IF;

  SELECT name INTO v_spec_name FROM team_members WHERE id = v_specialist;
  SELECT name INTO v_promotora_name FROM team_members WHERE id = v_lead.captured_by_member_id;
  SELECT * INTO v_vehicle FROM seller_vehicles WHERE lead_id = p_lead_id ORDER BY created_at DESC LIMIT 1;
  v_veic := coalesce(v_vehicle.description, nullif(concat_ws(' ', v_vehicle.brand, v_vehicle.model), ''), 'veículo')
            || coalesce(' ' || v_vehicle.year_model::text, '');

  v_task_name := CASE v_temp
    WHEN 'quente' THEN 'LIGAR AGORA — lead quente da captação: ' || v_lead.name
    WHEN 'morno'  THEN 'Contato hoje — captação: ' || v_lead.name
    ELSE 'Nutrição — captação: ' || v_lead.name END;
  v_priority := CASE v_temp WHEN 'quente' THEN 'high' WHEN 'morno' THEN 'medium' ELSE 'low' END;
  v_due := now() + make_interval(mins => v_sla);
  v_desc := concat_ws(E'\n',
    '🚗 ' || v_veic || coalesce(' · ' || v_vehicle.km::text || ' km', ''),
    '🎯 Quer: ' || coalesce(v_q->>'intent', '—') || ' · Prazo: ' || coalesce(v_q->>'prazo_venda', '—')
      || coalesce(' · Motivo: ' || (v_q->>'motivo'), ''),
    '✅ Aceita avaliação: ' || coalesce(v_q->>'aceita_avaliacao', '—')
      || ' · Autorizou contato: ' || CASE WHEN v_q->>'autoriza_contato' = 'true' THEN 'sim' ELSE 'NÃO' END
      || ' · Proprietário: ' || CASE v_q->>'is_owner' WHEN 'true' THEN 'sim' WHEN 'false' THEN 'não' ELSE '—' END,
    CASE WHEN (v_q->>'expectativa_valor') ~ '^\d+(\.\d+)?$'
         THEN '💰 Valor em mente: R$ ' || to_char((v_q->>'expectativa_valor')::numeric, 'FM999G999G999') END,
    CASE WHEN nullif(v_q->>'observacao', '') IS NOT NULL THEN '📝 ' || (v_q->>'observacao') END,
    '👩 Captado por ' || coalesce(v_promotora_name, 'promotora') || ' (score ' || coalesce(v_lead.sales_score, 0) || ')'
  );

  -- Tarefa ANTES do deal: o trigger auto_move_deal_on_task não deve mover nada aqui.
  INSERT INTO company_activities (
    tenant_id, name, description, task_type, priority, status, completed,
    due_datetime, scheduled_at, lead_id, responsavel_id, created_by_id, team,
    is_critical, source_type, source_id, metadata
  ) VALUES (
    v_lead.tenant_id, v_task_name, v_desc, 'call', v_priority, 'not_started', false,
    v_due, v_due, p_lead_id, v_specialist, v_lead.captured_by_member_id, 'sales',
    v_temp = 'quente', 'captacao', p_lead_id,
    jsonb_build_object('captacao', true, 'temperatura', v_temp, 'sla_minutes', v_sla,
                       'promotora_member_id', v_lead.captured_by_member_id)
  ) RETURNING id INTO v_task_id;

  UPDATE leads SET
    sales_rep_id      = v_specialist,
    handoff_at        = now(),
    handoff_member_id = v_specialist,
    handoff_status    = 'pending',
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('handoff', jsonb_build_object(
      'especialista', v_spec_name, 'especialista_id', v_specialist, 'em', now(),
      'temperatura', v_temp, 'sla_minutes', v_sla, 'task_id', v_task_id))
  WHERE id = p_lead_id;

  -- Deal no funil de captação (o Kanban é por deals). Um por lead.
  v_stage := coalesce(v_lead.pipeline_stage_id, public.capture_pipeline_first_stage(v_lead.tenant_id));
  SELECT pipeline_id INTO v_pipeline FROM sales_pipeline_stages WHERE id = v_stage;
  SELECT id INTO v_deal_id FROM deals WHERE lead_id = p_lead_id AND status = 'negotiation' LIMIT 1;
  IF v_deal_id IS NULL AND v_stage IS NOT NULL THEN
    INSERT INTO deals (tenant_id, lead_id, pipeline_id, pipeline_stage_id, sales_rep_id, title, status, stage_changed_at, metadata)
    VALUES (v_lead.tenant_id, p_lead_id, v_pipeline, v_stage, v_specialist,
            'Captação — ' || v_veic || ' — ' || v_lead.name, 'negotiation', now(),
            jsonb_build_object('captacao', true, 'temperatura', v_temp, 'promotora_member_id', v_lead.captured_by_member_id))
    RETURNING id INTO v_deal_id;
  END IF;

  PERFORM public.capture_add_event(p_lead_id, 'handoff',
    'Lead passado pra ' || coalesce(split_part(v_spec_name, ' ', 1), 'especialista'),
    v_lead.name || ' (' || v_temp || ') está com ' || coalesce(v_spec_name, 'o especialista')
      || CASE WHEN v_temp IN ('quente', 'morno') THEN '. Contato previsto em até ' || v_sla || ' min.' ELSE '. Entrou em nutrição.' END,
    v_specialist);

  IF v_temp IN ('quente', 'morno') THEN
    BEGIN
      SELECT rtrim(value, '/') INTO v_url FROM config WHERE key = 'SUPABASE_PROJECT_URL';
      IF v_url IS NOT NULL AND v_url LIKE 'http%' THEN
        PERFORM net.http_post(
          url := v_url || '/functions/v1/capture-handoff',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := jsonb_build_object('mode', 'notify', 'lead_id', p_lead_id)
        );
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[capture_handoff] aviso não disparado: %', SQLERRM;
    END;
  END IF;

  RETURN jsonb_build_object('assigned', true, 'specialist_id', v_specialist,
                            'specialist_name', v_spec_name, 'task_id', v_task_id, 'deal_id', v_deal_id,
                            'temperatura', v_temp, 'sla_minutes', v_sla, 'status', 'pending');
END;
$$;

-- ─── 4a) 1º contato → "Contato feito" ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_mark_first_contact(p_lead_id uuid, p_source text, p_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_lead record; v_rep text;
BEGIN
  UPDATE leads SET first_contact_at = now(), handoff_status = 'contacted'
  WHERE id = p_lead_id AND captured_by_member_id IS NOT NULL AND first_contact_at IS NULL
  RETURNING id, name, sales_rep_id INTO v_lead;
  IF v_lead.id IS NULL THEN RETURN false; END IF;
  SELECT name INTO v_rep FROM team_members WHERE id = coalesce(p_actor, v_lead.sales_rep_id);
  PERFORM public.capture_add_event(p_lead_id, 'contacted',
    v_lead.name || ' foi contatado',
    coalesce(split_part(v_rep, ' ', 1), 'O especialista') || ' fez o 1º contato'
      || CASE p_source WHEN 'whatsapp' THEN ' pelo WhatsApp' WHEN 'tarefa' THEN ' (tarefa concluída)' ELSE '' END || '.',
    coalesce(p_actor, v_lead.sales_rep_id));
  PERFORM public.capture_move_stage(p_lead_id, 'Contato%');
  RETURN true;
END;
$$;

-- ─── 4b/4c/4d) Tarefas movem o funil ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_capture_task_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.lead_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND captured_by_member_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.task_type IN ('trade_eval', 'visit', 'meeting', 'video_call') AND NEW.scheduled_at IS NOT NULL
       AND coalesce(NEW.source_type, '') <> 'captacao' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Avalia%');
    ELSIF NEW.task_type = 'proposal' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Proposta%');
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.completed = true AND OLD.completed IS DISTINCT FROM true THEN
    IF NEW.task_type IN ('trade_eval', 'visit', 'photo_session') THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Veio%');
    ELSIF NEW.task_type = 'proposal' THEN
      PERFORM public.capture_move_stage(NEW.lead_id, 'Proposta%');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_capture_task_stage_ins ON public.company_activities;
CREATE TRIGGER trg_capture_task_stage_ins AFTER INSERT ON public.company_activities
  FOR EACH ROW EXECUTE FUNCTION public.trg_capture_task_stage();
DROP TRIGGER IF EXISTS trg_capture_task_stage_upd ON public.company_activities;
CREATE TRIGGER trg_capture_task_stage_upd AFTER UPDATE ON public.company_activities
  FOR EACH ROW WHEN (NEW.completed = true AND OLD.completed IS DISTINCT FROM true)
  EXECUTE FUNCTION public.trg_capture_task_stage();

-- ─── 4e) 3 dias em "Contato feito" sem agendar → follow-up ─────────────────
-- Chamada pelo cron do SLA (capture-handoff mode=sla). Cria a tarefa uma vez
-- por deal e devolve a lista pra avisar o grupo.
CREATE OR REPLACE FUNCTION public.capture_stale_followups(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r record; v_out jsonb := '[]'::jsonb; v_task uuid; v_rep text;
BEGIN
  FOR r IN
    SELECT d.id AS deal_id, d.tenant_id, d.lead_id, d.sales_rep_id, l.name AS lead_name,
           floor(extract(epoch FROM (now() - coalesce(d.stage_changed_at, d.updated_at))) / 86400)::int AS dias
    FROM deals d
    JOIN sales_pipeline_stages s ON s.id = d.pipeline_stage_id AND s.name ILIKE 'Contato%'
    JOIN leads l ON l.id = d.lead_id AND l.captured_by_member_id IS NOT NULL
    WHERE d.status = 'negotiation'
      AND coalesce(d.stage_changed_at, d.updated_at) < now() - make_interval(days => p_days)
      AND (d.metadata->>'stale_followup_at') IS NULL
      AND NOT EXISTS (SELECT 1 FROM company_activities t
                      WHERE t.lead_id = d.lead_id AND t.completed = false
                        AND t.status <> 'cancelled' AND t.scheduled_at > now()
                        AND t.task_type IN ('trade_eval', 'visit', 'meeting', 'video_call'))
  LOOP
    INSERT INTO company_activities (tenant_id, name, description, task_type, priority, status, completed,
      due_datetime, lead_id, responsavel_id, team, source_type, source_id, metadata)
    VALUES (r.tenant_id, 'Follow-up captação — agendar avaliação: ' || r.lead_name,
      'Lead em "Contato feito" há ' || r.dias || ' dias sem avaliação marcada. Retomar contato e agendar (ou mover pra Nutrição/Perdido).',
      'follow_up', 'high', 'not_started', false, now(), r.lead_id, r.sales_rep_id, 'sales', 'captacao', r.lead_id,
      jsonb_build_object('captacao', true, 'stale_followup', true))
    RETURNING id INTO v_task;
    UPDATE deals SET metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('stale_followup_at', now(), 'stale_followup_task', v_task)
    WHERE id = r.deal_id;
    SELECT split_part(name, ' ', 1) INTO v_rep FROM team_members WHERE id = r.sales_rep_id;
    v_out := v_out || jsonb_build_object('tenant_id', r.tenant_id, 'lead', r.lead_name, 'rep', coalesce(v_rep, '—'), 'dias', r.dias);
  END LOOP;
  RETURN v_out;
END;
$$;
GRANT EXECUTE ON FUNCTION public.capture_stale_followups(integer) TO service_role;

-- ─── Backfill: leads de captação que ainda não têm deal no funil ───────────
INSERT INTO deals (tenant_id, lead_id, pipeline_id, pipeline_stage_id, sales_rep_id, title, status, stage_changed_at, metadata)
SELECT l.tenant_id, l.id, s.pipeline_id, s.id, l.sales_rep_id,
       'Captação — ' || coalesce(sv.description, nullif(concat_ws(' ', sv.brand, sv.model), ''), 'veículo')
         || coalesce(' ' || sv.year_model::text, '') || ' — ' || l.name,
       'negotiation', coalesce(l.captured_at, l.created_at),
       jsonb_build_object('captacao', true, 'temperatura', l.seller_qualification->>'temperatura', 'promotora_member_id', l.captured_by_member_id)
FROM leads l
JOIN sales_pipeline_stages s ON s.id = coalesce(l.pipeline_stage_id, public.capture_pipeline_first_stage(l.tenant_id))
LEFT JOIN LATERAL (SELECT * FROM seller_vehicles v WHERE v.lead_id = l.id ORDER BY v.created_at DESC LIMIT 1) sv ON true
WHERE l.captured_by_member_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.lead_id = l.id AND d.status = 'negotiation');
