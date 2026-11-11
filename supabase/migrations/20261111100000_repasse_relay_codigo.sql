-- REPASSE RELAY — código por grupo e referência por post (Marco, 11/11/2026).
--
-- Cada grupo de repasse ganha um código curto (R1, R2, R3… por loja). Todo carro repostado na
-- comunidade sai com uma linha "Ref. R2-1111-1432" no rodapé (grupo R2, postado em 11/11 às
-- 14:32, horário de Brasília). Com a Ref. dá pra saber de qual grupo veio e quando foi postado,
-- sem revelar nada pro cliente. A busca fica em Configurações › Repasse → Comunidade.

ALTER TABLE public.repasse_relay_config ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.repasse_relay_config ADD COLUMN IF NOT EXISTS source_group_name text;
ALTER TABLE public.repasse_relay_posts  ADD COLUMN IF NOT EXISTS ref_code text;

-- Códigos das configs que já existem: R1, R2… pela ordem de criação, por loja.
WITH ord AS (
  SELECT id, 'R' || row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS c
  FROM public.repasse_relay_config WHERE code IS NULL
)
UPDATE public.repasse_relay_config r SET code = ord.c FROM ord
WHERE r.id = ord.id
  AND NOT EXISTS (SELECT 1 FROM public.repasse_relay_config x WHERE x.tenant_id = r.tenant_id AND x.code IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS repasse_relay_config_code_uniq ON public.repasse_relay_config (tenant_id, code);
CREATE INDEX IF NOT EXISTS repasse_relay_posts_ref_idx ON public.repasse_relay_posts (tenant_id, ref_code) WHERE ref_code IS NOT NULL;

-- Config nova sem código ganha o próximo número da loja (código nunca é reaproveitado).
CREATE OR REPLACE FUNCTION public.repasse_relay_set_code() RETURNS trigger
LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  IF NEW.code IS NULL OR btrim(NEW.code) = '' THEN
    PERFORM pg_advisory_xact_lock(hashtext('repasse_relay_code:' || coalesce(NEW.tenant_id::text, '')));
    SELECT coalesce(max(nullif(regexp_replace(code, '\D', '', 'g'), '')::int), 0) + 1 INTO n
      FROM public.repasse_relay_config WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id;
    NEW.code := 'R' || n;
  ELSE
    NEW.code := upper(btrim(NEW.code));
  END IF;
  RETURN NEW;
END $f$;

DROP TRIGGER IF EXISTS trg_repasse_relay_set_code ON public.repasse_relay_config;
CREATE TRIGGER trg_repasse_relay_set_code BEFORE INSERT ON public.repasse_relay_config
  FOR EACH ROW EXECUTE FUNCTION public.repasse_relay_set_code();

-- Ref. única por grupo (o relay reserva a Ref. antes de postar; colisão → "-2", "-3"…).
-- Os 3 primeiros posts de 11/11 14:57 saíram com a mesma Ref. antes dessa trava e ficam como estão.
CREATE UNIQUE INDEX IF NOT EXISTS repasse_relay_posts_ref_uniq
  ON public.repasse_relay_posts (config_id, ref_code)
  WHERE ref_code IS NOT NULL AND created_at >= '2026-11-11 18:00:00+00';
