-- merge_leads v2 (08/11): a função não existia no banco de produção (migration 20260706 nunca
-- aplicada) e o botão "Mesclar" caía com "Could not find the function public.merge_leads".
-- Agora move TODA tabela que aponta pra leads (lê as FKs do catálogo), descarta a linha do
-- duplicado quando há restrição única, junta metadata e preenche campos vazios do principal.
CREATE OR REPLACE FUNCTION public.merge_leads(p_keeper_id uuid, p_duplicate_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE
  v_keeper leads%ROWTYPE; v_dup leads%ROWTYPE; r record; v_n int; v_moved int := 0; v_dropped int := 0; v_tabelas text := '';
BEGIN
  SELECT * INTO v_keeper FROM leads WHERE id = p_keeper_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead principal não encontrado'; END IF;
  SELECT * INTO v_dup FROM leads WHERE id = p_duplicate_id AND tenant_id = v_keeper.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead duplicado não encontrado ou de outra loja'; END IF;
  IF p_keeper_id = p_duplicate_id THEN RAISE EXCEPTION 'Os dois leads são o mesmo'; END IF;

  FOR r IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.confrelid = 'public.leads'::regclass
  LOOP
    BEGIN
      EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_keeper_id, p_duplicate_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_moved := v_moved + v_n;
      IF v_n > 0 THEN v_tabelas := v_tabelas || r.tbl::text || ' '; END IF;
    EXCEPTION WHEN unique_violation THEN
      -- a tabela tem chave única com o lead: o que conflita com o principal é descartado
      EXECUTE format('DELETE FROM %s WHERE %I = $1', r.tbl, r.col) USING p_duplicate_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_dropped := v_dropped + v_n;
    END;
  END LOOP;

  UPDATE leads SET
    phone = COALESCE(NULLIF(phone,''), v_dup.phone),
    email = COALESCE(NULLIF(email,''), v_dup.email),
    name = CASE WHEN name IS NULL OR name = '' OR name ~ '^\+?\d+$' THEN COALESCE(v_dup.name, name) ELSE name END,
    company = COALESCE(company, v_dup.company),
    city_name = COALESCE(city_name, v_dup.city_name),
    state = COALESCE(state, v_dup.state),
    metadata = COALESCE(v_dup.metadata, '{}'::jsonb) || COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('mesclado_de', jsonb_build_object('lead_id', p_duplicate_id, 'nome', v_dup.name, 'telefone', v_dup.phone, 'email', v_dup.email, 'em', now())),
    updated_at = now()
  WHERE id = p_keeper_id;

  DELETE FROM leads WHERE id = p_duplicate_id;

  RETURN format('%s registro(s) movido(s) pro lead principal%s%s.', v_moved,
    CASE WHEN v_tabelas <> '' THEN ' (' || trim(v_tabelas) || ')' ELSE '' END,
    CASE WHEN v_dropped > 0 THEN '; ' || v_dropped || ' repetido(s) descartado(s)' ELSE '' END);
END $f$;
GRANT EXECUTE ON FUNCTION public.merge_leads(uuid, uuid) TO authenticated;
