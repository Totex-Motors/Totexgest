import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Phone, Video, Car, FileText, ClipboardCheck, Camera, MessageSquare, RefreshCw, CalendarCheck } from 'lucide-react';
import { useInteractionMetrics } from '@/hooks/useInteractionMetrics';
import { formatPercent } from './shared';

// Ordem e rótulos dos tipos de interação (concessionária).
const TYPES: { key: string; label: string; icon: any; dot: string }[] = [
  { key: 'video_call', label: 'Chamada de vídeo', icon: Video, dot: 'bg-indigo-500' },
  { key: 'visit', label: 'Visita / Test drive', icon: Car, dot: 'bg-orange-500' },
  { key: 'proposal', label: 'Proposta / Simulação', icon: FileText, dot: 'bg-violet-500' },
  { key: 'trade_eval', label: 'Avaliação da troca', icon: ClipboardCheck, dot: 'bg-rose-500' },
  { key: 'photo_session', label: 'Sessão de fotos', icon: Camera, dot: 'bg-fuchsia-500' },
  { key: 'call', label: 'Ligação', icon: Phone, dot: 'bg-blue-500' },
  { key: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, dot: 'bg-green-500' },
  { key: 'follow_up', label: 'Follow-up', icon: RefreshCw, dot: 'bg-yellow-500' },
];

interface Props {
  dateRange: { from: Date; to: Date };
}

function rateColor(pct: number): string {
  if (pct >= 70) return 'text-emerald-600 dark:text-emerald-400';
  if (pct >= 40) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

export function InteractionMetricsCard({ dateRange }: Props) {
  const { data, isLoading } = useInteractionMetrics(dateRange);

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <CalendarCheck className="h-4 w-4 text-indigo-500" /> Interações &amp; Comparecimento
            <span className="text-[10px] font-normal text-muted-foreground">no período</span>
          </span>
          {data && data.total > 0 && (
            <span className="text-xs font-normal text-muted-foreground">{data.total} interações</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !data || data.total === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhuma interação registrada no período. Crie ligações, visitas, test drives e
            propostas nas tarefas do lead pra medir aqui.
          </p>
        ) : (
          <>
            {/* Destaques: comparecimento + conversão */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Comparecimento
                </div>
                {data.attendanceRate != null ? (
                  <>
                    <div className={`text-2xl font-bold tabular-nums ${rateColor(data.attendanceRate)}`}>
                      {formatPercent(data.attendanceRate)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {data.presAttended} compareceram · {data.presNoShow} faltaram
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">sem apresentações</div>
                )}
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                  Apresentação → venda
                </div>
                {data.conversionRate != null ? (
                  <>
                    <div className={`text-2xl font-bold tabular-nums ${rateColor(data.conversionRate)}`}>
                      {formatPercent(data.conversionRate)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {data.presWon} de {data.presLeads} viraram venda
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">—</div>
                )}
              </div>
            </div>

            {/* Volume por tipo */}
            <div className="space-y-1 pt-1">
              {TYPES.map((t) => {
                const s = data.byType[t.key];
                if (!s || s.total === 0) return null;
                const Icon = t.icon;
                const isPres = t.key === 'video_call' || t.key === 'visit';
                return (
                  <div key={t.key} className="flex items-center justify-between text-xs px-1 py-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full ${t.dot}`} />
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate">{t.label}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      {isPres && s.no_show > 0 && (
                        <span className="text-[10px] text-red-500">{s.no_show} faltou</span>
                      )}
                      <span className="font-semibold tabular-nums">{s.total}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
