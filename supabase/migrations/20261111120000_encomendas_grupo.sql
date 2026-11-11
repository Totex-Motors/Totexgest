-- ENCOMENDAS — grupo de compra/encomenda (Marco, 11/11/2026).
-- O TotexCar (UAZAPI, admin do grupo) lê os pedidos de carro do grupo, busca no marketplace
-- totexmotors.com e responde NO GRUPO (citando o pedido) com o link dos carros que batem.
-- Só grupo (regra inviolável da UAZAPI). Código: supabase/functions/_shared/encomendas.ts.

CREATE TABLE IF NOT EXISTS public.encomenda_grupos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT public.get_tenant_id(),
  instance_id      uuid NOT NULL REFERENCES public.whatsapp_instances(id) ON DELETE CASCADE,
  group_jid        text NOT NULL,
  group_name       text,
  active           boolean NOT NULL DEFAULT true,
  ano_tolerancia   int NOT NULL DEFAULT 1,     -- pediu 2020 → aceita 2019 a 2021
  preco_folga_pct  int NOT NULL DEFAULT 10,    -- "até 70 mil" → aceita até 77 mil
  max_carros       int NOT NULL DEFAULT 3,     -- carros por resposta
  model            text,                       -- modelo Claude (null = padrão do código)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encomenda_grupos_is_group CHECK (public.wa_is_group_or_channel(group_jid)),
  CONSTRAINT encomenda_grupos_uniq UNIQUE (instance_id, group_jid)
);

CREATE TABLE IF NOT EXISTS public.encomenda_pedidos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,
  grupo_id          uuid NOT NULL REFERENCES public.encomenda_grupos(id) ON DELETE CASCADE,
  source_message_id text NOT NULL,
  member_phone      text,
  member_name       text,
  raw_text          text,
  marca             text,
  modelo            text,
  ano_min           int,
  ano_max           int,
  preco_max         numeric,
  cambio            text,
  observacao        text,
  -- respondido | sem_carro | sem_resposta (limite/hora) | ignorado (não é pedido) | erro
  status            text NOT NULL,
  carros            jsonb,
  resposta          text,
  erro              text,
  respondido_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encomenda_pedidos_uniq UNIQUE (grupo_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS encomenda_pedidos_grupo_idx ON public.encomenda_pedidos (grupo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS encomenda_pedidos_status_idx ON public.encomenda_pedidos (tenant_id, status, created_at DESC);

ALTER TABLE public.encomenda_grupos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encomenda_pedidos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS encomenda_grupos_admin ON public.encomenda_grupos;
CREATE POLICY encomenda_grupos_admin ON public.encomenda_grupos FOR ALL TO authenticated
  USING (tenant_id = public.get_tenant_id() AND (public.is_admin() OR public.is_superadmin()))
  WITH CHECK (tenant_id = public.get_tenant_id() AND (public.is_admin() OR public.is_superadmin()));
DROP POLICY IF EXISTS encomenda_pedidos_admin ON public.encomenda_pedidos;
CREATE POLICY encomenda_pedidos_admin ON public.encomenda_pedidos FOR SELECT TO authenticated
  USING (tenant_id = public.get_tenant_id() AND (public.is_admin() OR public.is_superadmin()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.encomenda_grupos TO authenticated;
GRANT SELECT ON public.encomenda_pedidos TO authenticated;
GRANT ALL ON public.encomenda_grupos, public.encomenda_pedidos TO service_role;

DROP TRIGGER IF EXISTS trg_touch_encomenda_grupos ON public.encomenda_grupos;
CREATE TRIGGER trg_touch_encomenda_grupos BEFORE UPDATE ON public.encomenda_grupos
  FOR EACH ROW EXECUTE FUNCTION public.touch_repasse_relay_config();

-- Grupo do Marco: "COMPRA/ENCOMENDA CARDOSO" (TotexCar = instância IA Stand, admin do grupo).
INSERT INTO public.encomenda_grupos (tenant_id, instance_id, group_jid, group_name)
SELECT i.tenant_id, i.id, '120363431352782711@g.us', 'COMPRA/ENCOMENDA CARDOSO'
FROM public.whatsapp_instances i
WHERE i.id = 'eb8199e5-3bc6-416f-9953-038ef04175cd'
ON CONFLICT (instance_id, group_jid) DO NOTHING;
