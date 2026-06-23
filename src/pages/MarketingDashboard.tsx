import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Mail, Send, Eye, MousePointerClick, AlertTriangle,
  ChevronLeft, ChevronRight, Search, Loader2, ExternalLink, Sparkles, Filter,
} from 'lucide-react';
import {
  useEmailKpis, useEmailSendsLog, useEmailSendsTimeseries,
  type EmailKpiPeriod, type EmailSendLogRow,
} from '@/hooks/useEmailMarketing';
import EmailTimelineModal from '@/components/client360/EmailTimelineModal';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pendente', color: 'text-gray-700 bg-gray-100' },
  sent: { label: 'Enviado', color: 'text-sky-700 bg-sky-50' },
  delivered: { label: 'Entregue', color: 'text-teal-700 bg-teal-50' },
  opened: { label: 'Aberto', color: 'text-indigo-700 bg-indigo-50' },
  clicked: { label: 'Clicado', color: 'text-purple-700 bg-purple-50' },
  bounced: { label: 'Bounce', color: 'text-red-700 bg-red-50' },
  failed: { label: 'Falhou', color: 'text-red-700 bg-red-50' },
  complained: { label: 'Spam', color: 'text-rose-700 bg-rose-50' },
  unsubscribed: { label: 'Descadastrou', color: 'text-orange-700 bg-orange-50' },
};

const PERIODS: { value: EmailKpiPeriod; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: 'all', label: 'Tudo' },
];

function fmtPct(n: number | undefined) {
  return typeof n === 'number' ? `${n}%` : '—';
}

function Kpi({ label, value, sub, icon: Icon, accent }: {
  label: string; value: string | number; sub?: string; icon: any; accent?: string;
}) {
  return (
    <div className="relative p-4 rounded-xl border bg-card hover:bg-card/80 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">{label}</span>
        <Icon className={cn('h-3.5 w-3.5', accent || 'text-muted-foreground')} />
      </div>
      <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-1.5">{sub}</p>}
    </div>
  );
}

