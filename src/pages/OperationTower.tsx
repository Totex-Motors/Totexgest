import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNavigate } from "react-router-dom";
import {
  Radar, Zap, AlertTriangle, Clock, RefreshCw, UserPlus,
  Sparkles, TrendingUp, CheckCircle2, Gauge, Bell,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useOperationTower } from "@/hooks/useOperationTower";
import { useSupervisorBriefing } from "@/hooks/useSupervisorBriefing";
import { OperationAlertConfigDialog } from "@/components/sales/OperationAlertConfigDialog";

// Semáforo por minutos de espera (lead sem primeiro contato)
function slaColor(minutes: number): { dot: string; text: string; label: string } {
  if (minutes <= 15) return { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", label: "no prazo" };
  if (minutes <= 60) return { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", label: "atenção" };
  return { dot: "bg-red-500", text: "text-red-600 dark:text-red-400", label: "estourou" };
}

function waitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${m}` : `${h}h`;
}

export default function OperationTower() {
  const navigate = useNavigate();
  const { data, isLoading, refetch, isRefetching } = useOperationTower();
  const briefing = useSupervisorBriefing();
  const [briefingText, setBriefingText] = useState<string | null>(null);
  const [alertConfigOpen, setAlertConfigOpen] = useState(false);

  const stats = data?.stats;

  const runBriefing = () => {
    if (!data) return;
    briefing.mutate(
      {
        stats: data.stats,
        unattended: data.unattended.slice(0, 20).map((e) => ({
          nome: e.lead_name,
          tipo: e.conversion_type,
          canal: e.source,
          assunto: e.note_subject,
          esperando_min: e.minutes_waiting,
          vendedor: e.sales_rep_name,
        })),
        overdueByRep: data.overdueByRep,
      },
      { onSuccess: (res) => setBriefingText(res.plano || res.raw || "Sem retorno.") }
    );
  };

  return (
    <AppLayout>
      <div className="space-y-5 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <Radar className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Torre de Controle</h1>
              <p className="text-xs text-muted-foreground">
                Tudo que está entrando e quem está (ou não) sendo atendido — atualiza a cada 30s
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAlertConfigOpen(true)}>
              <Bell className="h-4 w-4 mr-1.5" />
              Configurar alertas
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
              <RefreshCw className={cn("h-4 w-4 mr-1.5", isRefetching && "animate-spin")} />
              Atualizar
            </Button>
          </div>
        </div>

        <OperationAlertConfigDialog open={alertConfigOpen} onOpenChange={setAlertConfigOpen} />

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiTile icon={<TrendingUp className="h-4 w-4" />} label="Entradas 24h" value={stats?.entries24h} loading={isLoading} tone="blue" />
          <KpiTile icon={<UserPlus className="h-4 w-4" />} label="Novos / Reconv." value={stats ? `${stats.newCount}/${stats.reconversionCount}` : undefined} loading={isLoading} tone="violet" />
          <KpiTile icon={<AlertTriangle className="h-4 w-4" />} label="Sem atendimento" value={stats?.unattendedCount} loading={isLoading} tone={stats && stats.unattendedCount > 0 ? "red" : "emerald"} />
          <KpiTile icon={<Gauge className="h-4 w-4" />} label="SLA ≤15min" value={stats?.slaPct15min != null ? `${stats.slaPct15min}%` : "—"} loading={isLoading} tone="amber" />
          <KpiTile icon={<Clock className="h-4 w-4" />} label="Follow-ups vencidos" value={stats?.overdueCount} loading={isLoading} tone={stats && stats.overdueCount > 0 ? "red" : "emerald"} />
        </div>

        {/* Copiloto do supervisor */}
        <Card className="border shadow-sm bg-gradient-to-br from-indigo-50/60 to-blue-50/40 dark:from-indigo-950/20 dark:to-blue-950/10">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-indigo-500" /> Copiloto do Supervisor
              </CardTitle>
              <Button size="sm" onClick={runBriefing} disabled={briefing.isPending || isLoading || !data}>
                {briefing.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-1.5 animate-spin" /> Analisando…</>
                ) : (
                  <><Sparkles className="h-4 w-4 mr-1.5" /> Gerar plano de ação</>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {briefingText ? (
              <div className="text-sm whitespace-pre-wrap leading-relaxed text-foreground/90">{briefingText}</div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Clique em <strong>Gerar plano de ação</strong> e a IA analisa a fila atual, prioriza os casos mais
                urgentes e sugere o que o supervisor deve fazer agora — quem cobrar, quais leads redistribuir e por onde começar.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Fila de não atendidos */}
          <Card className="lg:col-span-7 border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-500" /> Aguardando primeiro contato
                {stats && <Badge variant="secondary" className="ml-1">{stats.unattendedCount}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
              ) : data && data.unattended.length > 0 ? (
                <ScrollArea className="max-h-[420px] pr-3">
                  <div className="space-y-1.5">
                    {data.unattended.map((e) => {
                      const sla = slaColor(e.minutes_waiting);
                      return (
                        <button
                          key={e.conversion_id}
                          onClick={() => navigate(`/comercial/leads/${e.lead_id}`)}
                          className="w-full text-left flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60 transition-colors border border-transparent hover:border-border"
                        >
                          <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", sla.dot)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium truncate">{e.lead_name}</span>
                              {e.conversion_type === "reconversion" && (
                                <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-400 text-amber-600 dark:text-amber-400">
                                  <RefreshCw className="h-2.5 w-2.5 mr-0.5" /> reconversão
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {e.note_subject || e.source || "sem tratativa"}
                              {e.sales_rep_name ? ` · ${e.sales_rep_name}` : " · sem vendedor"}
                            </div>
                          </div>
                          <div className={cn("text-right shrink-0", sla.text)}>
                            <div className="text-xs font-bold tabular-nums">{waitLabel(e.minutes_waiting)}</div>
                            <div className="text-[9px]">{sla.label}</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              ) : (
                <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  Todo mundo que entrou nas últimas 24h já foi atendido. 🎉
                </div>
              )}
            </CardContent>
          </Card>

          {/* Follow-ups vencidos por vendedor */}
          <Card className="lg:col-span-5 border shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-500" /> Follow-ups vencidos por vendedor
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
              ) : data && data.overdueByRep.length > 0 ? (
                <div className="space-y-1.5">
                  {data.overdueByRep.map((r) => (
                    <div key={r.rep_id || "sem"} className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/40">
                      <span className="text-sm font-medium truncate">{r.rep_name}</span>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] text-muted-foreground">+{r.oldest_hours}h o mais antigo</span>
                        <Badge variant={r.count >= 5 ? "destructive" : "secondary"} className="tabular-nums">{r.count}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                  <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                  Nenhum follow-up vencido.
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Feed de entradas do dia */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Zap className="h-4 w-4 text-blue-500" /> Entradas das últimas 24h
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            ) : data && data.entries.length > 0 ? (
              <ScrollArea className="max-h-[380px] pr-3">
                <div className="space-y-1">
                  {data.entries.map((e) => (
                    <button
                      key={e.conversion_id}
                      onClick={() => navigate(`/comercial/leads/${e.lead_id}`)}
                      className="w-full text-left flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60 transition-colors"
                    >
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-16">
                        {format(new Date(e.created_at), "dd/MM HH:mm", { locale: ptBR })}
                      </span>
                      {e.conversion_type === "reconversion" ? (
                        <RefreshCw className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                      ) : (
                        <UserPlus className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium truncate">{e.lead_name}</span>
                        <span className="text-[10px] text-muted-foreground truncate block">
                          {e.note_subject || e.source || "—"}{e.utm_campaign ? ` · ${e.utm_campaign}` : ""}
                        </span>
                      </div>
                      {e.attended ? (
                        <Badge variant="outline" className="text-[9px] border-emerald-400 text-emerald-600 dark:text-emerald-400 shrink-0">
                          <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                          {e.minutes_to_contact != null ? `${waitLabel(e.minutes_to_contact)}` : "atendido"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[9px] border-red-400 text-red-600 dark:text-red-400 shrink-0">
                          aguardando
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">Nenhuma entrada nas últimas 24h.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

function KpiTile({ icon, label, value, loading, tone }: {
  icon: React.ReactNode; label: string; value?: string | number; loading?: boolean;
  tone: "blue" | "violet" | "red" | "emerald" | "amber";
}) {
  const tones: Record<string, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    violet: "text-violet-600 dark:text-violet-400",
    red: "text-red-600 dark:text-red-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
  };
  return (
    <Card className="border shadow-sm">
      <CardContent className="p-3">
        <div className={cn("flex items-center gap-1.5 mb-1", tones[tone])}>
          {icon}
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-12" />
        ) : (
          <div className={cn("text-2xl font-bold tabular-nums", tones[tone])}>{value ?? "—"}</div>
        )}
      </CardContent>
    </Card>
  );
}
