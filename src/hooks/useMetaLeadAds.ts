import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

export interface MetaPage {
  id: string;
  tenant_id: string;
  page_id: string;
  page_name: string;
  page_access_token: string;
  is_active: boolean;
  total_leads_synced: number;
  last_lead_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaForm {
  id: string;
  tenant_id: string;
  page_id: string;
  form_id: string;
  form_name: string;
  is_enabled: boolean;
  leads_count: number;
  last_lead_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaLeadLog {
  id: string;
  page_id: string | null;
  form_id: string | null;
  form_name: string | null;
  leadgen_id: string | null;
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  status: string;
  error_message: string | null;
  lead_id: string | null;
  deal_id: string | null;
  assigned_to_name: string | null;
  created_at: string;
}

// ── PAGES ──

export const useMetaPages = () => {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['meta-lead-ads-pages', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('meta_lead_ads_pages' as any)
        .select('*')
        .order('page_name');
      if (error) throw error;
      return (data || []) as MetaPage[];
    },
  });
};

export const useAddMetaPage = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  return useMutation({
    mutationFn: async ({ pageId, pageName, pageAccessToken }: { pageId: string; pageName: string; pageAccessToken: string }) => {
      const { data, error } = await supabase
        .from('meta_lead_ads_pages' as any)
        .upsert({
          tenant_id: teamMember?.tenant_id,
          page_id: pageId,
          page_name: pageName,
          page_access_token: pageAccessToken,
          is_active: true,
        }, { onConflict: 'tenant_id,page_id' })
        .select()
        .single();
      if (error) throw error;
      return data as MetaPage;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meta-lead-ads-pages'] });
    },
  });
};

export const useToggleMetaPage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from('meta_lead_ads_pages' as any)
        .update({ is_active: isActive, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meta-lead-ads-pages'] });
    },
  });
};

export const useDeleteMetaPage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('meta_lead_ads_pages' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meta-lead-ads-pages'] });
    },
  });
};

// ── FORMS ──

export const useMetaForms = (pageId?: string) => {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['meta-lead-ads-forms', tenantId, pageId],
    enabled: !!tenantId,
    queryFn: async () => {
      let query = supabase
        .from('meta_lead_ads_forms' as any)
        .select('*')
        .order('form_name');
      if (pageId) query = query.eq('page_id', pageId);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as MetaForm[];
    },
  });
};

export const useSyncMetaForms = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  return useMutation({
    mutationFn: async ({ pageId, pageAccessToken }: { pageId: string; pageAccessToken: string }) => {
      // Fetch forms from Meta Graph API
      const resp = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}/leadgen_forms?access_token=${pageAccessToken}&limit=100`
      );
      const data = await resp.json();
      if (data.error) throw new Error(data.error.message);

      const forms = data.data || [];
      let synced = 0;

      for (const form of forms) {
        const { error } = await supabase
          .from('meta_lead_ads_forms' as any)
          .upsert({
            tenant_id: teamMember?.tenant_id,
            page_id: pageId,
            form_id: form.id,
            form_name: form.name || `Form ${form.id}`,
            is_enabled: true,
          }, { onConflict: 'tenant_id,form_id' });
        if (!error) synced++;
      }

      return { synced, total: forms.length };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meta-lead-ads-forms'] });
    },
  });
};

export const useToggleMetaForm = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, isEnabled }: { id: string; isEnabled: boolean }) => {
      const { error } = await supabase
        .from('meta_lead_ads_forms' as any)
        .update({ is_enabled: isEnabled, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['meta-lead-ads-forms'] });
    },
  });
};

// ── LOGS ──

export const useMetaLeadLogs = (limit = 50) => {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['meta-lead-ads-logs', tenantId, limit],
    enabled: !!tenantId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('meta_lead_ads_logs' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data || []) as MetaLeadLog[];
    },
  });
};
