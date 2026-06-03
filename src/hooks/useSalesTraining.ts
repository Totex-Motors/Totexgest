import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

export interface TrainingCase {
  id: string;
  title: string;
  description: string | null;
  category: string;
  source_type: string;
  call_history_id: string | null;
  meeting_id: string | null;
  transcription: any;
  ai_analysis: any;
  record_url: string | null;
  key_moments: any;
  notes: string | null;
  tags: string[];
  difficulty: string | null;
  outcome: string | null;
  lead_id: string | null;
  sales_rep_id: string | null;
  created_by: string | null;
  rating: number | null;
  view_count: number;
  created_at: string;
  updated_at: string;
  // joins
  lead?: { id: string; name: string } | null;
  sales_rep?: { id: string; name: string } | null;
}

export interface CreateTrainingCaseInput {
  title: string;
  description?: string;
  category: string;
  source_type: string;
  call_history_id?: string;
  meeting_id?: string;
  transcription?: any;
  ai_analysis?: any;
  record_url?: string;
  key_moments?: any;
  notes?: string;
  tags?: string[];
  difficulty?: string;
  outcome?: string;
  lead_id?: string;
  sales_rep_id?: string;
}

export function useSalesTrainingCases(filters?: {
  category?: string;
  outcome?: string;
  difficulty?: string;
  search?: string;
}) {
  return useQuery({
    queryKey: ['sales-training-cases', filters],
    queryFn: async () => {
      let query = supabase
        .from('sales_training_cases')
        .select('*, lead:leads(id, name), sales_rep:team_members(id, name)')
        .order('created_at', { ascending: false });

      if (filters?.category && filters.category !== 'all') {
        query = query.eq('category', filters.category);
      }
      if (filters?.outcome && filters.outcome !== 'all') {
        query = query.eq('outcome', filters.outcome);
      }
      if (filters?.difficulty && filters.difficulty !== 'all') {
        query = query.eq('difficulty', filters.difficulty);
      }
      if (filters?.search) {
        query = query.or(`title.ilike.%${filters.search}%,notes.ilike.%${filters.search}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as TrainingCase[];
    },
  });
}

export function useCreateTrainingCase() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateTrainingCaseInput) => {
      const { data, error } = await supabase
        .from('sales_training_cases')
        .insert({ ...input, created_by: user?.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales-training-cases'] });
    },
  });
}

export function useDeleteTrainingCase() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('sales_training_cases')
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sales-training-cases'] });
    },
  });
}

export function useIncrementViewCount() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('increment_training_view_count' as any, { case_id: id });
      // Fallback if RPC doesn't exist
      if (error) {
        await supabase
          .from('sales_training_cases')
          .update({ view_count: supabase.rpc('increment_training_view_count' as any, { case_id: id }) as any })
          .eq('id', id);
      }
    },
  });
}
