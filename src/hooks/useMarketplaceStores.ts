import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Lojas roteáveis do marketplace — as que têm destino de lead configurado
 * (tenant_lead_destinations). Usadas no fluxo "Comprar" da captação: a promotora
 * escolhe a loja do carro que o cliente está olhando no totem, e o lead é
 * distribuído pro tenant dessa loja (via distribuir-lead).
 *
 * RPC list_marketplace_stores() (SECURITY DEFINER) → { tenant_id, name }[].
 */

export type MarketplaceStore = { tenant_id: string; name: string };

export function useMarketplaceStores() {
  return useQuery({
    queryKey: ["marketplace-stores"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MarketplaceStore[]> => {
      const { data, error } = await supabase.rpc("list_marketplace_stores");
      if (error) throw error;
      return (data ?? []) as MarketplaceStore[];
    },
  });
}
