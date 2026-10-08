-- ============================================================================
-- UMA DEDUPE SÓ — passo 2 (2026-10-08). Base: docs/ENTRADAS-DE-LEADS.md §3.3
-- Hoje cada porta de entrada tem a própria regra de duplicidade por telefone
-- (9 regras diferentes) e várias não têm nenhuma → o mesmo cliente vira 2, 3
-- leads. Aqui nasce a função CANÔNICA "achar ou criar", usada por todas:
--   • telefone normalizado (55 + DDD + número);
--   • casa pelos últimos 8 dígitos DENTRO da loja (tenant), nunca global;
--   • resultado determinístico (exato > mais recente interação > mais antigo);
--   • trava anti-corrida (dois webhooks simultâneos do mesmo cliente = 1 lead);
--   • "primeira porta vence": metadata existente não é sobrescrito.
-- ============================================================================

-- ─── 1) Normalização de telefone BR ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.normalize_phone_br(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d = '' THEN NULL
    WHEN length(d) IN (10, 11) THEN '55' || d   -- DDD + número → ganha o 55
    ELSE d
  END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s;
$$;

-- ─── 2) Achar lead por telefone (regra única, dentro da loja) ─────────────────
CREATE OR REPLACE FUNCTION public.find_lead_by_phone(p_tenant uuid, p_phone text)
RETURNS SETOF public.leads
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (SELECT public.normalize_phone_br(p_phone) AS ph)
  SELECT l.*
  FROM public.leads l, n
  WHERE n.ph IS NOT NULL AND length(n.ph) >= 10
    AND l.tenant_id = p_tenant
    AND l.phone IS NOT NULL
    AND right(regexp_replace(l.phone, '\D', '', 'g'), 8) = right(n.ph, 8)
  ORDER BY (regexp_replace(l.phone, '\D', '', 'g') = n.ph) DESC,  -- exato primeiro
           l.last_interaction_at DESC NULLS LAST,                   -- depois o mais "vivo"
           l.created_at ASC                                         -- empate: o original
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.find_lead_by_phone(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_lead_by_phone(uuid, text) TO service_role, authenticated;

-- ─── 3) Achar OU criar (a porta única) ───────────────────────────────────────
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
  -- loja obrigatória e real (o trigger trg_leads_require_real_tenant também garante)
  IF p_tenant IS NULL OR NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant) THEN
    RAISE EXCEPTION 'find_or_create_lead: loja (tenant) inválida: %', p_tenant USING ERRCODE = '23514';
  END IF;
  -- usuário logado só cria na PRÓPRIA loja (service_role, sem auth.uid(), passa)
  IF auth.uid() IS NOT NULL
     AND p_tenant IS DISTINCT FROM public.get_tenant_id()
     AND NOT public.is_platform_superadmin() THEN
    RAISE EXCEPTION 'find_or_create_lead: sem acesso a essa loja' USING ERRCODE = '42501';
  END IF;

  v_phone := public.normalize_phone_br(p_phone);
  IF v_phone IS NULL OR length(v_phone) < 10 THEN
    RAISE EXCEPTION 'find_or_create_lead: telefone inválido: %', p_phone USING ERRCODE = '22023';
  END IF;

  -- trava anti-corrida: mesma loja + mesmos 8 últimos dígitos → serializa
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant::text || ':' || right(v_phone, 8)));

  SELECT * INTO v_existing FROM public.find_lead_by_phone(p_tenant, v_phone);

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.leads SET
      -- nome só preenche se o atual é vazio/telefone (não sobrescreve nome bom)
      name = CASE
               WHEN v_name IS NOT NULL AND (name IS NULL OR btrim(name) = '' OR name = phone OR name ~ '^\d+$') THEN v_name
               ELSE name END,
      email = coalesce(email, v_email),
      -- "primeira porta vence": chaves novas entram, as existentes ficam (direita ganha no ||)
      metadata = coalesce(p_metadata, '{}'::jsonb) || coalesce(metadata, '{}'::jsonb),
      last_interaction_at = now()
    WHERE id = v_existing.id;
    RETURN jsonb_build_object('lead_id', v_existing.id, 'created', false, 'phone', v_existing.phone, 'tenant_id', p_tenant);
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
    CASE WHEN p_lead_kind IN ('car', 'franchise') THEN p_lead_kind ELSE 'car' END
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('lead_id', v_id, 'created', true, 'phone', v_phone, 'tenant_id', p_tenant);
END;
$$;
REVOKE ALL ON FUNCTION public.find_or_create_lead(uuid, text, text, text, text, text, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_or_create_lead(uuid, text, text, text, text, text, jsonb, text) TO service_role, authenticated;

COMMENT ON FUNCTION public.find_or_create_lead(uuid, text, text, text, text, text, jsonb, text) IS
  'Porta única de criação de lead: normaliza telefone, dedupe por últimos 8 dígitos DENTRO da loja, determinístico, com trava anti-corrida. Passo 2 de docs/ENTRADAS-DE-LEADS.md.';
