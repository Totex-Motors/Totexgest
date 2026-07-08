import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect, useState } from 'react';
import type {
  EmailTemplate,
  EmailCampaign,
  EmailCampaignLead,
  EmailCampaignStatus,
  EmailCampaignLeadStatus,
  EmailAudienceFilters,
  EmailMetrics,
  EmailUnsubscribe,
  BrevoSettings,
} from '@/types/email.types';

// ────────────────────────────────────────────
// BREVO/EMAIL SENDER SETTINGS (legado: hook chamado Brevo mas usa Resend)
// ────────────────────────────────────────────

export const useBrevoSettings = () => {
  // MULTI-TENANT: lê tenant_id
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['brevo-settings', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('integration_settings' as any)
        .select('*')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .eq('provider', 'brevo')
        .maybeSingle();
      if (error) throw error;
      return data?.settings as BrevoSettings | null;
    },
  });
};

export const useSaveBrevoSettings = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  // MULTI-TENANT
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (settings: BrevoSettings) => {
      const { data: existing } = await supabase
        .from('integration_settings' as any)
        .select('id')
        // MULTI-TENANT: filtro por tenant (busca a config DO tenant atual)
        .eq('tenant_id', tenantId)
        .eq('provider', 'brevo')
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from('integration_settings' as any)
          .update({ settings, is_active: true, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          // MULTI-TENANT: filtro defensivo
          .eq('tenant_id', tenantId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('integration_settings' as any)
          .insert({
            // MULTI-TENANT: insert com tenant_id
            tenant_id: tenantId,
            provider: 'brevo',
            settings,
            is_active: true,
          });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['brevo-settings', tenantId] });
    },
  });
};

// ────────────────────────────────────────────
// EMAIL TEMPLATES
// ────────────────────────────────────────────

export const useEmailTemplates = () => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-templates', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_templates' as any)
        .select('*')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .eq('is_active', true)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data || []) as EmailTemplate[];
    },
  });
};

export const useEmailTemplate = (id: string | undefined) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-template', tenantId, id],
    enabled: !!id && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_templates' as any)
        .select('*')
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .single();
      if (error) throw error;
      return data as EmailTemplate;
    },
  });
};

export const useCreateEmailTemplate = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  // MULTI-TENANT
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (template: Partial<EmailTemplate>) => {
      const { data, error } = await supabase
        .from('email_templates' as any)
        .insert({
          ...template,
          // MULTI-TENANT: tenant_id obrigatório
          tenant_id: tenantId,
          created_by: teamMember?.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as EmailTemplate;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-templates', tenantId] });
    },
  });
};

export const useUpdateEmailTemplate = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<EmailTemplate> & { id: string }) => {
      const { data, error } = await supabase
        .from('email_templates' as any)
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailTemplate;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-templates', tenantId] });
      // Invalidar TAMBÉM a query individual — sem isso, ao reabrir o template,
      // useEmailTemplate serve do cache antigo (staleTime 2min) e usuário vê dados desatualizados.
      queryClient.invalidateQueries({ queryKey: ['email-template', tenantId, data.id] });
      queryClient.setQueryData(['email-template', tenantId, data.id], data);
    },
  });
};

export const useDeleteEmailTemplate = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('email_templates' as any)
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId);
      if (error) throw error;
      return id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['email-templates', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-template', tenantId, id] });
    },
  });
};

// ────────────────────────────────────────────
// EMAIL CAMPAIGNS
// ────────────────────────────────────────────

export const useEmailCampaigns = (statusFilter?: EmailCampaignStatus, sourceType: 'campaign' | 'automation' | 'all' = 'campaign') => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-campaigns', tenantId, statusFilter, sourceType],
    enabled: !!tenantId,
    queryFn: async () => {
      let query = supabase
        .from('email_campaigns' as any)
        .select('*')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (statusFilter) query = query.eq('status', statusFilter);
      if (sourceType !== 'all') query = query.eq('source_type', sourceType);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as EmailCampaign[];
    },
  });
};

