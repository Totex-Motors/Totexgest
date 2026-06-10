import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface TradeInVehicle {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  deal_id: string | null;
  marca: string | null;
  modelo: string | null;
  versao: string | null;
  ano: number | null;
  km: number | null;
  placa: string | null;
  condicao: 'otimo' | 'bom' | 'regular' | 'ruim' | null;
  valor_pedido: number | null;
  valor_avaliado: number | null;
  observacoes: string | null;
  created_at: string;
  updated_at: string;
}

export type TradeInInput = Omit<TradeInVehicle, 'id' | 'tenant_id' | 'created_at' | 'updated_at'>;

export const useTradeInByLead = (leadId: string | undefined) =>
  useQuery({
    queryKey: ['trade-in', 'lead', leadId],
    queryFn: async () => {
      if (!leadId) return null;
      const { data, error } = await supabase
        .from('trade_in_vehicles')
        .select('*')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as TradeInVehicle | null;
    },
    enabled: !!leadId,
  });

export const useTradeInByDeal = (dealId: string | undefined) =>
  useQuery({
    queryKey: ['trade-in', 'deal', dealId],
    queryFn: async () => {
      if (!dealId) return null;
      const { data, error } = await supabase
        .from('trade_in_vehicles')
        .select('*')
        .eq('deal_id', dealId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as TradeInVehicle | null;
    },
    enabled: !!dealId,
  });

export const useUpsertTradeIn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id?: string; data: Partial<TradeInInput> }) => {
      if (id) {
        const { data: result, error } = await supabase
          .from('trade_in_vehicles')
          .update({ ...data, updated_at: new Date().toISOString() })
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        return result as TradeInVehicle;
      } else {
        const { data: result, error } = await supabase
          .from('trade_in_vehicles')
          .insert(data)
          .select()
          .single();
        if (error) throw error;
        return result as TradeInVehicle;
      }
    },
    onSuccess: (result) => {
      if (result.lead_id) qc.invalidateQueries({ queryKey: ['trade-in', 'lead', result.lead_id] });
      if (result.deal_id) qc.invalidateQueries({ queryKey: ['trade-in', 'deal', result.deal_id] });
    },
  });
};

export const useDeleteTradeIn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, leadId, dealId }: { id: string; leadId?: string | null; dealId?: string | null }) => {
      const { error } = await supabase.from('trade_in_vehicles').delete().eq('id', id);
      if (error) throw error;
      return { leadId, dealId };
    },
    onSuccess: ({ leadId, dealId }) => {
      if (leadId) qc.invalidateQueries({ queryKey: ['trade-in', 'lead', leadId] });
      if (dealId) qc.invalidateQueries({ queryKey: ['trade-in', 'deal', dealId] });
    },
  });
};
