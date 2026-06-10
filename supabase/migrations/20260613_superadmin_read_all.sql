-- Super-admin (Totex) com visão de OVERSIGHT: leitura cross-tenant de todas as
-- tabelas que têm tenant_id. Abordagem ADITIVA e segura: adiciona uma policy
-- permissiva de SELECT por is_superadmin() em cada tabela — não altera as policies
-- de isolamento existentes (políticas permissivas são combinadas por OR).
-- Só LEITURA: super-admin não ganha escrita cross-tenant por aqui.

DO $$
DECLARE
  r record;
  pol_name text;
BEGIN
  FOR r IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND a.attname = 'tenant_id'
       AND NOT a.attisdropped
  LOOP
    pol_name := r.table_name || '_superadmin_read';
    -- NÃO habilitamos RLS aqui de propósito: ativar RLS numa tabela hoje aberta
    -- restringiria usuários normais. Apenas adicionamos a policy (inócua se a RLS
    -- estiver desligada; aditiva onde já está ligada).
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, r.table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_superadmin())',
      pol_name, r.table_name
    );
  END LOOP;
END $$;
