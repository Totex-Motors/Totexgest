import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

export interface WhatsAppTemplate {
  id: string;
  meta_template_id: string | null;
  meta_waba_id: string | null;
  name: string;
  category: string;
  language: string;
  status: string;
  rejection_reason: string | null;
  components: any[];
  example_values: Record<string, any>;
  variables_count: number;
  internal_tags: string[];
  total_sent: number;
  total_delivered: number;
  total_read: number;
  total_failed: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppTemplateTag {
  id: string;
  slug: string;
  label: string;
  color: string;
  icon: string | null;
  position: number;
}

// ===================== TEMPLATES =====================

export const useWhatsAppTemplates = () => {
  // MULTI-TENANT: lê tenant do AuthContext
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ["whatsapp-templates", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<WhatsAppTemplate[]> => {
      const { data, error } = await supabase
        .from("whatsapp_cloud_templates")
        .select("*")
        // MULTI-TENANT: filtro por tenant
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as WhatsAppTemplate[];
    },
  });
};

export const useSyncWhatsAppTemplates = () => {
  const queryClient = useQueryClient();
  // MULTI-TENANT: pra invalidate scoped
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("sync-whatsapp-templates", {
        body: {},
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { success: boolean; total: number; upserted: number };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-templates", tenantId] });
    },
  });
};

export const useUpdateTemplateTags = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async ({ id, internal_tags }: { id: string; internal_tags: string[] }) => {
      const { error } = await supabase
        .from("whatsapp_cloud_templates")
        .update({ internal_tags })
        .eq("id", id)
        // MULTI-TENANT: filtro defensivo no update
        .eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-templates", tenantId] });
    },
  });
};

export const useDeleteTemplate = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("whatsapp_cloud_templates")
        .delete()
        .eq("id", id)
        // MULTI-TENANT: filtro defensivo no delete
        .eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-templates", tenantId] });
    },
  });
};

// ===================== TAGS =====================

export const useWhatsAppTemplateTags = () => {
  // MULTI-TENANT: tags também são por tenant
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useQuery({
    queryKey: ["whatsapp-template-tags", tenantId],
    enabled: !!tenantId,
    queryFn: async (): Promise<WhatsAppTemplateTag[]> => {
      const { data, error } = await supabase
        .from("whatsapp_template_tags")
        .select("*")
        // MULTI-TENANT: filtro por tenant
        .eq("tenant_id", tenantId)
        .order("position", { ascending: true });
      if (error) throw error;
      return (data || []) as WhatsAppTemplateTag[];
    },
  });
};

export const useUpsertTemplateTag = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (tag: Partial<WhatsAppTemplateTag> & { slug: string; label: string }) => {
      if (tag.id) {
        const { error } = await supabase
          .from("whatsapp_template_tags")
          .update(tag)
          .eq("id", tag.id)
          // MULTI-TENANT: filtro defensivo no update
          .eq("tenant_id", tenantId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("whatsapp_template_tags")
          // MULTI-TENANT: insert com tenant_id obrigatório
          .insert({ ...tag, tenant_id: tenantId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-template-tags", tenantId] });
    },
  });
};

export const useDeleteTemplateTag = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("whatsapp_template_tags")
        .delete()
        .eq("id", id)
        // MULTI-TENANT: filtro defensivo no delete
        .eq("tenant_id", tenantId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-template-tags", tenantId] });
    },
  });
};

// ────────────────────────────────────────────
// CRIAR TEMPLATE META (envia pra aprovação)
// ────────────────────────────────────────────

export type CloudTemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

export interface CloudTemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  url?: string;
  phone_number?: string;
}

export interface CloudTemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION';
  text?: string;
  example?: {
    header_text?: string[];
    body_text?: string[][];
    header_handle?: string[];
  };
  buttons?: CloudTemplateButton[];
}

export interface CreateCloudTemplateInput {
  name: string;
  category: CloudTemplateCategory;
  language: string;
  components: CloudTemplateComponent[];
}

export const useCreateCloudTemplate = () => {
  const queryClient = useQueryClient();
  const { teamMember } = useAuth();
  const tenantId = teamMember?.tenant_id;
  return useMutation({
    mutationFn: async (input: CreateCloudTemplateInput) => {
      const { data, error } = await supabase.functions.invoke('create-whatsapp-template', {
        body: input,
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { success: boolean; template?: any; status?: string; message?: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenantId] });
    },
  });
};
