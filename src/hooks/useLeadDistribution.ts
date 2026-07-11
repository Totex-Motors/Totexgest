import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

// =====================================================
// TYPES
// =====================================================

export interface DistributionConfig {
  id: string;
  name: string;
  is_active: boolean;
  method: string;
  pipeline_id: string | null;
  product_id: string | null;
  first_stage_id: string | null;
  require_availability: boolean;
  auto_create_deal: boolean;
  api_key: string;
  created_at: string;
  updated_at: string;
  // Regras de roteamento WhatsApp (multi-canal). Backward-compat: NULL = casa com qualquer entrada.
  match_instance_id: string | null;
  match_keywords: string[] | null;
  match_type: 'any' | 'all' | 'none';
  match_first_msg_only: boolean;
  priority: number;
  // Forms / pages Meta Lead Ads que essa distribuicao recebe.
  // NULL = nao recebe Meta especificamente (fallback do tenant).
  match_meta_form_ids: string[] | null;
  match_meta_page_ids: string[] | null;
}

export interface DistributionMember {
  id: string;
  config_id: string;
  team_member_id: string;
  weight: number;
  is_active: boolean;
  position: number;
  team_member?: {
    id: string;
    name: string;
    current_activity: string | null;
  };
}

export interface DistributionLog {
  id: string;
  config_id: string;
  lead_id: string;
  deal_id: string | null;
  team_member_id: string;
  method_used: string;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  lead?: { id: string; name: string; phone: string };
  team_member?: { id: string; name: string };
}

// =====================================================
// CONFIG
// =====================================================

export const useDistributionConfig = () => {
  return useQuery({
    queryKey: ['distribution-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lead_distribution_config')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data as DistributionConfig | null;
    },
  });
};

// Get ALL configs for the tenant (admin view — includes inactive)
export const useDistributionConfigs = () => {
  return useQuery({
    queryKey: ['distribution-configs-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lead_distribution_config')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return (data || []) as DistributionConfig[];
    },
    staleTime: 5 * 60 * 1000,
  });
};

export const useCreateDistributionConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: Partial<DistributionConfig>) => {
      const { data, error } = await supabase
        .from('lead_distribution_config')
        .insert({
          name: input.name || 'Distribuição Padrão',
          method: input.method || 'round_robin',
          pipeline_id: input.pipeline_id || null,
          product_id: input.product_id || null,
          first_stage_id: input.first_stage_id || null,
          require_availability: input.require_availability ?? false,
          auto_create_deal: input.auto_create_deal ?? true,
          is_active: true,
        })
        .select()
        .single();

      if (error) throw error;
      return data as DistributionConfig;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['distribution-config'] });
      queryClient.invalidateQueries({ queryKey: ['distribution-configs-all'] });
    },
  });
};

export const useUpdateDistributionConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string } & Partial<DistributionConfig>) => {
      const { id, ...updates } = input;
      // Remove fields that shouldn't be updated directly
      delete (updates as Record<string, unknown>).api_key;
      delete (updates as Record<string, unknown>).created_at;
      delete (updates as Record<string, unknown>).updated_at;

      const { data, error } = await supabase
        .from('lead_distribution_config')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data as DistributionConfig;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['distribution-config'] });
      queryClient.invalidateQueries({ queryKey: ['distribution-configs-all'] });
    },
  });
};

export const useRegenerateApiKey = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (configId: string) => {
      const newKey = crypto.randomUUID();
      const { error } = await supabase
        .from('lead_distribution_config')
        .update({ api_key: newKey })
        .eq('id', configId);

      if (error) throw error;
      return newKey;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['distribution-config'] });
      queryClient.invalidateQueries({ queryKey: ['distribution-configs-all'] });
    },
  });
};

// =====================================================
// MEMBERS
// =====================================================

export const useDistributionMembers = (configId: string | undefined) => {
  return useQuery({
    queryKey: ['distribution-members', configId],
    queryFn: async () => {
      if (!configId) return [];

      const { data, error } = await supabase
        .from('lead_distribution_members')
        .select('*, team_member:team_members(id, name, current_activity, sub_role, allowed_pipeline_ids, access_profile_id)')
        .eq('config_id', configId)
        .order('position', { ascending: true });

      if (error) throw error;
      return (data || []) as DistributionMember[];
    },
    enabled: !!configId,
  });
};

export const useAddDistributionMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { config_id: string; team_member_id: string }) => {
      // Get max position
      const { data: existing } = await supabase
        .from('lead_distribution_members')
        .select('position')
        .eq('config_id', input.config_id)
        .order('position', { ascending: false })
        .limit(1);

      const nextPosition = existing && existing.length > 0 ? existing[0].position + 1 : 0;

      const { data, error } = await supabase
        .from('lead_distribution_members')
        .insert({
          config_id: input.config_id,
          team_member_id: input.team_member_id,
          position: nextPosition,
          is_active: true,
        })
        .select('*, team_member:team_members(id, name, current_activity, sub_role)')
        .single();

      if (error) throw error;
      return data as DistributionMember;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['distribution-members', vars.config_id] });
    },
  });
};

export const useRemoveDistributionMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; config_id: string }) => {
      const { error } = await supabase
        .from('lead_distribution_members')
        .delete()
        .eq('id', input.id);

      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['distribution-members', vars.config_id] });
    },
  });
};

export const useToggleDistributionMember = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; config_id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from('lead_distribution_members')
        .update({ is_active: input.is_active })
        .eq('id', input.id);

      if (error) throw error;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['distribution-members', vars.config_id] });
    },
  });
};

