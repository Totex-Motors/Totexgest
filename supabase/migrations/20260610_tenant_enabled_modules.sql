-- Módulos por-tenant: cada loja passa a ter seu próprio conjunto de módulos ativos.
-- Antes era global (config.enabled_modules). Módulos pagos/opcionais (ex: Credere)
-- passam a ser controlados por loja pelo super-admin.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS enabled_modules jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Semeia o tenant super-admin (atual, com tudo em uso) preservando o comportamento atual.
UPDATE public.tenants
   SET enabled_modules = '{
     "comercial": true,
     "gestao": true,
     "credere": true,
     "marketplace": true,
     "telefonia": false,
     "analytics": false
   }'::jsonb
 WHERE id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f'
   AND enabled_modules = '{}'::jsonb;

COMMENT ON COLUMN public.tenants.enabled_modules IS
  'Módulos ativos por tenant (jsonb {modulo: bool}). Chaves não presentes caem no default do módulo. Substitui o antigo config.enabled_modules global.';
