-- ============================================================================
-- RPC usada pelo meta-lead-webhook pra resolver a fila de distribuição do
-- tenant dono da página de Lead Ads. O zip do template v3 referencia a função
-- mas não trouxe a definição — semântica catch-all: a config ATIVA mais antiga
-- do tenant (p_form_id/p_page_id ficam pra um matching mais fino no futuro).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.match_distribution_config_for_meta_lead(
  p_tenant_id uuid,
  p_form_id text DEFAULT NULL,
  p_page_id text DEFAULT NULL
)
RETURNS TABLE (id uuid, name text, api_key text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.name, c.api_key
  FROM lead_distribution_config c
  WHERE c.tenant_id = p_tenant_id
    AND c.is_active
  ORDER BY c.created_at ASC
  LIMIT 1;
$$;