export const useDeleteDistributionConfig = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (configId: string) => {
      // Desvincular formulários antes de deletar (para não quebrar FK)
      await supabase
        .from('marketing_forms')
        .update({ distribution_config_id: null })
        .eq('distribution_config_id', configId);

      // Deletar members (CASCADE deve pegar, mas garante explicitamente)
      await supabase
        .from('lead_distribution_members')
        .delete()
        .eq('config_id', configId);

      // Deletar config
      const { error } = await supabase
        .from('lead_distribution_config')
        .delete()
        .eq('id', configId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['distribution-config'] });
      queryClient.invalidateQueries({ queryKey: ['distribution-configs-all'] });
      queryClient.invalidateQueries({ queryKey: ['marketing-forms'] });
    },
  });
};

export const useUpdateDistributionMemberWeight = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; config_id: string; weight: number }) => {
      // 1. Atualiza peso do membro
      const { error } = await supabase
        .from('lead_distribution_members')
        .update({ weight: input.weight })
        .eq('id', input.id);
      if (error) throw error;

      // 2. Reseta contadores da config (todos os membros) — evita overcorrection
      //    do stride scheduler ao mudar peso. Sem isso, vendedores que estavam
      //    "atrás" da cota velha começam pegando tudo até equilibrar.
      const { error: resetErr } = await supabase.rpc('reset_distribution_counters', {
        p_config_id: input.config_id,
      });
      if (resetErr) throw resetErr;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['distribution-members', vars.config_id] });
    },
  });
};

export const useReorderMembers = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { config_id: string; members: { id: string; position: number }[] }) => {
      // Update positions in parallel
      const updates = input.members.map((m) =>
        supabase
          .from('lead_distribution_members')
          .update({ position: m.position })
          .eq('id', m.id)
      );
      await Promise.all(updates);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['distribution-members', vars.config_id] });
    },
  });
};

// =====================================================
// LOG / HISTORY
// =====================================================

export const useDistributionLog = (configId: string | undefined, limit = 50) => {
  return useQuery({
    queryKey: ['distribution-log', configId, limit],
    queryFn: async () => {
      if (!configId) return [];

      const { data, error } = await supabase
        .from('lead_distribution_log')
        .select('*, lead:leads(id, name, phone), team_member:team_members(id, name)')
        .eq('config_id', configId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as DistributionLog[];
    },
    enabled: !!configId,
  });
};

// =====================================================
// RECEIVE LEAD LOGS (audit trail)
// =====================================================

export interface ReceiveLeadLog {
  id: string;
  created_at: string;
  api_key: string | null;
  config_id: string | null;
  origin: string | null;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  lead_source: string | null;
  status: string;
  lead_id: string | null;
  deal_id: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  dedup_match: string | null;
  existing_lead_id: string | null;
  error_message: string | null;
  error_details: Record<string, unknown> | null;
  processing_ms: number | null;
}

export const useReceiveLeadLogs = (limit = 100) => {
  return useQuery({
    queryKey: ['receive-lead-logs', limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('receive_lead_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as ReceiveLeadLog[];
    },
  });
};

// =====================================================
// DISTRIBUTION STATS
// =====================================================

export interface DistributionStats {
  team_member_id: string;
  name: string;
  total: number;
  today: number;
  week: number;
  reconversions: number;
}

export const useDistributionStats = (configId: string | undefined) => {
  return useQuery({
    queryKey: ['distribution-stats', configId],
    queryFn: async () => {
      if (!configId) return { stats: [], nextMember: null as string | null };

      // Get stats per member
      const { data: logs, error } = await supabase
        .from('lead_distribution_log')
        .select('team_member_id, method_used, created_at')
        .eq('config_id', configId);

      if (error) throw error;

      const now = new Date();
      // Today in BRT
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const memberMap = new Map<string, { total: number; today: number; week: number; reconversions: number }>();
      for (const log of logs || []) {
        const existing = memberMap.get(log.team_member_id) || { total: 0, today: 0, week: 0, reconversions: 0 };
        existing.total++;
        const logDate = new Date(log.created_at);
        const logDateStr = log.created_at.split('T')[0];
        if (logDateStr === todayStr) existing.today++;
        if (logDate >= weekAgo) existing.week++;
        if (log.method_used === 'reconversion') existing.reconversions++;
        memberMap.set(log.team_member_id, existing);
      }

      // Get member names
      const memberIds = Array.from(memberMap.keys());
      let stats: DistributionStats[] = [];
      if (memberIds.length > 0) {
        const { data: members } = await supabase
          .from('team_members')
          .select('id, name')
          .in('id', memberIds);

        stats = Array.from(memberMap.entries()).map(([id, s]) => ({
          team_member_id: id,
          name: members?.find((m) => m.id === id)?.name || '—',
          ...s,
        }));
        stats.sort((a, b) => b.total - a.total);
      }

      // Find who's next: last assigned member + wrap
      const { data: lastLog } = await supabase
        .from('lead_distribution_log')
        .select('team_member_id')
        .eq('config_id', configId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let nextMember: string | null = null;
      if (lastLog) {
        const { data: distMembers } = await supabase
          .from('lead_distribution_members')
          .select('team_member_id, position, is_active, team_member:team_members(name)')
          .eq('config_id', configId)
          .eq('is_active', true)
          .order('position', { ascending: true });

        if (distMembers && distMembers.length > 0) {
          const lastIdx = distMembers.findIndex((m) => m.team_member_id === lastLog.team_member_id);
          const nextIdx = lastIdx >= 0 ? (lastIdx + 1) % distMembers.length : 0;
          const next = distMembers[nextIdx];
          nextMember = (next.team_member as unknown as { name: string })?.name || next.team_member_id;
        }
      }

      return { stats, nextMember };
    },
    enabled: !!configId,
  });
};

