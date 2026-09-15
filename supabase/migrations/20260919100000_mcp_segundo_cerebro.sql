-- ============================================================================
-- SEGUNDO CÉREBRO (MCP) — Fase 1: as "ferramentas" (RPCs)
--
-- Camada enxuta e sob medida pro Totexgest: funções que o servidor MCP expõe
-- ao Claude. Leitura (supervisão) + ações (com o servidor pedindo confirmação).
-- Tudo escopado por tenant via get_tenant_id() e por papel (gestor/admin).
-- NÃO mexe em nada existente — só adiciona funções public.mcp_*.
--
-- Padrão de acesso: o servidor MCP chama estas RPCs com o TOKEN do usuário
-- (OAuth do Supabase) → get_tenant_id()/current_member_id() resolvem o dono.
-- SECURITY DEFINER + escopo manual por tenant (nunca cruza empresas).
-- ============================================================================

-- Guard comum: exige um membro do tenant e bloqueia promotora/sdr, porque o
-- "cérebro" é visão de gestão. Checa o PAPEL real (role) direto — NÃO usa
-- is_superadmin(), pois no tenant central (HQ) todos contam como superadmin
-- (tenants.is_super_admin=true), o que deixaria promotoras passarem. Retorna o member_id.
CREATE OR REPLACE FUNCTION public.mcp_guard_gestor()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_role text;
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro vinculado à sua conta'; END IF;
  SELECT role INTO v_role FROM team_members WHERE id = v_member;
  IF lower(coalesce(v_role,'')) IN ('promotora','sdr') THEN
    RAISE EXCEPTION 'Esta visão é da gestão';
  END IF;
  RETURN v_member;
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_guard_gestor() TO authenticated;

-- ─── LEITURA 1: resumo da operação ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_resumo_operacao()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN jsonb_build_object(
    'gerado_em', to_char(now() AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
    'leads_hoje', (SELECT count(*) FROM leads WHERE tenant_id=t AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = hoje),
    'leads_7d', (SELECT count(*) FROM leads WHERE tenant_id=t AND created_at >= now()-interval '7 days'),
    'deals_abertos', (SELECT count(*) FROM deals WHERE tenant_id=t AND coalesce(lower(status),'') NOT IN ('won','ganho','lost','perdido','closed')),
    'tarefas_atrasadas', (SELECT count(*) FROM company_activities WHERE tenant_id=t AND completed IS NOT TRUE AND due_datetime IS NOT NULL AND due_datetime < now()),
    'tarefas_criticas_abertas', (SELECT count(*) FROM company_activities WHERE tenant_id=t AND completed IS NOT TRUE AND is_critical),
    'aprovacoes_pendentes', (SELECT count(*) FROM approval_requests WHERE tenant_id=t AND lower(status) IN ('pending','open','aguardando','requested')),
    'intermediacoes_por_status', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM intermediations WHERE tenant_id=t GROUP BY status) s), '{}'::jsonb),
    'repasse_indicacoes', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=t),
    'repasse_convertidos', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=t AND status='converted')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_resumo_operacao() TO authenticated;

-- ─── LEITURA 2: o que está atrasado / precisa de você ────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_o_que_esta_atrasado()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN jsonb_build_object(
    'tarefas_atrasadas', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, name AS tarefa, to_char(due_datetime AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS vencia_em,
               (now()::date - due_datetime::date) AS dias_atraso, is_critical AS critica
        FROM company_activities
        WHERE tenant_id=t AND completed IS NOT TRUE AND due_datetime IS NOT NULL AND due_datetime < now()
        ORDER BY due_datetime ASC LIMIT 25) x), '[]'::jsonb),
    'deals_parados', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, title AS deal, (now()::date - created_at::date) AS dias_no_sistema
        FROM deals
        WHERE tenant_id=t AND coalesce(lower(status),'') NOT IN ('won','ganho','lost','perdido','closed')
          AND created_at < now()-interval '14 days'
        ORDER BY created_at ASC LIMIT 15) x), '[]'::jsonb),
    'aprovacoes_pendentes', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, kind AS tipo, title AS titulo, amount AS valor,
               (now()::date - created_at::date) AS dias_esperando
        FROM approval_requests
        WHERE tenant_id=t AND lower(status) IN ('pending','open','aguardando','requested')
        ORDER BY created_at ASC LIMIT 25) x), '[]'::jsonb)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_o_que_esta_atrasado() TO authenticated;

