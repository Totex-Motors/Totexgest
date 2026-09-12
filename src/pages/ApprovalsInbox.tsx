import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertTriangle, Ban, Check, ExternalLink, Gavel, Loader2, ShieldCheck, X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import {
  useApprovalRequests,
  useApproveRequest,
  useCancelApproval,
  useCanApprove,
  useRejectRequest,
} from "@/hooks/useIntermediation";
import {
  APPROVAL_KIND_LABEL,
  APPROVAL_STATUS_META,
  COMMISSION_TYPE_LABEL,
  INTERMEDIATION_STATUS_META,
  type ApprovalRequest,
  type CommissionType,
  type IntermediationStatus,
} from "@/types/intermediation";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL = (v?: number | null) => (v == null ? "—" : BRL.format(Number(v)));
const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const numOf = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Linhas de detalhe (params) por tipo de pedido. */
function RequestDetails({ r }: { r: ApprovalRequest }) {
  const p = r.params ?? {};
  const rows: { label: string; value: string }[] = [];

  switch (r.kind) {
    case "sell_below_minimum": {
      const amount = numOf(p.amount);
      const minimum = numOf(p.minimum);
      rows.push({ label: "Proposta", value: fmtBRL(amount) });
      rows.push({ label: "Mínimo autorizado", value: fmtBRL(minimum) });
      if (amount != null && minimum != null) rows.push({ label: "Diferença", value: fmtBRL(amount - minimum) });
      break;
    }
    case "commission_change": {
      const type = str(p.commission_type) as CommissionType | null;
      const value = numOf(p.commission_value);
      const nova = type === "percent" ? `${value ?? "—"}%` : fmtBRL(value);
      rows.push({ label: "Nova comissão", value: `${nova}${type ? ` (${COMMISSION_TYPE_LABEL[type]})` : ""}` });
      if (str(p.reason)) rows.push({ label: "Motivo", value: str(p.reason)! });
      break;
    }
    case "commission_waive":
      rows.push({ label: "Valor renunciado", value: fmtBRL(numOf(p.amount) ?? r.amount) });
      break;
    case "cancel_active": {
      const ns = str(p.new_status) as IntermediationStatus | null;
      rows.push({ label: "Encerrar como", value: ns ? INTERMEDIATION_STATUS_META[ns]?.label ?? ns : "—" });
      if (str(p.reason)) rows.push({ label: "Motivo", value: str(p.reason)! });
      break;
    }
    case "financial_concession":
      rows.push({ label: "Valor", value: fmtBRL(numOf(p.amount) ?? r.amount) });
      if (str(p.description)) rows.push({ label: "Descrição", value: str(p.description)! });
      break;
  }

  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
      {rows.map((row) => (
        <div key={row.label} className="flex gap-2">
          <dt className="text-muted-foreground shrink-0">{row.label}:</dt>
          <dd className="font-medium break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function ApprovalsInbox() {
  const { isPromotora } = useAuth();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const requestsQ = useApprovalRequests(filter);
  const pendingQ = useApprovalRequests("pending");
  const canApproveQ = useCanApprove();
  const { data: members = [] } = useAllTeamMembers();

  const approve = useApproveRequest();
  const reject = useRejectRequest();
  const cancel = useCancelApproval();

  const [rejecting, setRejecting] = useState<ApprovalRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const requests = useMemo(() => requestsQ.data ?? [], [requestsQ.data]);
  const pendingCount = (pendingQ.data ?? []).length;
  const canApprove = canApproveQ.data === true;

  const memberName = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((x) => m.set(x.id, x.name));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [members]);

  const runApprove = async (r: ApprovalRequest) => {
    setBusyId(r.id);
    try {
      await approve.mutateAsync({ requestId: r.id });
      toast.success("Pedido aprovado e aplicado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui aprovar o pedido.");
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting.id);
    try {
      await reject.mutateAsync({ requestId: rejecting.id, note: rejectReason.trim() || null });
      toast.success("Pedido recusado.");
      setRejecting(null);
      setRejectReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui recusar o pedido.");
    } finally {
      setBusyId(null);
    }
  };

  const runCancel = async (r: ApprovalRequest) => {
    setBusyId(r.id);
    try {
      await cancel.mutateAsync({ requestId: r.id });
      toast.success("Pedido cancelado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui cancelar o pedido.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-5 p-4 md:p-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
              <Gavel className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                Aprovações
                {pendingCount > 0 && (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                    {pendingCount} pendente{pendingCount === 1 ? "" : "s"}
                  </Badge>
                )}
              </h1>
              <p className="text-xs text-muted-foreground">
                Exceções que exigem alçada de uma administradora (venda abaixo do mínimo, comissão, encerramento, concessão).
              </p>
            </div>
          </div>
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "pending" | "all")}>
            <TabsList>
              <TabsTrigger value="pending" className="text-xs">Pendentes</TabsTrigger>
              <TabsTrigger value="all" className="text-xs">Todos</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {isPromotora ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Sem acesso.</CardContent></Card>
        ) : canApprove ? (
          <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Você tem alçada para aprovar ou recusar estes pedidos.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Você pode acompanhar e cancelar seus pedidos. Só uma administradora com alçada aprova/recusa.
          </p>
        )}

        {/* Lista */}
        {requestsQ.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</p>
        ) : requestsQ.isError ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Não consegui carregar os pedidos.</CardContent></Card>
        ) : requests.length === 0 ? (
          <Card><CardContent className="py-10 text-center space-y-1">
            <ShieldCheck className="h-8 w-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{filter === "pending" ? "Nenhum pedido pendente." : "Nenhum pedido registrado."}</p>
          </CardContent></Card>
        ) : (
          <div className="space-y-2.5">
            {requests.map((r) => {
              const sm = APPROVAL_STATUS_META[r.status];
              const requester = memberName(r.requested_by);
              const decider = memberName(r.decided_by);
              const busy = busyId === r.id;
              return (
                <Card key={r.id} className={cn(r.status === "pending" && "border-amber-200/70 dark:border-amber-900/60")}>
                  <CardContent className="p-4 space-y-2.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-semibold">{APPROVAL_KIND_LABEL[r.kind]}</p>
                        <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          {r.intermediation?.code && (
                            r.intermediation.owner_lead_id ? (
                              <Link to={`/comercial/leads/${r.intermediation.owner_lead_id}`} className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline">
                                <span className="font-mono">{r.intermediation.code}</span>
                                {r.lead_name ? <span>· {r.lead_name}</span> : null}
                                <ExternalLink className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="font-mono">{r.intermediation.code}</span>
                            )
                          )}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn("border text-[11px] shrink-0", sm.cls)}>{sm.label}</Badge>
                    </div>

                    <RequestDetails r={r} />

                    <p className="text-[11px] text-muted-foreground">
                      Solicitado por <strong className="text-foreground">{requester ?? "—"}</strong> · {fmtDateTime(r.requested_at)}
                      {r.status !== "pending" && (
                        <> · {sm.label.toLowerCase()}{decider ? ` por ${decider}` : ""}{r.decided_at ? ` em ${fmtDateTime(r.decided_at)}` : ""}</>
                      )}
                    </p>
                    {r.decision_note && <p className="text-[11px] text-muted-foreground">Observação: {r.decision_note}</p>}

                    {r.status === "pending" && (
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        {canApprove && (
                          <>
                            <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => runApprove(r)}>
                              {busy && approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />} Aprovar
                            </Button>
                            <Button size="sm" variant="outline" className="h-8 text-xs text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => { setRejecting(r); setRejectReason(""); }}>
                              <X className="h-3.5 w-3.5 mr-1" /> Recusar
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground hover:text-foreground" disabled={busy} onClick={() => runCancel(r)}>
                          {busy && cancel.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Ban className="h-3.5 w-3.5 mr-1" />} Cancelar pedido
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Recusar */}
      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!reject.isPending && !o) { setRejecting(null); setRejectReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Recusar pedido</DialogTitle>
            <DialogDescription>
              {rejecting ? APPROVAL_KIND_LABEL[rejecting.kind] : ""}{rejecting?.intermediation?.code ? ` — ${rejecting.intermediation.code}` : ""}. A ação não será aplicada.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo (opcional)</Label>
            <Textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Ex.: valor fora da política / falta justificativa" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejecting(null); setRejectReason(""); }} disabled={reject.isPending}>Voltar</Button>
            <Button variant="destructive" onClick={confirmReject} disabled={reject.isPending}>
              {reject.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <X className="h-4 w-4 mr-1" />} Recusar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
