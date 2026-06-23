import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';

export type TriggerEvent = 'lead_created' | 'deal_won' | 'organization_created' | 'custom';

export interface EmailAutomation {
  id: string;
  name: string;
  description: string | null;
  trigger_event: TriggerEvent;
  trigger_filter: any;
  flow_json: any;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const useEmailAutomations = () => {
  // MULTI-TENANT: lê tenant_id do AuthContext
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-automations', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_automations')
        .select('*')
        // MULTI-TENANT: filtro explícito por tenant_id
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data || []) as EmailAutomation[];
    },
  });
};

export const useEmailAutomation = (id: string | undefined) => {
  // MULTI-TENANT: tenant no queryKey pra cache não vazar entre tenants
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-automation', tenantId, id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_automations')
        .select('*')
        .eq('id', id!)
        // MULTI-TENANT: filtro defensivo (RLS já garante, mas reforça)
        .eq('tenant_id', tenantId)
        .single();
      if (error) throw error;
      return data as EmailAutomation;
    },
    enabled: !!id && !!tenantId,
  });
};

export const useSaveEmailAutomation = () => {
  const qc = useQueryClient();
  // MULTI-TENANT: precisa do tenant_id pra inserir
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (input: Partial<EmailAutomation> & { id?: string }) => {
      const { id, ...payload } = input;
      if (id) {
        const { data, error } = await supabase
          .from('email_automations')
          .update(payload)
          .eq('id', id)
          // MULTI-TENANT: filtro defensivo no update
          .eq('tenant_id', tenantId)
          .select()
          .single();
        if (error) throw error;
        return data as EmailAutomation;
      }
      const { data, error } = await supabase
        .from('email_automations')
        // MULTI-TENANT: insert obrigatoriamente com tenant_id
        .insert({ ...payload, tenant_id: tenantId })
        .select()
        .single();
      if (error) throw error;
      return data as EmailAutomation;
    },
    onSuccess: () => {
      // MULTI-TENANT: invalidate inclui tenantId
      qc.invalidateQueries({ queryKey: ['email-automations', tenantId] });
      toast.success('Automação salva');
    },
  });
};

export const useDeleteEmailAutomation = () => {
  const qc = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('email_automations')
        .delete()
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-automations', tenantId] });
      toast.success('Automação removida');
    },
  });
};

export const useToggleEmailAutomation = () => {
  const qc = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { data, error } = await supabase
        .from('email_automations')
        .update({ is_active: isActive })
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['email-automations', tenantId] });
    },
  });
};