-- ─── LEITURA 3: aprovações pendentes (detalhe, pra decidir) ───────────────────
CREATE OR REPLACE FUNCTION public.mcp_aprovacoes_pendentes()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN coalesce((SELECT jsonb_agg(x) FROM (
      SELECT id, kind AS tipo, title AS titulo, amount AS valor, status,
             to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM HH24:MI') AS aberta_em,
             public.member_can_approve() AS voce_pode_aprovar
      FROM approval_requests
      WHERE tenant_id=t AND lower(status) IN ('pending','open','aguardando','requested')
      ORDER BY created_at ASC LIMIT 50) x), '[]'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_aprovacoes_pendentes() TO authenticated;

-- ─── LEITURA 4: intermediação & repasse ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_intermediacao_repasse()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  RETURN jsonb_build_object(
    'intermediacoes_por_status', coalesce((SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM intermediations WHERE tenant_id=t GROUP BY status) s), '{}'::jsonb),
    'intermediacoes_recentes', coalesce((SELECT jsonb_agg(x) FROM (
        SELECT id, status, to_char(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS aberta_em
        FROM intermediations WHERE tenant_id=t ORDER BY created_at DESC LIMIT 10) x), '[]'::jsonb),
    'repasse', jsonb_build_object(
      'indicacoes', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=t),
      'entraram', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=t AND status IN ('joined','converted')),
      'convertidos', (SELECT count(*) FROM repasse_referrals WHERE tenant_id=t AND status='converted')
    )
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_intermediacao_repasse() TO authenticated;

-- ─── AÇÃO 1: criar tarefa ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_criar_tarefa(p_titulo text, p_due timestamptz DEFAULT NULL, p_critica boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_titulo text := btrim(coalesce(p_titulo,''));
BEGIN
  PERFORM public.mcp_guard_gestor();
  IF length(v_titulo) < 2 THEN RAISE EXCEPTION 'Descreva a tarefa (mín. 2 caracteres)'; END IF;
  INSERT INTO company_activities (name, status, priority, completed, due_datetime, is_critical)
  VALUES (v_titulo, 'not_started', 'medium', false, p_due, coalesce(p_critica,false))
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'tarefa', v_titulo);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_criar_tarefa(text, timestamptz, boolean) TO authenticated;

-- ─── AÇÃO 2: concluir tarefa ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mcp_concluir_tarefa(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t uuid; v_n int;
BEGIN
  PERFORM public.mcp_guard_gestor();
  t := public.get_tenant_id();
  UPDATE company_activities SET completed=true, completed_at=now(), status='completed'
  WHERE id=p_id AND tenant_id=t AND completed IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'motivo', 'Tarefa não encontrada ou já concluída'); END IF;
  RETURN jsonb_build_object('ok', true, 'id', p_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_concluir_tarefa(uuid) TO authenticated;

-- ─── AÇÃO 3: aprovar/recusar uma alçada (usa o motor existente) ───────────────
CREATE OR REPLACE FUNCTION public.mcp_decidir_aprovacao(p_request_id uuid, p_decisao text, p_nota text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_dec text := lower(btrim(coalesce(p_decisao,'')));
BEGIN
  PERFORM public.mcp_guard_gestor();
  IF NOT public.member_can_approve() THEN RAISE EXCEPTION 'Você não tem alçada para aprovar'; END IF;
  IF v_dec IN ('aprovar','aprovado','approve','approved','sim') THEN v_dec := 'approved';
  ELSIF v_dec IN ('recusar','recusado','reject','rejected','negar','nao','não') THEN v_dec := 'rejected';
  ELSE RAISE EXCEPTION 'Decisão inválida: use aprovar ou recusar'; END IF;
  RETURN public.approval_decide(p_request_id, v_dec, p_nota);
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_decidir_aprovacao(uuid, text, text) TO authenticated;

-- ─── CONTEXTO: exigido pelo servidor MCP na conexão (quem/empresa) ───────────
CREATE OR REPLACE FUNCTION public.mcp_context()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_member uuid := public.current_member_id(); v_tenant uuid := public.get_tenant_id();
        v_role text; v_tname text;
BEGIN
  IF v_member IS NULL THEN RAISE EXCEPTION 'Sem membro vinculado à sua conta'; END IF;
  SELECT role INTO v_role FROM team_members WHERE id = v_member;
  SELECT name INTO v_tname FROM tenants WHERE id = v_tenant;
  RETURN jsonb_build_object(
    'user_id', auth.uid(),
    'tenant_id', v_tenant,
    'tenant_name', coalesce(v_tname,'Minha empresa'),
    'member_id', v_member,
    'role', coalesce(v_role,'desconhecido'),
    'can_write', lower(coalesce(v_role,'')) NOT IN ('promotora','sdr')
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.mcp_context() TO authenticated;