export const useEmailCampaign = (id: string | undefined) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-campaign', tenantId, id],
    enabled: !!id && !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .select('*, template:email_templates(id, name, subject)')
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    refetchInterval: (query) => {
      const campaign = query.state.data as EmailCampaign | undefined;
      if (campaign?.status === 'sending') return 5000;
      return false;
    },
  });
};

export const useCreateEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  // MULTI-TENANT
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (campaign: Partial<EmailCampaign>) => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .insert({
          ...campaign,
          // MULTI-TENANT: tenant_id obrigatório
          tenant_id: tenantId,
          created_by: teamMember?.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
    },
  });
};

export const useUpdateEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<EmailCampaign> & { id: string }) => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

export const useSendEmailCampaignTest = () => {
  return useMutation({
    mutationFn: async ({
      campaignId,
      testEmail,
      html,
    }: {
      campaignId: string;
      testEmail: string;
      html: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('send-email-campaign', {
        body: { campaign_id: campaignId, test_email: testEmail, html },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
  });
};

export const useStartEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (campaignId: string) => {
      // 1. Populate leads
      const { data: rawCount, error: popError } = await supabase
        .rpc('populate_email_campaign_leads', { p_campaign_id: campaignId });
      if (popError) throw popError;
      let count = rawCount;

      // 1b. Remove excluded leads
      const { data: camp } = await supabase
        .from('email_campaigns' as any)
        .select('audience_filters, html_content')
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .single();
      const excludeIds = (camp?.audience_filters as EmailAudienceFilters)?.exclude_lead_ids;
      if (excludeIds?.length) {
        await supabase
          .from('email_campaign_leads' as any)
          .delete()
          .eq('campaign_id', campaignId)
          .in('lead_id', excludeIds);
        count = (count || 0) - excludeIds.length;
        if (count < 0) count = 0;
      }

      // 2. Update status to sending
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({
          status: 'sending',
          started_at: new Date().toISOString(),
          total_leads: count,
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;

      // 3. Dispara edge function que envia de fato (Resend)
      const { error: invokeErr } = await supabase.functions.invoke('send-email-campaign', {
        body: { campaign_id: campaignId, html: camp?.html_content || undefined },
      });
      if (invokeErr) throw invokeErr;

      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

export const useScheduleEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ campaignId, scheduledAt }: { campaignId: string; scheduledAt: string }) => {
      const { error: popError } = await supabase
        .rpc('populate_email_campaign_leads', { p_campaign_id: campaignId });
      if (popError) throw popError;

      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({
          status: 'scheduled',
          scheduled_at: scheduledAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

export const usePauseEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ campaignId, reason }: { campaignId: string; reason?: string }) => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({
          status: 'paused',
          paused_at: new Date().toISOString(),
          pause_reason: reason || 'Pausada manualmente',
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

export const useResumeEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (campaignId: string) => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({
          status: 'sending',
          paused_at: null,
          pause_reason: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

export const useCancelEmailCampaign = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (campaignId: string) => {
      await supabase
        .from('email_campaign_leads' as any)
        .update({ status: 'skipped', updated_at: new Date().toISOString() })
        .eq('campaign_id', campaignId)
        .eq('status', 'pending');

      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .update({
          status: 'cancelled',
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .select()
        .single();
      if (error) throw error;
      return data as EmailCampaign;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['email-campaigns', tenantId] });
      queryClient.invalidateQueries({ queryKey: ['email-campaign', tenantId, data.id] });
    },
  });
};

// ────────────────────────────────────────────
// EMAIL CAMPAIGN LEADS
// ────────────────────────────────────────────

export const useEmailCampaignLeads = (
  campaignId: string | undefined,
  statusFilter?: EmailCampaignLeadStatus,
  page = 0,
  pageSize = 50,
  campaignStatus?: string,
) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-campaign-leads', tenantId, campaignId, statusFilter, page],
    enabled: !!campaignId && !!tenantId,
    queryFn: async () => {
      let query = supabase
        .from('email_campaign_leads' as any)
        .select('*, lead:leads(id, name, phone, email, city_name, state, sales_rep_id)', { count: 'exact' })
        .eq('campaign_id', campaignId)
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (statusFilter) {
        query = query.eq('status', statusFilter);
      }
      const { data, error, count } = await query;
      if (error) throw error;
      return { leads: (data || []) as EmailCampaignLead[], total: count || 0 };
    },
    refetchInterval: campaignStatus === 'sending' ? 5000 : false,
  });
};

// ────────────────────────────────────────────
// AUDIENCE
// ────────────────────────────────────────────

export const useEmailAudienceCount = (filters: EmailAudienceFilters) => {
  // MULTI-TENANT: tenant_id no queryKey
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  const [debouncedFilters, setDebouncedFilters] = useState(filters);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilters(filters), 500);
    return () => clearTimeout(timer);
  }, [JSON.stringify(filters)]);

  return useQuery({
    queryKey: ['email-audience-count', tenantId, debouncedFilters],
    enabled: !!tenantId,
    queryFn: async () => {
      // Modo "lista importada": count direto do array (não bate no banco)
      const uploaded = debouncedFilters.uploaded_emails;
      if (uploaded && uploaded.length > 0) return uploaded.length;

      const { data, error } = await supabase
        .rpc('get_email_audience_count', { p_filters: debouncedFilters });
      if (error) throw error;
      return (data as number) || 0;
    },
  });
};

// ────────────────────────────────────────────
// EMAIL METRICS (global)
// ────────────────────────────────────────────

export const useEmailMetrics = () => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-metrics', tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('email_campaigns' as any)
        .select('status, total_leads, sent_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId);
      if (error) throw error;

      const campaigns = data || [];
      const metrics: EmailMetrics = {
        total_campaigns: campaigns.length,
        active_campaigns: campaigns.filter((c: any) => c.status === 'sending').length,
        total_sent: campaigns.reduce((sum: number, c: any) => sum + (c.sent_count || 0), 0),
        total_delivered: campaigns.reduce((sum: number, c: any) => sum + (c.delivered_count || 0), 0),
        total_opened: campaigns.reduce((sum: number, c: any) => sum + (c.opened_count || 0), 0),
        total_clicked: campaigns.reduce((sum: number, c: any) => sum + (c.clicked_count || 0), 0),
        total_bounced: campaigns.reduce((sum: number, c: any) => sum + (c.bounced_count || 0), 0),
        total_unsubscribed: campaigns.reduce((sum: number, c: any) => sum + (c.unsubscribed_count || 0), 0),
        avg_open_rate: 0,
        avg_click_rate: 0,
      };

      if (metrics.total_delivered > 0) {
        metrics.avg_open_rate = Math.round((metrics.total_opened / metrics.total_delivered) * 100);
        metrics.avg_click_rate = Math.round((metrics.total_clicked / metrics.total_delivered) * 100);
      }

      return metrics;
    },
  });
};


