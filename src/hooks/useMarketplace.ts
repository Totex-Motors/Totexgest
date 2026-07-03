import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MarketplaceStoreMapping {
  id: string;
  marketplace_store_id: string;
  store_name: string;
  tenant_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceVehicleMetadata {
  id?: string;
  description?: string;
  brand?: string;
  model?: string;
  version?: string;
  year?: number;
  mileage?: number;
  price?: number;
  price_formatted?: string;
}

export interface MarketplaceLeadMetadata {
  marketplace_lead_id?: string;
  marketplace_store_id?: string;
  marketplace_store_name?: string;
  vehicle?: MarketplaceVehicleMetadata;
  store?: {
    name?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    address?: string;
  };
}

export interface MarketplaceLead {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  city_name?: string;
  state?: string;
  context?: string;
  source: string;
  status: string;
  created_at: string;
  metadata: MarketplaceLeadMetadata;
}

// ─── Leads vindos do marketplace ─────────────────────────────────────────────

export interface MarketplaceLeadFilters {
  search?: string;
  storeId?: string; // marketplace_store_id
}

export const useMarketplaceLeads = (filters: MarketplaceLeadFilters = {}) => {
  const { search, storeId } = filters;
  return useQuery({
    queryKey: ["marketplace-leads", search, storeId],
    queryFn: async () => {
      let query = supabase
        .from("leads")
        .select("id, name, email, phone, city_name, state, context, source, status, created_at, metadata")
        .eq("source", "marketplace")
        .order("created_at", { ascending: false })
        .limit(200);

      if (search?.trim()) {
        query = query.or(
          `name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`
        );
      }

      if (storeId) {
        query = query.eq("metadata->>marketplace_store_id", storeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as MarketplaceLead[];
    },
  });
};

// ─── Mapeamentos de loja ──────────────────────────────────────────────────────

export const useMarketplaceMappings = () => {
  return useQuery({
    queryKey: ["marketplace-mappings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("marketplace_store_mappings")
        .select("*")
        .order("store_name");
      if (error) throw error;
      return (data ?? []) as MarketplaceStoreMapping[];
    },
  });
};

export const useCreateMarketplaceMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      mapping: Pick<MarketplaceStoreMapping, "marketplace_store_id" | "store_name" | "tenant_id">
    ) => {
      const { data, error } = await supabase
        .from("marketplace_store_mappings")
        .insert({ ...mapping, active: true })
        .select()
        .single();
      if (error) throw error;
      return data as MarketplaceStoreMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace-mappings"] });
      toast.success("Loja adicionada com sucesso");
    },
    onError: (err: any) => {
      const isDuplicate = err?.code === "23505";
      toast.error(isDuplicate ? "Já existe um mapeamento para esse ID de loja" : "Erro ao salvar loja");
    },
  });
};

export const useUpdateMarketplaceMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<MarketplaceStoreMapping> & { id: string }) => {
      const { data, error } = await supabase
        .from("marketplace_store_mappings")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as MarketplaceStoreMapping;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace-mappings"] });
      toast.success("Loja atualizada");
    },
    onError: () => toast.error("Erro ao atualizar loja"),
  });
};

export const useDeleteMarketplaceMapping = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("marketplace_store_mappings")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marketplace-mappings"] });
      toast.success("Loja removida");
    },
    onError: () => toast.error("Erro ao remover loja"),
  });
};
