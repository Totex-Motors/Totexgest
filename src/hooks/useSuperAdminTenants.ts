import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
  is_super_admin: boolean;
  external_dealership_id: string | null;
  enabled_modules: Record<string, boolean>;
  created_at: string;
  members_total: number;
  members_active: number;
}

export interface ProvisionTenantInput {
  trade_name: string;
  cnpj?: string;
  whatsapp?: string;
  legal_name?: string;
  external_dealership_id?: string;
  modules?: Record<string, boolean>;
  /** Opcional — se omitido, o tenant é criado sem admin (convida depois). */
  admin?: { name: string; email: string; phone?: string };
}

export interface ProvisionTenantResult {
  tenant_id: string;
  user_id: string | null;
  invite_url: string | null;
}

// Helper: chama a edge function e propaga o erro de forma legível
async function callAdminTenants<T>(action: string, data?: unknown): Promise<T> {
  const { data: res, error } = await supabase.functions.invoke("admin-tenants", {
    body: { action, data },
  });
  if (error) {
    let message = error.message;
    try {
      const body = await (error as { context?: { json?: () => Promise<{ error?: string }> } }).context?.json?.();
      if (body?.error) message = body.error;
    } catch { /* mantém mensagem genérica */ }
    throw new Error(message);
  }
  if (res?.error) throw new Error(res.error);
  return res as T;
}

// ─── Queries / Mutations ──────────────────────────────────────────────────────

export const useSuperAdminTenants = () => {
  return useQuery({
    queryKey: ["super-admin-tenants"],
    queryFn: async () => {
      const res = await callAdminTenants<{ tenants: AdminTenant[] }>("list");
      return res.tenants ?? [];
    },
  });
};

export const useProvisionTenant = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProvisionTenantInput) =>
      callAdminTenants<ProvisionTenantResult>("provision", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["super-admin-tenants"] });
      toast.success("Loja criada com sucesso");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao criar loja"),
  });
};

export const useSetTenantStatus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tenant_id: string; is_active: boolean }) =>
      callAdminTenants<{ success: boolean }>("set_status", vars),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["super-admin-tenants"] });
      toast.success(vars.is_active ? "Loja ativada" : "Loja desativada");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao atualizar status"),
  });
};

export const useSetTenantModule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tenant_id: string; module: string; enabled: boolean }) =>
      callAdminTenants<{ success: boolean }>("set_module", vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["super-admin-tenants"] });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao atualizar módulo"),
  });
};

export interface InviteAdminResult {
  user_id: string;
  invite_url: string | null;
}

export const useInviteTenantAdmin = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tenant_id: string; name: string; email: string; phone?: string }) =>
      callAdminTenants<InviteAdminResult>("invite_admin", vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["super-admin-tenants"] });
      toast.success("Convite enviado ao admin da loja");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao convidar admin"),
  });
};
