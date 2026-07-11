import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callUazapi } from "@/lib/uazapiProxy";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Envio unificado WhatsApp: roteia automaticamente UAZAPI vs Cloud (Meta)
 * com base no provider da instância. Multi-tenant.
 */

export interface WhatsAppInstanceLite {
  id: string;
  name: string;
  provider: "uazapi" | "meta_cloud";
  phone_number_id?: string | null;
  status?: string | null;
  pipeline_ids?: string[] | null;
}

interface SendTextInput {
  instanceId: string;
  phone: string;          // só dígitos, com DDI 55
  text: string;
  leadId?: string | null;
}

interface SendTemplateInput {
  instanceId: string;     // precisa ser meta_cloud
  phone: string;
  templateName: string;
  templateLanguage?: string;
  templateParams?: string[];
  leadId?: string | null;
  /** URL pública da mídia pra header IMAGE/VIDEO/DOCUMENT (template com header de mídia) */
  headerMediaUrl?: string | null;
  headerMediaType?: 'image' | 'video' | 'document';
}

// ============== INSTANCIAS DISPONÍVEIS PRO USUÁRIO ==============

/**
 * Retorna instâncias que o vendedor logado pode usar:
 *  - Sua UAZAPI pessoal (whatsapp_instance_id em team_members)
 *  - Instâncias Cloud do tenant que ele tem acesso (team_member_whatsapp_cloud_access)
 *  - Admins veem TODAS as Cloud do tenant por padrão
 *
 * Se `leadPipelineId` informado, filtra adicionalmente por pipeline_ids:
 *   pipeline_ids null/[] = aparece em todos os pipelines (default)
 *   pipeline_ids[] com ids = só aparece nos pipelines listados
 *
 * Coexistência: instance Cloud B2B compartilhada (pipeline_ids=[b2b]) +
 * UAZAPI pessoal (pipeline_ids=null) aparecem ambas no chat do lead B2B.
 */
export function useAvailableWhatsAppInstances(leadPipelineId?: string | null, conversationInstanceId?: string | null) {
  const { tenantId, teamMember, isAdmin } = useAuth();

  return useQuery({
    queryKey: ["available-whatsapp-instances", tenantId, teamMember?.id, isAdmin, leadPipelineId, conversationInstanceId],
    queryFn: async (): Promise<WhatsAppInstanceLite[]> => {
      if (!tenantId || !teamMember) return [];

      const all: WhatsAppInstanceLite[] = [];

      // Helper: filtro pipeline (passa se pipeline_ids null OU inclui leadPipelineId, OU lead sem pipeline)
      const matchesPipeline = (inst: any): boolean => {
        const ids = inst.pipeline_ids as string[] | null | undefined;
        if (!ids || ids.length === 0) return true; // sem restrição
        if (!leadPipelineId) return true; // lead sem pipeline (não bloqueia)
        return ids.includes(leadPipelineId);
      };

      // Pessoal (UAZAPI vinculada ao team_member)
      const personalId = (teamMember as any).whatsapp_instance_id;
      if (personalId) {
        const { data } = await supabase
          .from("whatsapp_instances")
          .select("id, name, provider, phone_number_id, status, pipeline_ids")
          .eq("tenant_id", tenantId)
          .eq("id", personalId)
          .maybeSingle();
        if (data && matchesPipeline(data)) all.push(data as WhatsAppInstanceLite);
      }

      // Admin: TODAS as instâncias conectadas do tenant (Cloud E uazapi), com filtro de funil.
      // (Antes só listava meta_cloud — a uazapi de coexistência ex. "Stephanie — Livre (QR)" não aparecia pro admin.)
      // Confia no campo `status`: a prontidão é gravada na origem (UAZAPI via QR/webhook;
      // Cloud ao salvar/testar credenciais). Nenhum caso especial por provider aqui.
      if (isAdmin) {
        const { data: tenantInstances } = await supabase
          .from("whatsapp_instances")
          .select("id, name, provider, phone_number_id, status, pipeline_ids")
          .eq("tenant_id", tenantId)
          .in("status", ["connected", "active", "open"]);
        for (const inst of (tenantInstances || [])) {
          if (matchesPipeline(inst) && !all.find(a => a.id === (inst as any).id)) {
            all.push(inst as WhatsAppInstanceLite);
          }
        }
      }

      // Vendedor: instâncias com GRANT — de QUALQUER provider
      // (Cloud compartilhada E UAZAPI secundária que ele acessa). Antes só pegava meta_cloud.
      if (!isAdmin) {
        const { data: grants } = await supabase
          .from("team_member_whatsapp_cloud_access" as any)
          .select("instance_id")
          .eq("tenant_id", tenantId)
          .eq("team_member_id", teamMember.id);
        const grantedIds = [...new Set((grants || []).map((g: any) => g.instance_id))]
          .filter((id) => !all.find(a => a.id === id));
        if (grantedIds.length > 0) {
          const { data: granted } = await supabase
            .from("whatsapp_instances")
            .select("id, name, provider, phone_number_id, status, pipeline_ids")
            .eq("tenant_id", tenantId)
            .in("id", grantedIds);
          for (const inst of (granted || [])) {
            if (matchesPipeline(inst) && !all.find(a => a.id === (inst as any).id)) {
              all.push(inst as WhatsAppInstanceLite);
            }
          }
        }
      }

      // Instância da CONVERSA (responder pelo mesmo canal): só como ÚLTIMO RECURSO.
      // Se o vendedor já tem instância acessível (pessoal/grant) ou é admin, NÃO injetamos
      // a instância da conversa só porque ela passou por lá — senão expõe instância de OUTRO
      // vendedor no seletor (caso Sara vendo "Marcos - API"/B2B sem ter acesso, 11/06).
      // Mantém o fallback anti-lista-vazia: vendedor sem NENHUMA instância ainda consegue responder.
      if (conversationInstanceId && all.length === 0) {
        const { data } = await supabase
          .from("whatsapp_instances")
          .select("id, name, provider, phone_number_id, status, pipeline_ids")
          .eq("tenant_id", tenantId)
          .eq("id", conversationInstanceId)
          .maybeSingle();
        if (data) all.push(data as WhatsAppInstanceLite);
      }

      return all;
    },
    enabled: !!tenantId && !!teamMember,
  });
}