// ────────────────────────────────────────────
// UNSUBSCRIBES
// ────────────────────────────────────────────

export const useEmailUnsubscribes = (page = 0, pageSize = 50) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-unsubscribes', tenantId, page],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data, error, count } = await supabase
        .from('email_unsubscribes' as any)
        .select('*', { count: 'exact' })
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .order('unsubscribed_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      return { unsubscribes: (data || []) as EmailUnsubscribe[], total: count || 0 };
    },
  });
};

export const useManualUnsubscribe = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ email, reason }: { email: string; reason?: string }) => {
      const { error } = await supabase
        .from('email_unsubscribes' as any)
        .insert({
          // MULTI-TENANT: tenant_id obrigatório
          tenant_id: tenantId,
          email,
          reason,
          source: 'manual',
        });
      if (error && !error.message.includes('duplicate')) throw error;

      // Update lead
      await supabase
        .from('leads' as any)
        .update({ email_opted_out: true, updated_at: new Date().toISOString() })
        // MULTI-TENANT: filtro defensivo (não opt-out de lead com mesmo email em outro tenant)
        .eq('tenant_id', tenantId)
        .eq('email', email);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['email-unsubscribes', tenantId] });
    },
  });
};

// ────────────────────────────────────────────
// SEND TEST EMAIL
// ────────────────────────────────────────────

