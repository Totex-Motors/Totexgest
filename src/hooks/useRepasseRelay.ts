import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { callUazapi } from "@/lib/uazapiProxy";

/**
 * Repasse Relay — hooks da tela de configuração (Configurações › Integrações).
 * Fala direto com as tabelas repasse_relay_config / repasse_relay_posts (RLS de
 * admin do tenant) e com a edge function repasse-relay (preview).
 */

export type RepasseVoice = "equilibrado" | "vendedor" | "consultor" | "descolado";

export interface RepasseConfig {
  id: string;
  tenant_id: string;
  instance_id: string;
  source_group_jid: string;
  target_group_jid: string;
  margin: number;
  voice: RepasseVoice;
  signature: string;
  model: string;
  min_source_price: number | null;
  max_source_price: number | null;
  post_without_price: boolean;
  active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RepasseLogRow {
  id: string;
  config_id: string | null;
  source_message_id: string;
  modelo: string | null;
  preco_original: number | null;
  margem: number | null;
  preco_final: number | null;
  post_text: string | null;
  status: "posted" | "skipped" | "error";
  skip_reason: string | null;
  error: string | null;
  created_at: string;
}

export interface UazapiGroup {
  jid: string;
  name: string;
}

export interface RepassePreview {
  modelo: string | null;
  precoOriginal: number | null;
  margem: number;
  precoFinal: number | null;
  abaixoFinal: number | null;
  post: string;
  targetGroupJid: string;
}

/** Configs do tenant (normalmente uma). */
export function useRepasseConfigs() {
  return useQuery({
    queryKey: ["repasse-configs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("repasse_relay_config")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as RepasseConfig[];
    },
  });
}

/** Instâncias UAZAPI do tenant (o relay só usa número não oficial). */
export function useUazapiInstances(tenantId: string | null) {
  return useQuery({
    queryKey: ["repasse-instances", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("whatsapp_instances")
        .select("id, name, status, provider")
        .eq("tenant_id", tenantId!)
        .order("name");
      return ((data ?? []) as { id: string; name: string; status: string | null; provider: string | null }[])
        .filter((i) => i.provider !== "meta_cloud");
    },
  });
}

/** Grupos que a instância participa (pra escolher origem/destino sem colar JID). */
export function useUazapiGroups(instanceId: string | null) {
  return useQuery({
    queryKey: ["repasse-groups", instanceId],
    enabled: !!instanceId,
    staleTime: 60_000,
    queryFn: async (): Promise<UazapiGroup[]> => {
      const res = await callUazapi<{ groups?: any[]; Groups?: any[] }>("group_list", instanceId);
      const raw = (res?.data?.groups ?? res?.data?.Groups ?? []) as any[];
      return raw
        .map((g) => ({
          jid: String(g.JID ?? g.jid ?? g.id ?? ""),
          name: String(g.Name ?? g.name ?? g.subject ?? g.JID ?? "Grupo"),
        }))
        .filter((g) => g.jid.endsWith("@g.us"))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}

/** Cria ou atualiza uma config. tenant_id vem do default (get_tenant_id) no insert. */
export function useSaveRepasseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cfg: Partial<RepasseConfig> & { instance_id: string; source_group_jid: string; target_group_jid: string }) => {
      const payload = {
        instance_id: cfg.instance_id,
        source_group_jid: cfg.source_group_jid,
        target_group_jid: cfg.target_group_jid,
        margin: cfg.margin ?? 5000,
        voice: cfg.voice ?? "equilibrado",
        signature: (cfg.signature ?? "TOTEX Motors").trim() || "TOTEX Motors",
        min_source_price: cfg.min_source_price ?? null,
        max_source_price: cfg.max_source_price ?? null,
        post_without_price: cfg.post_without_price ?? false,
        active: cfg.active ?? true,
      };
      if (cfg.id) {
        const { error } = await supabase.from("repasse_relay_config").update(payload).eq("id", cfg.id);
        if (error) throw error;
        return cfg.id;
      }
      const { data, error } = await supabase.from("repasse_relay_config").insert(payload).select("id").single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repasse-configs"] }),
  });
}

/** Liga/desliga sem abrir o formulário. */
export function useToggleRepasseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { error } = await supabase.from("repasse_relay_config").update({ active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repasse-configs"] }),
  });
}

export function useDeleteRepasseConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("repasse_relay_config").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["repasse-configs"] }),
  });
}

/** Últimos posts processados (auditoria). */
export function useRepasseLog(limit = 20) {
  return useQuery({
    queryKey: ["repasse-log", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("repasse_relay_posts")
        .select("id, config_id, source_message_id, modelo, preco_original, margem, preco_final, post_text, status, skip_reason, error, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as RepasseLogRow[];
    },
    refetchInterval: 30_000,
  });
}

/** Gera o post SEM enviar (botão "Testar"), via edge function repasse-relay. */
export function usePreviewRepasse() {
  return useMutation({
    mutationFn: async (args: { instance_id: string; source_group_jid: string; text: string }): Promise<RepassePreview> => {
      const { data, error } = await supabase.functions.invoke("repasse-relay", {
        body: { action: "preview", ...args },
      });
      if (error) {
        let message = error.message || "Falha ao gerar a prévia";
        try {
          const ctx = await (error as any).context?.json?.();
          if (ctx?.error) message = ctx.error;
        } catch { /* mantém a mensagem padrão */ }
        throw new Error(message);
      }
      if (data && typeof data === "object" && "error" in data && !("ok" in data)) {
        throw new Error((data as any).error);
      }
      return (data as { data: RepassePreview }).data;
    },
  });
}
