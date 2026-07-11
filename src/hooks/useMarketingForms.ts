import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import type { MarketingForm, FormField, FormStyle, FormSettings } from '@/types/marketing-form.types';

export function useMarketingForms() {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: ['marketing-forms', tenantId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('marketing_forms')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data || []) as MarketingForm[];
    },
    enabled: !!tenantId,
  });
}

export function useMarketingForm(id: string | undefined) {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: ['marketing-form', id, tenantId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('marketing_forms')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;
      return data as MarketingForm;
    },
    enabled: !!id && !!tenantId,
  });
}

export function useCreateMarketingForm() {
  const queryClient = useQueryClient();
  const { tenantId, teamMember } = useAuth();

  return useMutation({
    mutationFn: async (form: {
      name: string;
      description?: string;
      fields: FormField[];
      style: FormStyle;
      settings: FormSettings;
      redirect_url?: string;
      success_message?: string;
      distribution_config_id?: string | null;
    }) => {
      const { data, error } = await (supabase as any)
        .from('marketing_forms')
        .insert({
          ...form,
          tenant_id: tenantId,
          created_by: teamMember?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return data as MarketingForm;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing-forms'] });
    },
  });
}

export function useUpdateMarketingForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<MarketingForm> & { id: string }) => {
      const { data, error } = await (supabase as any)
        .from('marketing_forms')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      return data as MarketingForm;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['marketing-forms'] });
      queryClient.invalidateQueries({ queryKey: ['marketing-form', data.id] });
    },
  });
}

export function useDeleteMarketingForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any)
        .from('marketing_forms')
        .delete()
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing-forms'] });
    },
  });
}

export function useToggleMarketingForm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await (supabase as any)
        .from('marketing_forms')
        .update({ is_active, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing-forms'] });
    },
  });
}

// Fetch leads submitted through a specific form
export function useFormLeads(formId: string | null) {
  const { tenantId } = useAuth();

  return useQuery({
    queryKey: ['form-leads', formId, tenantId],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('receive_lead_logs')
        .select('id, lead_name, lead_email, lead_phone, status, created_at, raw_payload')
        .filter('raw_payload', 'cs', JSON.stringify({ form_id: formId }))
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      return data || [];
    },
    enabled: !!formId && !!tenantId,
  });
}

// Public: fetch form without auth (for embed page)
export async function fetchPublicForm(id: string): Promise<MarketingForm | null> {
  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/marketing_forms?id=eq.${id}&is_active=eq.true&select=*`,
    {
      headers: {
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xa21tc3JtYXVxZWJsbG1paWtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzkyMjI2NDAsImV4cCI6MjA1NDc5ODY0MH0.RFgMVMnSMiMSGCpGDe53xbGCbKPdBPuahJM5bRnVm-U',
        'Content-Type': 'application/json',
      },
    }
  );
  const data = await resp.json();
  return data?.[0] || null;
}
