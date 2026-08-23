import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// BI dos tipos de interação da concessionária (Fase 3 do funil):
// volume por tipo, taxa de comparecimento (apresentações agendadas) e
// conversão apresentação → venda. RLS escopa por tenant.

const PRESENTATION_TYPES = ['video_call', 'visit'];

export interface InteractionTypeStat {
  key: string;
  total: number;
  completed: number;
  no_show: number;
}

export interface InteractionMetrics {
  byType: Record<string, InteractionTypeStat>;
  total: number;
  // Comparecimento: apresentações (vídeo/visita) concluídas vs no-show
  presAttended: number;
  presNoShow: number;
  attendanceRate: number | null; // % (completadas / (completadas + no_show))
  // Conversão: leads com apresentação concluída no período que viraram venda
  presLeads: number;
  presWon: number;
  conversionRate: number | null;
}

interface Row {
  task_type: string;
  status: string | null;
  completed: boolean | null;
  lead_id: string | null;
}

export function useInteractionMetrics(dateRange: { from: Date; to: Date }) {
  const fromIso = dateRange.from.toISOString();
  const toIso = dateRange.to.toISOString();

  return useQuery({
    queryKey: ['interaction-metrics', fromIso, toIso],
    queryFn: async (): Promise<InteractionMetrics> => {
      const { data, error } = await supabase
        .from('company_activities')
        .select('task_type, status, completed, lead_id')
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .limit(5000);
      if (error) throw error;

      const rows = (data || []) as Row[];
      const byType: Record<string, InteractionTypeStat> = {};
      let presAttended = 0;
      let presNoShow = 0;
      const presLeadIds = new Set<string>();

      for (const r of rows) {
        const t = r.task_type || 'other';
        const s = (byType[t] = byType[t] || { key: t, total: 0, completed: 0, no_show: 0 });
        s.total++;
        if (r.status === 'no_show') s.no_show++;
        else if (r.completed && r.status === 'completed') s.completed++;

        if (PRESENTATION_TYPES.includes(t)) {
          if (r.status === 'no_show') presNoShow++;
          else if (r.completed && r.status === 'completed') {
            presAttended++;
            if (r.lead_id) presLeadIds.add(r.lead_id);
          }
        }
      }

      // Conversão: dos leads com apresentação concluída, quantos têm deal ganho
      let presWon = 0;
      if (presLeadIds.size > 0) {
        const ids = [...presLeadIds];
        const { data: wonDeals } = await supabase
          .from('deals')
          .select('lead_id')
          .eq('status', 'won')
          .in('lead_id', ids);
        const wonSet = new Set((wonDeals || []).map((d: { lead_id: string }) => d.lead_id));
        presWon = ids.filter((id) => wonSet.has(id)).length;
      }

      const presDone = presAttended + presNoShow;
      return {
        byType,
        total: rows.length,
        presAttended,
        presNoShow,
        attendanceRate: presDone > 0 ? Math.round((presAttended / presDone) * 100) : null,
        presLeads: presLeadIds.size,
        presWon,
        conversionRate: presLeadIds.size > 0 ? Math.round((presWon / presLeadIds.size) * 100) : null,
      };
    },
    staleTime: 60_000,
  });
}
