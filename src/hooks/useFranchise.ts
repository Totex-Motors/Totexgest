import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { usePipelines } from "@/hooks/usePipelineConfig";
import { isFranchisePipeline } from "@/lib/franchise";

/**
 * Franqueados (lead_kind = 'franchise') — dados da tela /comercial/franqueados.
 * O funil em si é lido com usePipelineDeals(undefined, pipeline.id) (mesmo kanban
 * do pipeline de carro, só que apontando pro pipeline de recrutamento).
 */

export interface FranchiseLeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city_name: string | null;
  state: string | null;
  capital_disponivel: string | null;
  source: string | null;
  utm_source: string | null;
  created_at: string;
  sales_rep_id: string | null;
  franchise_member_name: string | null;
  metadata: Record<string, unknown> | null;
  deals: { id: string; pipeline_id: string | null; pipeline_stage_id: string | null; status: string | null }[] | null;
}

/** Pipeline "Recrutamento de Franqueados" do tenant logado (ou undefined se não existe). */
export const useFranchisePipeline = () => {
  const q = usePipelines();
  const pipeline = useMemo(() => (q.data || []).find((p) => isFranchisePipeline(p)), [q.data]);
  return { ...q, pipeline };
};

/** Todos os leads franqueados do tenant (com os deals, pra saber quem está fora do funil). */
export const useFranchiseLeads = () => {
  return useQuery({
    queryKey: ["franchise-leads"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("leads")
        .select(
          "id, name, phone, email, city_name, state, capital_disponivel, source, utm_source, created_at, sales_rep_id, franchise_member_name, metadata, deals:deals!deals_lead_id_fkey(id, pipeline_id, pipeline_stage_id, status)",
        )
        .eq("lead_kind", "franchise")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data || []) as FranchiseLeadRow[];
    },
  });
};

export interface CreateFranchiseLeadInput {
  tenantId: string;
  name: string;
  phone: string;
  email?: string;
  city?: string;
  state?: string;
  capital?: string;
  notes?: string;
}

export interface CreateFranchiseLeadResult {
  lead_id: string;
  created: boolean;
  lead_kind: string;
  deal_id: string | null;
}

/**
 * "Novo franqueado" manual: porta canônica find_or_create_lead com p_lead_kind='franchise'.
 * Se o telefone já existe como outro tipo (comprador/vendedor), NÃO converte — devolve
 * o que achou pra UI avisar. Depois garante o deal no funil (franchise_ensure_deal).
 */
export const useCreateFranchiseLead = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFranchiseLeadInput): Promise<CreateFranchiseLeadResult> => {
      // (supabase as any): os tipos gerados do Database não conhecem as RPCs novas (padrão do repo)
      const { data, error } = await (supabase as any).rpc("find_or_create_lead", {
        p_tenant: input.tenantId,
        p_phone: input.phone,
        p_name: input.name,
        p_source: "manual",
        p_email: input.email || null,
        p_utm_source: "prospeccao_franqueado",
        p_metadata: {
          origin: "franqueados_manual",
          ...(input.city ? { cidade: input.city } : {}),
          ...(input.state ? { uf: input.state } : {}),
          ...(input.capital ? { capital_disponivel: input.capital } : {}),
          ...(input.notes ? { observacoes: input.notes } : {}),
        },
        p_lead_kind: "franchise",
      } as any);
      if (error) throw error;
      const r = (data || {}) as { lead_id: string; created: boolean; lead_kind: string };

      if (r.created) {
        // Campos próprios do franqueado (a RPC só grava nome/telefone/email/metadata)
        const patch: Record<string, unknown> = {};
        if (input.city) patch.city_name = input.city;
        if (input.state) patch.state = input.state.toUpperCase();
        if (input.capital) patch.capital_disponivel = input.capital;
        if (Object.keys(patch).length > 0) {
          await (supabase as any).from("leads").update(patch).eq("id", r.lead_id);
        }
      }

      let dealId: string | null = null;
      if (r.lead_kind === "franchise") {
        const { data: d, error: dErr } = await (supabase as any).rpc("franchise_ensure_deal", { p_lead_id: r.lead_id });
        if (dErr) throw dErr;
        dealId = (d as string) || null;
      }
      return { lead_id: r.lead_id, created: !!r.created, lead_kind: r.lead_kind, deal_id: dealId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["franchise-leads"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
      queryClient.invalidateQueries({ queryKey: ["sales-leads"] });
    },
  });
};

/** "Colocar no funil": lead franqueado sem deal no pipeline de recrutamento. */
export const useFranchiseEnsureDeal = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (leadId: string) => {
      const { data, error } = await (supabase as any).rpc("franchise_ensure_deal", { p_lead_id: leadId });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["franchise-leads"] });
      queryClient.invalidateQueries({ queryKey: ["pipeline-deals"] });
    },
  });
};
