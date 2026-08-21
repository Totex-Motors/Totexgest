import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface SupervisorBriefingInput {
  stats: Record<string, unknown>;
  unattended: Record<string, unknown>[];
  overdueByRep: Record<string, unknown>[];
}

export interface SupervisorBriefingResult {
  plano: string | null;
  raw?: string;
}

// Chama a edge function supervisor-briefing (IA analisa a fila e devolve um
// plano de ação priorizado pro supervisor). tenant_id resolvido pela function
// via JWT do usuário logado.
export function useSupervisorBriefing() {
  return useMutation({
    mutationFn: async (input: SupervisorBriefingInput): Promise<SupervisorBriefingResult> => {
      const { data, error } = await supabase.functions.invoke('supervisor-briefing', {
        body: input,
      });
      if (error) throw error;
      return data as SupervisorBriefingResult;
    },
  });
}
