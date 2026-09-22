import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Estoque de veículos — vem da API PÚBLICA do marketplace Totex, via edge
 * function `consultar-estoque` (formato=completo), a MESMA que o agente usa.
 *
 * Decisão de arquitetura (PLANNING-AUTOMOTIVO): o CRM NÃO guarda estoque —
 * a antiga tabela local `vehicles` nunca existiu em produção, por isso o
 * "Inserir veículo do estoque" não capturava nada. A API do marketplace
 * exige termo de busca (e não manda CORS), daí a edge function no meio.
 */

export type Vehicle = {
  id: string;
  title: string;
  year: number | null;
  price: number | null;
  mileage: number | null;
  color: string | null;
  fuel: string | null;
  transmission: string | null;
  city: string | null;
  state: string | null;
  /** Nome da loja dona do veículo (marketplace multi-loja) */
  dealership: string | null;
  images: string[];
  /** Link público do anúncio no marketplace */
  url: string | null;
  /** Derivado: 0 km = novo */
  condition: "novo" | "usado";
};

export type VehicleFilters = {
  search?: string;
  /** Nome da loja (tenant) pra escopar o estoque a uma loja só — usado na captação "Comprar". */
  loja?: string;
  /** tenant_id da loja — escopo determinístico (imune a nomes duplicados). Preferível ao `loja`. */
  tenantId?: string;
};

const MIN_SEARCH_LEN = 2;

export const useVehicles = (filters: VehicleFilters = {}) => {
  const search = (filters.search || "").trim();
  const loja = (filters.loja || "").trim();
  const tenantId = (filters.tenantId || "").trim();

  return useQuery({
    queryKey: ["vehicles-marketplace", search, loja, tenantId],
    staleTime: 60_000,
    // API do marketplace exige termo de busca (500 sem `search`)
    enabled: search.length >= MIN_SEARCH_LEN,
    queryFn: async (): Promise<Vehicle[]> => {
      const { data, error } = await supabase.functions.invoke("consultar-estoque", {
        body: { arguments: { busca: search, limite: 24, formato: "completo", ...(tenantId ? { tenant_id: tenantId } : {}), ...(loja ? { loja } : {}) } },
      });
      if (error) throw new Error(error.message || "Erro consultando estoque");
      const list: any[] = Array.isArray(data?.veiculos) ? data.veiculos : [];
      return list.map((v) => ({
        id: String(v.id),
        title: String(v.title || ""),
        year: v.year ?? null,
        price: v.price ?? null,
        mileage: v.mileage ?? null,
        color: v.color ?? null,
        fuel: v.fuel ?? null,
        transmission: v.transmission ?? null,
        city: v.city ?? null,
        state: v.state ?? null,
        dealership: v.dealership ?? null,
        images: Array.isArray(v.images) ? v.images : [],
        url: v.url ?? null,
        condition: Number(v.mileage) === 0 ? "novo" : "usado",
      }));
    },
  });
};
