import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";

export type Vehicle = {
  id: string;
  url: string | null;
  title: string;
  description: string | null;
  seller: string;
  category: string | null;
  condition: string | null;
  negotiation: string | null;
  make: string | null;
  model: string | null;
  version: string | null;
  body: string | null;
  year: number | null;
  fabric_year: number | null;
  color: string | null;
  mileage: number | null;
  fuel: string | null;
  gear: string | null;
  motor: string | null;
  doors: number | null;
  hp: string | null;
  fipe: string | null;
  plate: string | null;
  full_plate: string | null;
  price: number | null;
  regular_price: number | null;
  promotion_price: number | null;
  location_city: string | null;
  location_state: string | null;
  neighborhood: string | null;
  zip_code: string | null;
  images: string[];
  features: string[];
  video: string | null;
  is_active: boolean;
  is_sold: boolean;
  last_seen_at: string;
  published_at: string | null;
  last_updated_at: string | null;
  updated_at: string;
};

export type VehicleFilters = {
  seller?: string;
  condition?: "novo" | "usado";
  make?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
};

export const useVehicles = (filters: VehicleFilters = {}) => {
  return useQuery({
    queryKey: ["vehicles", filters],
    staleTime: 60_000,
    queryFn: async () => {
      let q = supabase
        .from("vehicles")
        .select("*")
        .eq("is_active", true)
        .order("price", { ascending: false });

      if (filters.seller) q = q.eq("seller", filters.seller);
      if (filters.condition) q = q.eq("condition", filters.condition);
      if (filters.make) q = q.eq("make", filters.make);
      if (filters.minPrice != null) q = q.gte("price", filters.minPrice);
      if (filters.maxPrice != null) q = q.lte("price", filters.maxPrice);
      if (filters.search) {
        const s = filters.search.trim();
        q = q.or(`title.ilike.%${s}%,make.ilike.%${s}%,model.ilike.%${s}%,full_plate.ilike.%${s}%`);
      }

      const { data, error } = await q.limit(500);
      if (error) throw error;
      return (data || []) as Vehicle[];
    },
  });
};

export const useVehicleStats = () => {
  return useQuery({
    queryKey: ["vehicle-stats"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("seller, condition, price, is_active");
      if (error) throw error;
      const rows = (data || []) as Pick<Vehicle, "seller" | "condition" | "price" | "is_active">[];
      const active = rows.filter((r) => r.is_active);
      const bySeller: Record<string, { total: number; novos: number; usados: number; valor: number }> = {};
      for (const r of active) {
        const k = r.seller || "Outros";
        if (!bySeller[k]) bySeller[k] = { total: 0, novos: 0, usados: 0, valor: 0 };
        bySeller[k].total++;
        if (r.condition === "novo") bySeller[k].novos++;
        if (r.condition === "usado") bySeller[k].usados++;
        bySeller[k].valor += Number(r.price || 0);
      }
      return {
        total: active.length,
        valor_total: active.reduce((a, r) => a + Number(r.price || 0), 0),
        bySeller,
      };
    },
  });
};

export const useSyncVehicles = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const res = await fetch(`${supabaseUrl}/functions/v1/sync-vehicle-stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error(`Sync HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast.success("Estoque sincronizado", {
        description: `${data.upserted ?? 0} veículos atualizados em ${data.elapsed_ms}ms`,
      });
      qc.invalidateQueries({ queryKey: ["vehicles"] });
      qc.invalidateQueries({ queryKey: ["vehicle-stats"] });
    },
    onError: (e: any) => {
      toast.error("Falha ao sincronizar estoque", { description: e.message });
    },
  });
};

export const useVehicleMakes = () => {
  return useQuery({
    queryKey: ["vehicle-makes"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("vehicles").select("make").eq("is_active", true);
      const makes = new Set((data || []).map((r: any) => r.make).filter(Boolean));
      return Array.from(makes).sort() as string[];
    },
  });
};
