-- Super-admin no nível do TENANT: qualquer membro de um tenant super-admin é super-admin.
-- (Pedido: "o super-admin precisa ser o tenant todo, não só usuários".)

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

-- Marca o tenant super-admin atual.
UPDATE public.tenants
   SET is_super_admin = true
 WHERE id = 'c13681e3-5db9-48d1-9c5c-856e6041d77f';

-- Redefine is_superadmin() para considerar super-admin quem:
--   (a) tem a flag por-usuário team_members.is_superadmin = true  (compatibilidade), OU
--   (b) pertence a um tenant com tenants.is_super_admin = true     (super-admin "do tenant todo").
-- Mantém a assinatura/uso: todas as policies RLS que já chamam public.is_superadmin()
-- passam a tratar qualquer membro do tenant super-admin como super-admin automaticamente.
CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.team_members tm
      LEFT JOIN public.tenants t ON t.id = tm.tenant_id
     WHERE tm.auth_user_id = auth.uid()
       AND (tm.is_superadmin = true OR t.is_super_admin = true)
  );
END;
$$;

COMMENT ON COLUMN public.tenants.is_super_admin IS
  'Quando true, todos os membros deste tenant são super-admins (is_superadmin() retorna true para eles).';
