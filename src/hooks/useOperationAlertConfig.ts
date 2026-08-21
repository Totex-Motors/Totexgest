import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

export interface OperationAlertConfig {
  tenant_id: string;
  enabled: boolean;
  realtime_enabled: boolean;
  summary_enabled: boolean;
  include_ai_plan: boolean;
  sla_alert_minutes: number;
  summary_hours: number[];
  telegram_enabled: boolean;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  whatsapp_enabled: boolean;
  whatsapp_instance_id: string | null;
  whatsapp_group_jid: string | null;
}

export const DEFAULT_ALERT_CONFIG: Omit<OperationAlertConfig, 'tenant_id'> = {
  enabled: false,
  realtime_enabled: true,
  summary_enabled: true,
  include_ai_plan: true,
  sla_alert_minutes: 60,
  summary_hours: [9, 14],
  telegram_enabled: false,
  telegram_bot_token: null,
  telegram_chat_id: null,
  whatsapp_enabled: false,
  whatsapp_instance_id: null,
  whatsapp_group_jid: null,
};

export function useOperationAlertConfig() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['operation-alert-config', tenantId],
    queryFn: async (): Promise<OperationAlertConfig | null> => {
      const { data, error } = await supabase
        .from('operation_alert_config')
        .select('*')
        .maybeSingle();
      if (error) throw error;
      return data as OperationAlertConfig | null;
    },
    enabled: !!tenantId,
  });
}

export function useUpsertOperationAlertConfig() {
  const qc = useQueryClient();
  const { tenantId } = useAuth();
  return useMutation({
    mutationFn: async (patch: Partial<OperationAlertConfig>) => {
      if (!tenantId) throw new Error('sem tenant');
      const { data, error } = await supabase
        .from('operation_alert_config')
        .upsert(
          { tenant_id: tenantId, ...patch, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id' }
        )
        .select()
        .single();
      if (error) throw error;
      return data as OperationAlertConfig;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['operation-alert-config'] }),
  });
}

// Instâncias UAZAPI conectadas (pra escolher qual manda no grupo)
export function useUazapiInstances() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['uazapi-instances', tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('whatsapp_instances')
        .select('id, name, phone_number, status, provider')
        .order('name');
      if (error) throw error;
      // UAZAPI = provider uazapi ou nulo (padrão histórico); Cloud API não serve pra grupo
      return (data || []).filter((i: any) => i.provider !== 'cloud');
    },
    enabled: !!tenantId,
  });
}

// Grupos sincronizados de uma instância (pra escolher o grupo destino)
export function useWhatsAppGroups(instanceId: string | null | undefined) {
  return useQuery({
    queryKey: ['whatsapp-groups', instanceId],
    queryFn: async () => {
      if (!instanceId) return [];
      const { data, error } = await supabase
        .from('whatsapp_groups')
        .select('id, group_jid, name')
        .eq('instance_id', instanceId)
        .order('name');
      if (error) throw error;
      return data || [];
    },
    enabled: !!instanceId,
  });
}

// Dispara um teste (resumo imediato) escopado ao tenant do usuário logado
export function useTestOperationAlert() {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('operation-alerts', {
        body: { mode: 'summary' },
      });
      if (error) throw error;
      return data;
    },
  });
}