export const useSendTestEmail = () => {
  return useMutation({
    mutationFn: async ({ to, subject, html_content }: { to: string; subject: string; html_content: string }) => {
      const { data, error } = await supabase.functions.invoke('send-email-campaign', {
        body: {
          test_email: to,
          subject,
          html: html_content,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
  });
};

// ────────────────────────────────────────────
// DASHBOARD: KPIs + LOG DE ENVIOS + GRÁFICO
// ────────────────────────────────────────────

export type EmailKpiPeriod = '24h' | '7d' | '30d' | 'all';

function periodToISO(period: EmailKpiPeriod): string | null {
  if (period === 'all') return null;
  const d = new Date();
  if (period === '24h') d.setHours(d.getHours() - 24);
  else if (period === '7d') d.setDate(d.getDate() - 7);
  else if (period === '30d') d.setDate(d.getDate() - 30);
  return d.toISOString();
}

export interface EmailSendLogRow {
  id: string;
  campaign_id: string;
  lead_id: string | null;
  email: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  bounce_reason: string | null;
  open_count: number | null;
  click_count: number | null;
  clicked_url: string | null;
  html: string | null;
  error_message: string | null;
  campaign?: {
    id: string;
    name: string;
    subject: string;
    source_type: string;
    automation_id: string | null;
    from_name: string | null;
    from_email: string | null;
  } | null;
  lead?: {
    id: string;
    name: string;
    email: string | null;
  } | null;
}

export interface EmailSendsFilters {
  source?: 'campaign' | 'automation' | 'all';
  status?: string;
  campaign_id?: string;
  automation_id?: string;
  search?: string;
  period?: EmailKpiPeriod;
  page?: number;
  pageSize?: number;
}

export const useEmailSendsLog = (filters: EmailSendsFilters = {}) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  const {
    source = 'all', status, campaign_id, automation_id, search,
    period = '30d', page = 0, pageSize = 25,
  } = filters;
  return useQuery({
    queryKey: ['email-sends-log', tenantId, source, status, campaign_id, automation_id, search, period, page, pageSize],
    enabled: !!tenantId,
    queryFn: async () => {
      let q = supabase
        .from('email_sends' as any)
        .select(
          '*, campaign:email_campaigns(id, name, subject, source_type, automation_id, from_name, from_email), lead:leads(id, name, email)',
          { count: 'exact' },
        )
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId);
      const sinceIso = periodToISO(period);
      if (sinceIso) q = q.gte('sent_at', sinceIso);
      if (status) q = q.eq('status', status);
      if (campaign_id) q = q.eq('campaign_id', campaign_id);
      if (search) q = q.ilike('email', `%${search}%`);
      const { data, count, error } = await q
        .order('sent_at', { ascending: false, nullsFirst: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      let rows = (data || []) as any[];
      if (source !== 'all') rows = rows.filter((r) => r.campaign?.source_type === source);
      if (automation_id) rows = rows.filter((r) => r.campaign?.automation_id === automation_id);
      return { rows: rows as EmailSendLogRow[], total: count || 0 };
    },
  });
};

export const useEmailKpis = (period: EmailKpiPeriod = '30d') => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-kpis', tenantId, period],
    enabled: !!tenantId,
    queryFn: async () => {
      const sinceIso = periodToISO(period);
      let q = supabase
        .from('email_sends' as any)
        .select('status, opened_at, clicked_at, bounced_at, delivered_at')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId);
      if (sinceIso) q = q.gte('sent_at', sinceIso);
      const { data, error } = await q.limit(50000);
      if (error) throw error;
      const rows = (data || []) as any[];
      const sent = rows.length;
      const delivered = rows.filter((r) => !!r.delivered_at).length;
      const opened = rows.filter((r) => !!r.opened_at).length;
      const clicked = rows.filter((r) => !!r.clicked_at).length;
      const bounced = rows.filter((r) => !!r.bounced_at).length;
      const failed = rows.filter((r) => r.status === 'failed').length;
      return {
        sent, delivered, opened, clicked, bounced, failed,
        open_rate: delivered > 0 ? Math.round((opened / delivered) * 100) : 0,
        click_rate: delivered > 0 ? Math.round((clicked / delivered) * 100) : 0,
        bounce_rate: sent > 0 ? Math.round((bounced / sent) * 100) : 0,
      };
    },
  });
};

