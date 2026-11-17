-- BASE DE CLIENTES DAS LOJAS (Marco, 17/11/2026): carteira histórica (planilha da loja, aba de compras)
-- guardada no banco com acesso restrito, pra campanhas de reativação não dependerem de arquivo local.
-- Primeira carga: planilha "Clientes_base_cardoso_veiculos.xlsx", aba Plan2 (9.489 clientes da Cardoso),
-- origem 'planilha_cardoso_2026-11'. Os DADOS não ficam no repositório: a carga foi feita por uma função
-- de importação temporária (token de uso único), removida logo em seguida.
--
-- Acesso: só superadmin ou admin da própria loja leem (RLS). Ninguém escreve pelo app; carga e
-- atualização (lead_id, email_enviado_em, campanha) só pelo service_role.

CREATE TABLE IF NOT EXISTS public.base_clientes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  origem            text NOT NULL,                 -- de onde veio (planilha/data)
  linha             int  NOT NULL,                 -- linha na origem (idempotência da carga)
  nome              text,
  telefone          text,
  telefone_norm     text,                          -- 55 + DDD + número
  email             text,
  idade             int,
  compras           int,                           -- compras no período
  faturamento       numeric,
  carro_mais_caro   numeric,
  primeira_compra   date,
  ultima_compra     date,
  tempo_medio_dias  int,
  ultimo_modelo     text,
  pessoa_juridica   boolean NOT NULL DEFAULT false, -- heurística pelo nome (LTDA, EIRELI, comércio…)
  lead_id           uuid,                          -- lead no CRM quando entrou numa campanha / já existia
  email_enviado_em  timestamptz,                   -- 1º e-mail de campanha recebido
  campanha          text,                          -- última campanha (ou 'descartado_email_invalido')
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT base_clientes_uniq UNIQUE (tenant_id, origem, linha)
);
CREATE INDEX IF NOT EXISTS base_clientes_tel_idx    ON public.base_clientes (tenant_id, right(telefone_norm, 8));
CREATE INDEX IF NOT EXISTS base_clientes_email_idx  ON public.base_clientes (tenant_id, lower(email));
CREATE INDEX IF NOT EXISTS base_clientes_ultima_idx ON public.base_clientes (tenant_id, ultima_compra);

ALTER TABLE public.base_clientes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.base_clientes FROM anon, authenticated;
GRANT SELECT ON public.base_clientes TO authenticated;
GRANT ALL ON public.base_clientes TO service_role;
DROP POLICY IF EXISTS base_clientes_admin_le ON public.base_clientes;
CREATE POLICY base_clientes_admin_le ON public.base_clientes FOR SELECT TO authenticated
  USING (public.is_superadmin() OR (tenant_id = public.get_tenant_id() AND public.is_admin()));
