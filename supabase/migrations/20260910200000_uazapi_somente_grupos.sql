-- ============================================================================
-- REGRA INVIOLÁVEL (Marco, 2026-09-10, depois do banimento do número Totexcar):
--   A API NÃO OFICIAL (UAZAPI) JAMAIS envia mensagem pra número particular.
--   Só GRUPOS (@g.us) e CANAIS (@newsletter). Conversa 1:1 = só API oficial
--   (Cloud API / provider meta_cloud).
--
--   whatsapp_instances.group_only  — true e travado pra provider = 'uazapi'
--   whatsapp_send_blocks           — log de toda tentativa bloqueada (auditoria)
--   wa_target_allowed(instance, target) — checagem usada por funções e UI
-- ============================================================================

ALTER TABLE public.whatsapp_instances
  ADD COLUMN IF NOT EXISTS group_only boolean NOT NULL DEFAULT false;

UPDATE public.whatsapp_instances SET group_only = true
WHERE coalesce(provider, 'uazapi') <> 'meta_cloud';

-- Trava: instância não oficial nasce e permanece group_only = true. Ninguém
-- desliga pela UI/API — só uma migration explícita mudaria esta função.
CREATE OR REPLACE FUNCTION public.enforce_uazapi_group_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(NEW.provider, 'uazapi') <> 'meta_cloud' THEN
    NEW.group_only := true;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_uazapi_group_only ON public.whatsapp_instances;
CREATE TRIGGER trg_enforce_uazapi_group_only BEFORE INSERT OR UPDATE ON public.whatsapp_instances
  FOR EACH ROW EXECUTE FUNCTION public.enforce_uazapi_group_only();

COMMENT ON COLUMN public.whatsapp_instances.group_only IS
  'REGRA INVIOLÁVEL: true = a instância só pode mandar mensagem pra grupo (@g.us) ou canal (@newsletter). Forçado por trigger pra toda instância não oficial (UAZAPI).';

-- Auditoria das tentativas bloqueadas
CREATE TABLE IF NOT EXISTS public.whatsapp_send_blocks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid,
  instance_id uuid,
  target      text NOT NULL,
  source      text NOT NULL,          -- função/tela que tentou
  preview     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_send_blocks_created_idx ON public.whatsapp_send_blocks(created_at DESC);
GRANT SELECT ON public.whatsapp_send_blocks TO authenticated;
GRANT ALL ON public.whatsapp_send_blocks TO service_role;
ALTER TABLE public.whatsapp_send_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_send_blocks_select ON public.whatsapp_send_blocks;
CREATE POLICY whatsapp_send_blocks_select ON public.whatsapp_send_blocks
  FOR SELECT TO authenticated
  USING ((tenant_id = public.get_tenant_id() AND public.is_admin()) OR public.is_superadmin());

-- Alvo é grupo ou canal? (aceita jid completo ou só o id numérico de grupo)
CREATE OR REPLACE FUNCTION public.wa_is_group_or_channel(p_target text) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT p_target IS NOT NULL AND (
    p_target ILIKE '%@g.us' OR p_target ILIKE '%@newsletter'
    -- id de grupo sem sufixo: 15+ dígitos começando com 1203 (padrão dos grupos), ou com hífen (grupos antigos)
    OR p_target ~ '^1203\d{11,}$' OR p_target ~ '^\d+-\d+$'
  );
$$;

-- Pode enviar? Registra o bloqueio quando não pode. Usado por edge functions
-- (service role) e pela UI (authenticated).
CREATE OR REPLACE FUNCTION public.wa_target_allowed(p_instance_id uuid, p_target text, p_source text DEFAULT 'unknown', p_preview text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_inst record;
BEGIN
  IF p_instance_id IS NULL THEN RETURN true; END IF;
  SELECT id, tenant_id, provider, group_only INTO v_inst FROM whatsapp_instances WHERE id = p_instance_id;
  IF v_inst.id IS NULL THEN RETURN true; END IF;
  IF v_inst.provider = 'meta_cloud' THEN RETURN true; END IF;
  IF NOT v_inst.group_only THEN RETURN true; END IF;
  IF public.wa_is_group_or_channel(p_target) THEN RETURN true; END IF;
  INSERT INTO whatsapp_send_blocks (tenant_id, instance_id, target, source, preview)
  VALUES (v_inst.tenant_id, v_inst.id, p_target, p_source, left(p_preview, 120));
  RETURN false;
END;
$$;
GRANT EXECUTE ON FUNCTION public.wa_is_group_or_channel(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_target_allowed(uuid, text, text, text) TO authenticated, service_role;
