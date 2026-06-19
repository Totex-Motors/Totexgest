import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LeadDestination {
  id: string;
  tenant_id: string;
  destination_type: "number" | "group";
  whatsapp_target: string;
  label: string | null;
  active: boolean;
  updated_at: string;
}

export interface TenantDestinationRow {
  tenant_id: string;
  tenant_name: string;
  destination: LeadDestination | null;
}

// Reusa o mesmo padrão de chamada do useSuperAdminTenants (edge fn admin-tenants).
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

export const useLeadDestinations = () => {
  return useQuery({
    queryKey: ["lead-destinations"],
    queryFn: async () => {
      const res = await callAdminTenants<{ destinations: TenantDestinationRow[] }>("list_destinations");
      return res.destinations ?? [];
    },
  });
};

export const useSetLeadDestination = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      tenant_id: string;
      whatsapp_target: string;
      label?: string;
      destination_type?: "number" | "group";
    }) => callAdminTenants<{ success: boolean; destination: LeadDestination }>("set_destination", vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lead-destinations"] });
      toast.success("Destino salvo");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao salvar destino"),
  });
};

export const useDeleteLeadDestination = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { tenant_id: string }) =>
      callAdminTenants<{ success: boolean }>("delete_destination", vars),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lead-destinations"] });
      toast.success("Destino removido");
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao remover destino"),
  });
};
