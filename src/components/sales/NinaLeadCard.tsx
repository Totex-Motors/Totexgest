import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PhoneCall, PhoneOff, Loader2, Mic } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * Card "Nina (voz)" no detalhe do lead: última ligação (leads.metadata.nina.last_call),
 * permissão de ligação (metadata.call_permission), fila de saída e o botão
 * "Pedir pra Nina ligar" (RPC nina_enqueue_call — Fase B, docs/NINA-VOZ.md §2d).
 */
interface Props {
  leadId: string;
  metadata?: Record<string, any> | null;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "na fila", awaiting_permission: "aguardando permissão", calling: "ligando agora",
  done: "concluída", no_answer: "não atendeu", failed: "falhou", cancelled: "cancelada", expired: "sem permissão",
};

export function NinaLeadCard({ leadId, metadata }: Props) {
  const qc = useQueryClient();
  const nina = (metadata?.nina || {}) as Record<string, any>;
  const perm = (metadata?.call_permission || {}) as Record<string, any>;
  const lastCall = nina.last_call as Record<string, any> | undefined;

  const { data: queue } = useQuery({
    queryKey: ["nina-queue", leadId],
    queryFn: async () => {
      const { data } = await (supabase as any).from("nina_call_queue")
        .select("id, status, scheduled_for, attempts, outcome, last_error")
        .eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data as { id: string; status: string; scheduled_for: string; attempts: number; outcome: string | null; last_error: string | null } | null;
    },
  });

  const enqueue = useMutation({
    mutationFn: async () => {
      const { data, error } = await (supabase as any).rpc("nina_enqueue_call", { p_lead_id: leadId, p_reason: "manual", p_delay_minutes: 0 });
      if (error) throw error;
      return data as string;
    },
    onSuccess: () => { toast.success("Nina vai ligar no próximo horário comercial (a cada 2 min)."); qc.invalidateQueries({ queryKey: ["nina-queue", leadId] }); },
    onError: (e: Error) => toast.error("Não deu pra enfileirar", { description: e.message }),
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase as any).rpc("nina_cancel_call", { p_queue_id: queue?.id });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Ligação cancelada."); qc.invalidateQueries({ queryKey: ["nina-queue", leadId] }); },
    onError: (e: Error) => toast.error("Não cancelou", { description: e.message }),
  });

  const open = queue && ["queued", "awaiting_permission", "calling"].includes(queue.status);
  const permLabel = perm.status === "permanent" ? "permanente" : perm.status === "temporary" ? `até ${perm.expires_at ? new Date(perm.expires_at).toLocaleDateString("pt-BR") : "7 dias"}` : perm.status === "rejected" ? "negada" : null;

  return (
    <Card className="border-violet-200/70 dark:border-violet-900/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Mic className="h-4 w-4 text-violet-600" /> Nina (voz)
          {permLabel && <Badge variant="outline" className="ml-auto text-[10px]">permissão: {permLabel}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {lastCall ? (
          <div className="text-xs">
            <p className="font-medium">
              Última ligação {lastCall.at ? new Date(lastCall.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""} · {lastCall.outcome === "nao_atendeu" ? "não atendeu" : `${lastCall.duracao || 0}s`}{lastCall.agendou ? " · agendou ✅" : ""}
            </p>
            {lastCall.resumo && <p className="text-muted-foreground mt-0.5 line-clamp-3">{lastCall.resumo}</p>}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">A Nina ainda não falou com este lead.</p>
        )}
        {queue && (
          <p className="text-xs">
            Fila: <Badge variant="outline" className="text-[10px]">{STATUS_LABEL[queue.status] || queue.status}</Badge>
            {open && <span className="text-muted-foreground"> · {new Date(queue.scheduled_for).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · tentativa {queue.attempts}</span>}
            {!open && queue.last_error && <span className="text-muted-foreground"> · {queue.last_error}</span>}
          </p>
        )}
        <div className="flex gap-2">
          {open ? (
            <Button size="sm" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending || queue?.status === "calling"}>
              {cancel.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PhoneOff className="h-4 w-4 mr-1" />} Cancelar ligação
            </Button>
          ) : (
            <Button size="sm" className="bg-violet-600 hover:bg-violet-700" onClick={() => enqueue.mutate()} disabled={enqueue.isPending}>
              {enqueue.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PhoneCall className="h-4 w-4 mr-1" />} Pedir pra Nina ligar
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