function SparkBars({ data }: { data: { date: string; sent: number; opened: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.sent));
  return (
    <div className="flex items-end gap-[3px] h-16">
      {data.map((d, i) => {
        const sentH = (d.sent / max) * 100;
        const openedH = d.sent > 0 ? (d.opened / d.sent) * sentH : 0;
        return (
          <div
            key={i}
            className="flex-1 flex flex-col justify-end group relative cursor-default"
            title={`${d.date}: ${d.sent} enviados · ${d.opened} aberturas`}
          >
            <div
              className="bg-[#BAA05E]/30 rounded-sm transition-all group-hover:bg-[#BAA05E]/50"
              style={{ height: `${sentH}%`, minHeight: d.sent > 0 ? 2 : 0 }}
            >
              <div
                className="bg-[#BAA05E] rounded-sm"
                style={{ height: `${(openedH / Math.max(0.01, sentH)) * 100}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function MarketingDashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<EmailKpiPeriod>('30d');
  const [source, setSource] = useState<'all' | 'campaign' | 'automation'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selectedSend, setSelectedSend] = useState<EmailSendLogRow | null>(null);

  const { data: kpis, isLoading: kpisLoading } = useEmailKpis(period);
  const { data: timeseries = [] } = useEmailSendsTimeseries(30);
  const { data: logData, isLoading: logLoading } = useEmailSendsLog({
    source,
    status: statusFilter === 'all' ? undefined : statusFilter,
    search: search.trim() || undefined,
    period,
    page,
    pageSize: 25,
  });

  const rows = logData?.rows || [];
  const total = logData?.total || 0;
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const sendsToday = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return timeseries.find((d) => d.date === today)?.sent || 0;
  }, [timeseries]);

  const modalMetadata = useMemo(() => {
    if (!selectedSend) return null;
    return {
      send_id: selectedSend.id,
      campaign_id: selectedSend.campaign_id,
      campaign_name: selectedSend.campaign?.name,
      subject: selectedSend.campaign?.subject || '',
      from_name: selectedSend.campaign?.from_name,
      from_email: selectedSend.campaign?.from_email,
      to_email: selectedSend.email,
      status: selectedSend.status,
      html: selectedSend.html,
      sent_at: selectedSend.sent_at,
      delivered_at: selectedSend.delivered_at,
      opened_at: selectedSend.opened_at,
      clicked_at: selectedSend.clicked_at,
      bounced_at: selectedSend.bounced_at,
      bounce_reason: selectedSend.bounce_reason,
      open_count: selectedSend.open_count || 0,
      click_count: selectedSend.click_count || 0,
      clicked_url: selectedSend.clicked_url,
      error_message: selectedSend.error_message,
    };
  }, [selectedSend]);

  return (
    <AppLayout>
      <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
        {/* Header editorial */}
        <header className="flex items-start justify-between gap-4 pb-4 border-b border-border/60">
          <div>
            <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-medium">
              Marketing · Email
            </span>
            <h1 className="text-2xl font-semibold mt-1 leading-tight tracking-tight">
              Visão geral
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {sendsToday > 0
                ? `${sendsToday} ${sendsToday === 1 ? 'email enviado' : 'emails enviados'} hoje`
                : 'Performance e histórico de todos os envios'}
            </p>
          </div>

          <Tabs value={period} onValueChange={(v) => setPeriod(v as EmailKpiPeriod)}>
            <TabsList className="h-8">
              {PERIODS.map((p) => (
                <TabsTrigger key={p.value} value={p.value} className="text-xs h-6 px-3">
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Kpi label="Enviados" value={kpisLoading ? '...' : kpis?.sent ?? 0} icon={Send} accent="text-[#BAA05E]" />
          <Kpi label="Entregues" value={kpisLoading ? '...' : kpis?.delivered ?? 0} icon={Mail} accent="text-teal-600" />
          <Kpi
            label="Aberturas" value={kpisLoading ? '...' : kpis?.opened ?? 0}
            sub={`Taxa: ${fmtPct(kpis?.open_rate)}`} icon={Eye} accent="text-indigo-600"
          />
          <Kpi
            label="Cliques" value={kpisLoading ? '...' : kpis?.clicked ?? 0}
            sub={`Taxa: ${fmtPct(kpis?.click_rate)}`} icon={MousePointerClick} accent="text-purple-600"
          />
          <Kpi
            label="Bounces" value={kpisLoading ? '...' : kpis?.bounced ?? 0}
            sub={`${fmtPct(kpis?.bounce_rate)} do total`} icon={AlertTriangle} accent="text-red-600"
          />
          <Kpi label="Falhas" value={kpisLoading ? '...' : kpis?.failed ?? 0} icon={AlertTriangle} accent="text-orange-600" />
        </section>

        {/* Gráfico */}
        <Card className="border-border/60">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" /> Envios por dia · últimos 30
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Barra clara = enviados · cheia = abertos
                </p>
              </div>
            </div>
            <SparkBars data={timeseries} />
          </CardContent>
        </Card>

        {/* Filtros */}
        <section className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="text-base font-semibold flex items-center gap-2">
                Últimos envios
                <Badge variant="outline" className="text-[10px] font-normal">
                  {total.toLocaleString('pt-BR')}
                </Badge>
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">Click numa linha pra ver o email enviado</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  placeholder="Buscar por email…"
                  className="pl-8 h-8 w-56 text-xs"
                />
              </div>
              <Select value={source} onValueChange={(v) => { setSource(v as any); setPage(0); }}>
                <SelectTrigger className="h-8 w-36 text-xs">
                  <Filter className="h-3 w-3 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tudo</SelectItem>
                  <SelectItem value="campaign">Campanha</SelectItem>
                  <SelectItem value="automation">Automação</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos status</SelectItem>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tabela */}
          <Card className="border-border/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 border-b border-border/60">
                  <tr>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Lead</th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Email</th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Origem</th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Assunto</th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Status</th>
                    <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Quando</th>
                    <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-4 py-2.5">Engajamento</th>
                  </tr>
                </thead>
                <tbody>
                  {logLoading ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center">
                        <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-16 text-center text-muted-foreground">
                        <Mail className="h-8 w-8 mx-auto mb-2 opacity-40" />
                        <p className="text-sm">Nenhum envio no período selecionado</p>
                      </td>
                    </tr>
                  ) : rows.map((r) => {
                    const status = STATUS_LABEL[r.status] || { label: r.status, color: 'text-gray-600 bg-gray-100' };
                    const isAutomation = r.campaign?.source_type === 'automation';
                    return (
                      <tr
                        key={r.id}
                        className="border-b border-border/40 hover:bg-accent/30 cursor-pointer transition-colors"
                        onClick={() => setSelectedSend(r)}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-medium truncate block max-w-[180px]">
                            {r.lead?.name || '—'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[220px]">
                          {r.email}
                        </td>
                        <td className="px-4 py-2.5">
                          {isAutomation ? (
                            <Badge variant="outline" className="text-[10px] gap-1 border-purple-200 text-purple-700">
                              Automação
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] gap-1 border-[#BAA05E]/40 text-[#917D3D]">
                              Campanha
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs truncate max-w-[240px]">
                          {r.campaign?.subject || '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge className={cn('text-[10px] border-0', status.color)}>{status.label}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                          {r.sent_at ? format(new Date(r.sent_at), "dd/MM HH:mm", { locale: ptBR }) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                            {(r.open_count || 0) > 0 && (
                              <span className="flex items-center gap-0.5 text-indigo-600">
                                <Eye className="h-3 w-3" /> {r.open_count}
                              </span>
                            )}
                            {(r.click_count || 0) > 0 && (
                              <span className="flex items-center gap-0.5 text-purple-600">
                                <MousePointerClick className="h-3 w-3" /> {r.click_count}
                              </span>
                            )}
                            {r.lead?.id && (
                              <button
                                onClick={(e) => { e.stopPropagation(); navigate(`/comercial/leads/${r.lead!.id}`); }}
                                className="p-1 rounded hover:bg-muted"
                                title="Abrir lead"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Paginação */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/60 bg-muted/20">
                <span className="text-xs text-muted-foreground">
                  Página {page + 1} de {totalPages} · {total.toLocaleString('pt-BR')} envios
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </section>
      </div>

      <EmailTimelineModal
        open={!!selectedSend}
        onOpenChange={(open) => { if (!open) setSelectedSend(null); }}
        metadata={modalMetadata}
        onOpenCampaign={(campaignId) => {
          setSelectedSend(null);
          navigate(`/marketing/campanhas/${campaignId}`);
        }}
      />
    </AppLayout>
  );
}