export const useEmailSendsTimeseries = (days: number = 30) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['email-sends-timeseries', tenantId, days],
    enabled: !!tenantId,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - days);
      const { data, error } = await supabase
        .from('email_sends' as any)
        .select('sent_at, opened_at, clicked_at')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .gte('sent_at', since.toISOString())
        .limit(50000);
      if (error) throw error;
      const buckets = new Map<string, { date: string; sent: number; opened: number; clicked: number }>();
      for (let i = 0; i < days; i++) {
        const d = new Date(since);
        d.setDate(since.getDate() + i + 1);
        const key = d.toISOString().slice(0, 10);
        buckets.set(key, { date: key, sent: 0, opened: 0, clicked: 0 });
      }
      for (const r of (data || []) as any[]) {
        if (!r.sent_at) continue;
        const key = String(r.sent_at).slice(0, 10);
        const b = buckets.get(key);
        if (!b) continue;
        b.sent++;
        if (r.opened_at) b.opened++;
        if (r.clicked_at) b.clicked++;
      }
      return Array.from(buckets.values());
    },
  });
};

export const useAutomationSends = (automationId: string | undefined, page = 0, pageSize = 25) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['automation-sends', tenantId, automationId, page, pageSize],
    enabled: !!automationId && !!tenantId,
    queryFn: async () => {
      if (!automationId) return { rows: [] as EmailSendLogRow[], total: 0 };
      const { data: shells } = await supabase
        .from('email_campaigns' as any)
        .select('id')
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .eq('automation_id', automationId)
        .limit(5000);
      const ids = (shells || []).map((c: any) => c.id);
      if (ids.length === 0) return { rows: [], total: 0 };
      const { data, count, error } = await supabase
        .from('email_sends' as any)
        .select(
          '*, campaign:email_campaigns(id, name, subject, source_type, automation_id), lead:leads(id, name, email)',
          { count: 'exact' },
        )
        // MULTI-TENANT: filtro defensivo
        .eq('tenant_id', tenantId)
        .in('campaign_id', ids)
        .order('sent_at', { ascending: false, nullsFirst: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      return { rows: (data || []) as EmailSendLogRow[], total: count || 0 };
    },
  });
};

export const useAutomationRuns = (automationId: string | undefined, page = 0, pageSize = 25) => {
  // MULTI-TENANT
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ['automation-runs', tenantId, automationId, page, pageSize],
    enabled: !!automationId && !!tenantId,
    queryFn: async () => {
      if (!automationId) return { rows: [] as any[], total: 0 };
      const { data, count, error } = await supabase
        .from('email_flow_runs' as any)
        .select('*, lead:leads(id, name, email)', { count: 'exact' })
        // MULTI-TENANT: filtro por tenant
        .eq('tenant_id', tenantId)
        .eq('automation_id', automationId)
        .order('started_at', { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);
      if (error) throw error;
      return { rows: (data || []), total: count || 0 };
    },
  });
};
