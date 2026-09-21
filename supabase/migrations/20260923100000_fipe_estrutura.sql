-- ============================================================================
-- Integração Tabela FIPE — estrutura base (fipeX + fallback FIPE oficial)
-- Doc: "Integração Tabela FIPE — fipeX (Totexgest e demais projetos)"
--
-- Porta única: edge function `fipe-lookup` (cache → API fipeX → dataset → FIPE oficial).
-- Nenhum projeto chama fipeX/FIPE direto do front. A função devolve sempre o mesmo
-- formato com o campo `fonte` indicando a origem. Valores SEMPRE em centavos.
--
-- Nota de escopo: o documento sugere tenant_id em todas as tabelas. Aqui os dados de
-- REFERÊNCIA da FIPE (fipe_prices, fipe_price_cache, fipe_model_match) são GLOBAIS —
-- preço FIPE e de-para de modelo são iguais para todas as lojas, então compartilhar
-- evita duplicar o dataset por tenant e respeita melhor o limite de 10 req/s do fipeX.
-- Só o SNAPSHOT (preço gravado na negociação) é por tenant + RLS.
-- Padrão de segurança segue vehicle_plate_lookups: RLS on, acesso via service_role.
-- ============================================================================

-- ─── 1) fipe_prices — dataset fipeX (merged) importado como base/reserva ─────
-- Uma linha por (codigo_fipe, ano_modelo, zero_km, sigla_combustivel) por mês de ref.
CREATE TABLE IF NOT EXISTS public.fipe_prices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo_veiculo       text,                         -- carro / moto / caminhao
  codigo_fipe        text NOT NULL,
  nome_modelo        text,
  nome_marca         text,
  nome_combustivel   text,
  sigla_combustivel  text,                         -- G / D / F ...
  ano_modelo         integer,                      -- ano do modelo (32000 = zero km na FIPE; aqui usamos zero_km)
  zero_km            boolean NOT NULL DEFAULT false,
  valor_centavos     bigint NOT NULL,
  valor_formatado    text,
  mes_referencia     integer,                      -- 1..12
  ano_referencia     integer,
  UNIQUE (codigo_fipe, ano_modelo, zero_km, sigla_combustivel, ano_referencia, mes_referencia)
);
CREATE INDEX IF NOT EXISTS fipe_prices_lookup_idx  ON public.fipe_prices (codigo_fipe, ano_modelo, zero_km, sigla_combustivel);
CREATE INDEX IF NOT EXISTS fipe_prices_ref_idx     ON public.fipe_prices (ano_referencia DESC, mes_referencia DESC);
CREATE INDEX IF NOT EXISTS fipe_prices_marca_idx   ON public.fipe_prices (lower(nome_marca), lower(nome_modelo));
ALTER TABLE public.fipe_prices ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.fipe_prices TO service_role;

-- ─── 2) fipe_price_cache — resposta da API fipeX (preço + analytics + histórico) ─
-- Válido até virar o mês de referência. Global (o preço é o mesmo pra todos).
CREATE TABLE IF NOT EXISTS public.fipe_price_cache (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_fipe        text,
  model_slug         text,
  fuel_acronym       text,
  ano_modelo         integer,
  zero_km            boolean NOT NULL DEFAULT false,
  mes_referencia     integer,
  ano_referencia     integer,
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- resposta bruta normalizada do fipeX
  fonte              text NOT NULL DEFAULT 'fipex',
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  hits               integer NOT NULL DEFAULT 1,
  UNIQUE (codigo_fipe, ano_modelo, zero_km, fuel_acronym, ano_referencia, mes_referencia)
);
CREATE INDEX IF NOT EXISTS fipe_price_cache_slug_idx ON public.fipe_price_cache (model_slug, fuel_acronym, ano_modelo);
ALTER TABLE public.fipe_price_cache ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.fipe_price_cache TO service_role;

-- ─── 3) fipe_model_match — de-para texto da placa → modelo FIPE (confirmado) ──
-- Cresce com o uso e evita perguntar de novo. Global (o de-para é universal);
-- guardamos quem confirmou (tenant/membro) só pra auditoria.
CREATE TABLE IF NOT EXISTS public.fipe_model_match (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marca_texto        text NOT NULL,                -- marca vinda da PuxaPlaca (normalizada em minúsculas)
  modelo_texto       text NOT NULL,                -- modelo vindo da PuxaPlaca (normalizado)
  ano_modelo         integer,
  sigla_combustivel  text,
  codigo_fipe        text,                         -- modelo FIPE confirmado
  model_slug         text,
  fuel_acronym       text,
  nome_modelo_fipe   text,
  confirmado_por     uuid,                         -- team_members.id
  tenant_id          uuid,                         -- tenant que confirmou (auditoria)
  hits               integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marca_texto, modelo_texto, ano_modelo, sigla_combustivel)
);
ALTER TABLE public.fipe_model_match ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.fipe_model_match TO service_role;

-- ─── 4) vehicle_fipe_snapshot — preço FIPE gravado na negociação (por tenant) ─
-- Append-only: NUNCA sobrescreve; cada consulta na captação vira uma nova linha
-- (é o preço histórico da negociação).
CREATE TABLE IF NOT EXISTS public.vehicle_fipe_snapshot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  lead_id            uuid,
  seller_vehicle_id  uuid,
  codigo_fipe        text,
  model_slug         text,
  nome_marca         text,
  nome_modelo        text,
  ano_modelo         integer,
  sigla_combustivel  text,
  valor_centavos     bigint,
  mes_referencia     integer,
  ano_referencia     integer,
  fonte              text,                          -- cache | fipex | dataset | fipe_oficial
  analise            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- depreciacao_anual_pct, retencao_valor_pct, anomalia
  historico          jsonb NOT NULL DEFAULT '[]'::jsonb,
  faixa_sugerida     jsonb,                         -- faixa de compra ajustada (km/conservação) — preenchida depois
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vehicle_fipe_snapshot_lead_idx    ON public.vehicle_fipe_snapshot (tenant_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_fipe_snapshot_vehicle_idx ON public.vehicle_fipe_snapshot (tenant_id, seller_vehicle_id, created_at DESC);
ALTER TABLE public.vehicle_fipe_snapshot ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.vehicle_fipe_snapshot TO service_role;
GRANT SELECT ON public.vehicle_fipe_snapshot TO authenticated;
-- O front (tela do lead) lê o snapshot do próprio tenant; escrita é só via edge fn.
DROP POLICY IF EXISTS vehicle_fipe_snapshot_select ON public.vehicle_fipe_snapshot;
CREATE POLICY vehicle_fipe_snapshot_select ON public.vehicle_fipe_snapshot
  FOR SELECT TO authenticated
  USING (public.is_superadmin() OR tenant_id = public.get_tenant_id());
