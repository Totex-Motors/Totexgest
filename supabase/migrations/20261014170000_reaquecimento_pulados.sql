-- Reaquecimento: lead PULADO (sem carro/intenção pra abrir com uma conta, template ainda
-- pendente) sai da fila por 3 dias. Sem isso os mesmos 3 leads voltavam toda rodada e
-- travavam a vaga dos outros (14/10, 2ª hora: 0 enviados em 5 rodadas).
-- lead-rewarm grava metadata.reaquecimento.pulado_em / pulado_motivo.
-- (função criada originalmente direto no banco; esta é a versão completa atual)
CREATE OR REPLACE FUNCTION public.reaquecimento_candidatos(p_tenant uuid, p_momento text, p_limite integer DEFAULT 10)
 RETURNS TABLE(lead_id uuid, phone text, name text, janela_aberta boolean, created_at timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH base AS (
    SELECT l.id, l.phone, l.name, l.created_at, l.source, l.metadata,
      (SELECT max(m.created_at) FROM whatsapp_messages m WHERE m.lead_id = l.id AND NOT m.is_from_me) AS last_in,
      (SELECT max(m.created_at) FROM whatsapp_messages m WHERE m.lead_id = l.id) AS last_any,
      EXISTS (SELECT 1 FROM company_activities a WHERE a.lead_id = l.id AND a.task_type = 'meeting' AND a.status NOT IN ('cancelled') AND a.scheduled_at > now() - interval '1 day') AS tem_agend
    FROM leads l
    WHERE l.tenant_id = p_tenant
      AND l.phone IS NOT NULL AND length(regexp_replace(l.phone, '\D', '', 'g')) BETWEEN 10 AND 13
      AND coalesce(l.lead_kind, '') NOT IN ('franchise', 'contact')
      AND coalesce(l.metadata->>'nao_contatar', 'false') <> 'true'
      AND coalesce((l.metadata->'reaquecimento'->>'iniciado_em')::timestamptz, '1970-01-01') < now() - interval '7 days'
      AND coalesce((l.metadata->'reaquecimento'->>'pulado_em')::timestamptz, '1970-01-01') < now() - interval '3 days'
      AND l.created_at > now() - interval '30 days'
      AND NOT (l.phone ~ '@g\.us$' OR l.phone ~ '@newsletter$')
  )
  SELECT b.id, regexp_replace(b.phone, '\D', '', 'g'), b.name,
         (b.last_in IS NOT NULL AND b.last_in > now() - interval '23 hours') AS janela_aberta, b.created_at
  FROM base b
  WHERE NOT b.tem_agend AND (
    (p_momento = 'A_saiu_do_stand' AND b.created_at BETWEEN now() - interval '2 hours' AND now() - interval '30 minutes'
       AND b.source IN ('stand', 'totem-compra', 'captacao'))
    OR (p_momento = 'B_nunca_falou' AND b.last_in IS NULL AND b.created_at < now() - interval '24 hours'
       AND b.created_at > now() - interval '14 days')
    OR (p_momento = 'C_esfriou' AND b.last_in IS NOT NULL AND b.last_in < now() - interval '3 days')
  )
  ORDER BY b.created_at DESC
  LIMIT greatest(1, coalesce(p_limite, 10));
$function$;
