import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CredereStoreMapping {
  id: string;
  credere_store_id: string;
  store_name: string;
  tenant_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CredereVehicleMetadata {
  description?: string;
  assets_value?: number;
  manufacture_year?: number;
  model_year?: number;
  brand?: string;
  model?: string;
  category?: string;
  fuel?: string;
  licensing_uf?: string;
}

export interface CredereFinancingMetadata {
  bank?: string;
  installments?: number;
  interest_monthly?: number;
  down_payment?: number;
  financed_amount?: number;
}

export interface CredereLeadMetadata {
  credere_simulation_uuid?: string;
  credere_store_id?: string;
  credere_store_name?: string;
  vehicle?: CredereVehicleMetadata;
  financing?: CredereFinancingMetadata;
  seller?: { name?: string; id?: string };
  simulation_created_at?: string;
}

export interface CredereLead {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  city_name?: string;
  state?: string;
  source: string;
  status: string;
  created_at: string;
  metadata: CredereLeadMetadata;
}

// ─── Leads vindos da Credere ─────────────────────────────────────────────────

export const useCredereLeads = (search?: string) => {
  return useQuery({
    queryKey: ["credere-leads", search],
    queryFn: async () => {
      let query = supabase
        .from("leads")
        .select("id, name, email, phone, city_name, state, source, status, created_at, metadata")
        .eq("source", "credere")
        .order("created_at", { ascending: false })
        .limit(200);

      if (search?.trim()) {
        query = query.or(
          `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`
        );
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as CredereLead[];
    },
  });
};

// ─── Mapeamentos de loja ──────────────────────────────────────────────────────

export const useCredereMappings = () => {
  return useQuery({
    queryKey: ["credere-mappings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("credere_store_mappings")
        .select("*")
        .order("store_name");
      if (error) throw error;
      return (data ?? []) as CredereStoreMapping[];
    },
  });
};

export const useCreateCredereMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      mapping: Pick<CredereStoreMapping, "credere_store_id" | "store_name" | "tenant_id">
    ) => {
      const { data, error } = await supabase
        .from("credere_store_mappings")
        .insert({ ...mapping, active: true })
        .select()
        .single();
      if (error) throw error;
      return data as CredereStoreMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credere-mappings"] });
      toast.success("Loja adicionada com sucesso");
    },
    onError: (err: any) => {
      const isDuplicate = err?.code === "23505";
      toast.error(isDuplicate ? "Já existe um mapeamento para esse ID de loja" : "Erro ao salvar loja");
    },
  });
};

export const useUpdateCredereMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<CredereStoreMapping> & { id: string }) => {
      const { data, error } = await supabase
        .from("credere_store_mappings")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as CredereStoreMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credere-mappings"] });
      toast.success("Loja atualizada");
    },
    onError: () => toast.error("Erro ao atualizar loja"),
  });
};

export const useDeleteCredereMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("credere_store_mappings")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["credere-mappings"] });
      toast.success("Loja removida");
    },
    onError: () => toast.error("Erro ao remover loja"),
  });
};