// ============== ENVIO ==============

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("55") ? digits : `55${digits}`;
}

async function getInstance(instanceId: string, tenantId: string): Promise<WhatsAppInstanceLite> {
  const { data, error } = await supabase
    .from("whatsapp_instances")
    .select("id, name, provider, phone_number_id, status")
    .eq("tenant_id", tenantId)
    .eq("id", instanceId)
    .maybeSingle();
  if (error || !data) throw new Error("Instância não encontrada");
  return data as WhatsAppInstanceLite;
}

export function useSendWhatsAppText() {
  const { tenantId, teamMember } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ instanceId, phone, text, leadId }: SendTextInput) => {
      if (!tenantId) throw new Error("Sem tenant");
      const instance = await getInstance(instanceId, tenantId);

      if (instance.provider === "meta_cloud") {
        // A edge `send-whatsapp-cloud` grava atribuição em metadata — passamos
        // sent_by/sent_by_name (NÃO usamos coluna sent_by_team_member_id, inexistente).
        const { data, error } = await supabase.functions.invoke("send-whatsapp-cloud", {
          body: {
            instance_id: instance.id,
            tenant_id: tenantId,
            action: "send_text",
            phone: normalizePhone(phone),
            text,
            lead_id: leadId,
            sent_by: "human",
            sent_by_name: teamMember?.name,
          },
        });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        return data;
      }

      // UAZAPI (via edge uazapi-proxy — api_key nunca chega ao browser)
      const proxyRes = await callUazapi("send_text", instance.id, {
        number: normalizePhone(phone),
        text,
      });
      if (!proxyRes.ok) {
        const errBody = JSON.stringify(proxyRes.data ?? {});
        throw new Error(`UAZAPI erro: ${proxyRes.status} ${errBody}`);
      }
      const result = proxyRes.data;

      // Persiste mensagem outgoing UAZAPI (UAZAPI webhook nem sempre dispara pra msgs API).
      // ADAPTAÇÃO nosso schema: NÃO existe coluna sent_by_team_member_id — atribuição
      // vai em `sender_name` + `metadata.sent_by/sent_by_name`. Inbox lê whatsapp_messages
      // direto (sem whatsapp_conversations / upsertConversationSnapshot).
      if (leadId && teamMember?.id) {
        await supabase.from("whatsapp_messages").insert({
          tenant_id: tenantId,
          instance_id: instance.id,
          lead_id: leadId,
          message_id: (result?.id || result?.messageId || `uazapi_${Date.now()}`).toString(),
          remote_jid: `${normalizePhone(phone)}@s.whatsapp.net`,
          content: text,
          message_type: "Conversation",
          is_from_me: true,
          sent_at: new Date().toISOString(),
          sender_name: teamMember.name,
          metadata: { sent_by: "human", sent_by_name: teamMember.name, provider: "uazapi", source: "manual_send" },
        });
      }

      return result;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-messages"] });
      queryClient.invalidateQueries({ queryKey: ["message-window", tenantId, vars.leadId] });
    },
  });
}

export function useSendWhatsAppTemplate() {
  const { tenantId, teamMember } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      instanceId, phone, templateName, templateLanguage, templateParams, leadId,
      headerMediaUrl, headerMediaType,
    }: SendTemplateInput) => {
      if (!tenantId) throw new Error("Sem tenant");
      const instance = await getInstance(instanceId, tenantId);

      if (instance.provider !== "meta_cloud") {
        throw new Error("Templates só funcionam pela API Oficial (Meta Cloud)");
      }

      const { data, error } = await supabase.functions.invoke("send-whatsapp-cloud", {
        body: {
          instance_id: instance.id,
          tenant_id: tenantId,
          action: "send_template",
          phone: normalizePhone(phone),
          template_name: templateName,
          template_language: templateLanguage || "pt_BR",
          template_params: templateParams || [],
          lead_id: leadId,
          sent_by: "human",
          sent_by_name: teamMember?.name,
          ...(headerMediaUrl ? {
            header_media_url: headerMediaUrl,
            header_media_type: headerMediaType || 'image',
          } : {}),
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-messages"] });
      queryClient.invalidateQueries({ queryKey: ["message-window", tenantId, vars.leadId] });
    },
  });
}
