import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { captureKeys } from "@/hooks/useCaptureLeads";

/**
 * Vincular atendimento por telefone — a promotora acha um lead que JÁ existe no
 * tenant de uma loja (criado pelo "cérebro" quando o cliente escaneou o QR) e se
 * vincula a ele sem recadastrar (sem duplicar). O crédito de R$150 cai pelo
 * caminho buyer_sold (lead master de atribuição no tenant da promotora).
 */

export type AttendanceCandidate = {
  lead_id: string;
  name: string;
  phone_tail: string | null;
  created_at: string;
  veiculo: string | null;
  already_linked: boolean;
  linked_promoter: string | null;
};

export type LinkAttendanceResult = {
  ok: boolean;
  already: boolean;
  master_lead_id?: string;
  store_lead_id: string;
  store_name: string | null;
  promoter_name: string | null;
  veiculo?: string | null;
};

export function useFindAttendance() {
  return useMutation({
    mutationFn: async ({ tenantId, phone }: { tenantId: string; phone: string }): Promise<AttendanceCandidate[]> => {
      const { data, error } = await supabase.rpc("capture_find_attendance", {
        p_tenant_id: tenantId,
        p_phone: phone,
      });
      if (error) throw error;
      return (data ?? []) as AttendanceCandidate[];
    },
  });
}

export function useLinkAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ storeLeadId, observacao }: { storeLeadId: string; observacao?: string | null }): Promise<LinkAttendanceResult> => {
      const { data, error } = await supabase.rpc("capture_link_attendance", {
        p_store_lead_id: storeLeadId,
        p_observacao: observacao ?? null,
      });
      if (error) throw error;
      return data as LinkAttendanceResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: captureKeys.all });
      qc.invalidateQueries({ queryKey: ["capture", "buyer-leads"] });
    },
  });
}
