import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import type { LeadQualificacao } from "@/components/sales/LeadQualificationCard";

/**
 * Leads do Totem Físico — clientes que conversaram com a IA do stand.
 * Identificados por `source = 'stand'` (marcado no agent-platform na 1ª mensagem).
 * Escopo de tenant via RLS: o super-admin (tenant Totex) vê os seus.
 */
export interface TotemLead {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  city_name?: string | null;
  state?: string | null;
  context?: string | null;
  status?: string | null;
  sales_score?: number | null;
  created_at: string;
  metadata: {
    qualificacao?: LeadQualificacao | null;
    vehicle?: { brand?: string; model?: string; version?: string; year?: number; price_formatted?: string } | null;
    /** Loja pra qual a IA encaminhou o lead (preenchido pelo stand-handoff). */
    handoff?: { encaminhado?: boolean; loja?: string | null; em?: string } | null;
    marketplace_store_name?: string | null;
  } | null;
}

export const useTotemLeads = (search?: string) => {
  return useQuery({
    queryKey: ["totem-leads", search],
    queryFn: async () => {
      let query = supabase
        .from("leads")
        .select("id, name, email, phone, city_name, state, context, status, sales_score, created_at, metadata")
        // Os webhooks do totem podem gravar o canal em `source` ('stand', lado Totex)
        // ou em `utm_source` ('stand_totex', lado loja via stand-handoff). Cobre os dois.
        .or("source.eq.stand,utm_source.ilike.stand%")
        .order("created_at", { ascending: false })
        .limit(200);

      if (search?.trim()) {
        query = query.or(`name.ilike.%${search}%,phone.ilike.%${search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as TotemLead[];
    },
  });
};
