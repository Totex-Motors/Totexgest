import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Handshake,
  RefreshCw,
  AlertTriangle,
  Clock,
  FileSignature,
  FileText,
  Wallet,
  CheckCircle2,
  TrendingUp,
  DollarSign,
  Coins,
  Trophy,
  ChevronRight,
  Gift,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useIntermediationDashboard } from "@/hooks/useIntermediation";
import {
  CONTRACT_STATUS_META,
  DEADLINE_STATUS_META,
  PAYMENT_STATUS_META,
  SALE_CONTRACT_STATUS_META,
  type IntermediationDashboardAtencao,
  type IntermediationDashboardPeriod,
} from "@/types/intermediation";

// ─── Formatação pt-BR ────────────────────────────────────────────────────────

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** Valor `numeric` já em reais (ex.: 135000 → R$ 135.000,00). */
const formatReais = (v: number | null | undefined) => brl.format(Number(v) || 0);
/** Valor em cents (ex.: 20000 → R$ 200,00). */
const formatCents = (v: number | null | undefined) => brl.format((Number(v) || 0) / 100);

/** ends_at costuma vir como 'YYYY-MM-DD' — meio-dia evita virar o dia por fuso. */
function formatDia(value: string | null | undefined): string {
  if (!value) return "—";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

const PERIODS: { value: IntermediationDashboardPeriod; label: string }[] = [
  { value: "week", label: "Semana" },
  { value: "month", label: "Mês" },
  { value: "quarter", label: "Trimestre" },
  { value: "all", label: "Tudo" },
];

// ─── Página ──────────────────────────────────────────────────────────────────

export default function IntermediationDashboard() {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<IntermediationDashboardPeriod>("month");
  const { data, isLoading, isError, error, refetch, isRefetching } = useIntermediationDashboard(period);

  const goToLead = (ownerLeadId: string) => navigate(`/comercial/leads/${ownerLeadId}`);

  const kpis = data?.kpis;
  const atencao = data?.atencao;
  const ranking = data?.ranking ?? [];
  const premios = data?.premios;

  const atencaoVazia =
    !!atencao &&
    atencao.prazos.length === 0 &&
    atencao.contratos_pendentes.length === 0 &&
    atencao.termos_pendentes.length === 0 &&
    atencao.pagamentos_pendentes.length === 0 &&
    atencao.prontas_concluir.length === 0;

  const errMsg =
    (error as { message?: string } | undefined)?.message || "Não consegui carregar o painel.";
  const semAcesso = /sem acesso/i.test(errMsg);

  return (
    <AppLayout>
      <div className="space-y-5 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Handshake className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Intermediação — Painel de gestão</h1>
              <p className="text-xs text-muted-foreground">
                Captações, contratos, vendas e prêmios das promotoras — atualiza a cada 60s
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Tabs value={period} onValueChange={(v) => setPeriod(v as IntermediationDashboardPeriod)}>
              <TabsList>
                {PERIODS.map((p) => (
                  <TabsTrigger key={p.value} value={p.value} className="text-xs">
                    {p.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isRefetching}>
              <RefreshCw className={cn("h-4 w-4 mr-1.5", isRefetching && "animate-spin")} />
              Atualizar
            </Button>
          </div>
        </div>

        {/* Erro */}
        {isError ? (
          <Card className="border-red-200 dark:border-red-900">
            <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
              <AlertTriangle className="h-8 w-8 text-red-500" />
              <div>
                <p className="text-sm font-medium">
                  {semAcesso ? "Você não tem acesso a este painel." : "Não consegui carregar o painel."}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {semAcesso
                    ? "O painel de gestão é exclusivo para o time comercial e administradores."
                    : errMsg}
                </p>
              </div>
              {!semAcesso && (
                <Button variant="outline" size="sm" onClick={() => refetch()}>
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                  Tentar de novo
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiTile icon={<Handshake className="h-4 w-4" />} label="Ativas" value={kpis?.ativas} loading={isLoading} tone="emerald" />
              <KpiTile
                icon={<Clock className="h-4 w-4" />}
                label="Vencendo"
                value={kpis?.vencendo}
                loading={isLoading}
                tone={kpis && kpis.vencendo > 0 ? "red" : "muted"}
              />
              <KpiTile icon={<FileText className="h-4 w-4" />} label="Aguardando contrato" value={kpis?.aguardando_contrato} loading={isLoading} tone="sky" />
              <KpiTile icon={<FileSignature className="h-4 w-4" />} label="Aguardando termo" value={kpis?.aguardando_termo} loading={isLoading} tone="sky" />
              <KpiTile icon={<Wallet className="h-4 w-4" />} label="Aguardando pagamento" value={kpis?.aguardando_pagamento} loading={isLoading} tone="amber" />
              <KpiTile
                icon={<CheckCircle2 className="h-4 w-4" />}
                label="Prontas p/ concluir"
                value={kpis?.prontas_concluir}
                loading={isLoading}
                tone={kpis && kpis.prontas_concluir > 0 ? "emerald" : "muted"}
              />
              <KpiTile icon={<TrendingUp className="h-4 w-4" />} label="Vendidas no período" value={kpis?.vendidas_periodo} loading={isLoading} tone="violet" />
              <KpiTile icon={<DollarSign className="h-4 w-4" />} label="Valor vendido no período" value={kpis ? formatReais(kpis.valor_vendido_periodo) : undefined} loading={isLoading} tone="violet" />
              <KpiTile icon={<Coins className="h-4 w-4" />} label="Comissão apurada" value={kpis ? formatReais(kpis.comissao_apurada) : undefined} loading={isLoading} tone="blue" />
              <KpiTile icon={<Coins className="h-4 w-4" />} label="Comissão paga" value={kpis ? formatReais(kpis.comissao_paga) : undefined} loading={isLoading} tone="emerald" />
              <KpiTile icon={<Coins className="h-4 w-4" />} label="Comissão pendente" value={kpis ? formatReais(kpis.comissao_pendente) : undefined} loading={isLoading} tone={kpis && kpis.comissao_pendente > 0 ? "amber" : "muted"} />
            </div>

            {/* Precisa de atenção */}
            <div>
              <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" /> Precisa de atenção
              </h2>

              {isLoading ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Card key={i} className="border shadow-sm">
                      <CardHeader className="pb-2">
                        <Skeleton className="h-5 w-40" />
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {Array.from({ length: 3 }).map((__, j) => (
                          <Skeleton key={j} className="h-12" />
                        ))}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : atencaoVazia ? (
                <Card className="border shadow-sm">
                  <CardContent className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                    Nada pendente por aqui. Tudo em dia! 🎉
                  </CardContent>
                </Card>
              ) : (
                <AtencaoGrid atencao={atencao} onOpen={goToLead} />
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Ranking de promotoras */}
              <Card className="lg:col-span-7 border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-amber-500" /> Ranking de promotoras
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-10" />
                      ))}
                    </div>
                  ) : ranking.length > 0 ? (
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Promotora</TableHead>
                            <TableHead className="text-right">Captadas</TableHead>
                            <TableHead className="text-right">Vendidas</TableHead>
                            <TableHead className="text-right">Prêmios</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {ranking.map((r) => (
                            <TableRow key={r.member_id}>
                              <TableCell className="font-medium">{r.name}</TableCell>
                              <TableCell className="text-right tabular-nums">{r.captadas}</TableCell>
                              <TableCell className="text-right tabular-nums">{r.vendidas}</TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {formatCents(r.premios_cents)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <div className="py-8 text-center text-sm text-muted-foreground">
                      Sem atividade no período.
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Prêmios */}
              <Card className="lg:col-span-5 border shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Gift className="h-4 w-4 text-purple-500" /> Prêmios das promotoras
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-12" />
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      <PremioRow
                        label="Pendente"
                        value={formatCents(premios?.pendente_cents)}
                        badge={premios?.pendente_qtd ? `${premios.pendente_qtd} a aprovar` : undefined}
                        tone="amber"
                      />
                      <PremioRow label="Aprovado" value={formatCents(premios?.aprovado_cents)} tone="sky" />
                      <PremioRow label="Pago" value={formatCents(premios?.pago_cents)} tone="emerald" />
                      <p className="text-[11px] text-muted-foreground pt-1">
                        A aprovação e o pagamento dos prêmios ficam em Configurações → Prêmios da captação.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}

// ─── Precisa de atenção (grid de cartões) ────────────────────────────────────

function AtencaoGrid({
  atencao,
  onOpen,
}: {
  atencao: IntermediationDashboardAtencao | undefined;
  onOpen: (ownerLeadId: string) => void;
}) {
  if (!atencao) return null;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {atencao.prazos.length > 0 && (
        <AtencaoCard
          title="Prazos vencendo"
          count={atencao.prazos.length}
          icon={<Clock className="h-4 w-4 text-red-500" />}
        >
          {atencao.prazos.map((item) => {
            const meta = DEADLINE_STATUS_META[item.deadline_status];
            return (
              <AtencaoRow
                key={item.intermediation_id}
                code={item.code}
                leadName={item.lead_name}
                onClick={() => onOpen(item.owner_lead_id)}
                right={
                  <div className="flex items-center gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">{formatDia(item.ends_at)}</span>
                    <Badge variant="outline" className={cn("text-[10px]", meta.cls)}>
                      {meta.label}
                    </Badge>
                  </div>
                }
              />
            );
          })}
        </AtencaoCard>
      )}

      {atencao.contratos_pendentes.length > 0 && (
        <AtencaoCard
          title="Contratos pendentes"
          count={atencao.contratos_pendentes.length}
          icon={<FileText className="h-4 w-4 text-sky-500" />}
        >
          {atencao.contratos_pendentes.map((item) => {
            const meta = CONTRACT_STATUS_META[item.contract_status];
            return (
              <AtencaoRow
                key={item.intermediation_id}
                code={item.code}
                leadName={item.lead_name}
                onClick={() => onOpen(item.owner_lead_id)}
                right={
                  <Badge variant="outline" className={cn("text-[10px]", meta.cls)}>
                    {meta.label}
                  </Badge>
                }
              />
            );
          })}
        </AtencaoCard>
      )}

      {atencao.termos_pendentes.length > 0 && (
        <AtencaoCard
          title="Termos de venda pendentes"
          count={atencao.termos_pendentes.length}
          icon={<FileSignature className="h-4 w-4 text-sky-500" />}
        >
          {atencao.termos_pendentes.map((item) => {
            const meta = SALE_CONTRACT_STATUS_META[item.sale_contract_status];
            return (
              <AtencaoRow
                key={item.intermediation_id}
                code={item.code}
                leadName={item.lead_name}
                onClick={() => onOpen(item.owner_lead_id)}
                right={
                  <div className="flex items-center gap-2">
                    {item.sale_price != null && (
                      <span className="text-xs tabular-nums text-muted-foreground">{formatReais(item.sale_price)}</span>
                    )}
                    <Badge variant="outline" className={cn("text-[10px]", meta.cls)}>
                      {meta.label}
                    </Badge>
                  </div>
                }
              />
            );
          })}
        </AtencaoCard>
      )}

      {atencao.pagamentos_pendentes.length > 0 && (
        <AtencaoCard
          title="Pagamentos pendentes"
          count={atencao.pagamentos_pendentes.length}
          icon={<Wallet className="h-4 w-4 text-amber-500" />}
        >
          {atencao.pagamentos_pendentes.map((item) => {
            const meta = PAYMENT_STATUS_META[item.payment_status ?? "pending"];
            return (
              <AtencaoRow
                key={item.intermediation_id}
                code={item.code}
                leadName={item.lead_name}
                onClick={() => onOpen(item.owner_lead_id)}
                right={
                  <div className="flex items-center gap-2">
                    {item.sale_price != null && (
                      <span className="text-xs tabular-nums text-muted-foreground">{formatReais(item.sale_price)}</span>
                    )}
                    <Badge variant="outline" className={cn("text-[10px]", meta.cls)}>
                      {meta.label}
                    </Badge>
                  </div>
                }
              />
            );
          })}
        </AtencaoCard>
      )}

      {atencao.prontas_concluir.length > 0 && (
        <AtencaoCard
          title="Prontas para concluir"
          count={atencao.prontas_concluir.length}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-500" />}
        >
          {atencao.prontas_concluir.map((item) => (
            <AtencaoRow
              key={item.intermediation_id}
              code={item.code}
              leadName={item.lead_name}
              onClick={() => onOpen(item.owner_lead_id)}
              right={
                item.sale_price != null ? (
                  <span className="text-xs tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                    {formatReais(item.sale_price)}
                  </span>
                ) : undefined
              }
            />
          ))}
        </AtencaoCard>
      )}
    </div>
  );
}

function AtencaoCard({
  title,
  count,
  icon,
  children,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {icon}
          {title}
          <Badge variant="secondary" className="ml-auto tabular-nums">{count}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[320px] pr-3">
          <div className="space-y-1">{children}</div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function AtencaoRow({
  code,
  leadName,
  right,
  onClick,
}: {
  code: string;
  leadName: string | null;
  right?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/60 transition-colors border border-transparent hover:border-border"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-muted-foreground shrink-0">{code}</span>
          <span className="text-sm font-medium truncate">{leadName || "Sem nome"}</span>
        </div>
      </div>
      {right}
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}

// ─── KPI tile ────────────────────────────────────────────────────────────────

function KpiTile({
  icon,
  label,
  value,
  loading,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string | number;
  loading?: boolean;
  tone: "blue" | "violet" | "red" | "emerald" | "amber" | "sky" | "muted";
}) {
  const tones: Record<string, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    violet: "text-violet-600 dark:text-violet-400",
    red: "text-red-600 dark:text-red-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    sky: "text-sky-600 dark:text-sky-400",
    muted: "text-muted-foreground",
  };
  return (
    <Card className="border shadow-sm">
      <CardContent className="p-3">
        <div className={cn("flex items-center gap-1.5 mb-1", tones[tone])}>
          {icon}
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className={cn("text-xl font-bold tabular-nums", tones[tone])}>{value ?? "—"}</div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Linha de prêmio ─────────────────────────────────────────────────────────

function PremioRow({
  label,
  value,
  badge,
  tone,
}: {
  label: string;
  value: string;
  badge?: string;
  tone: "amber" | "sky" | "emerald";
}) {
  const tones: Record<string, string> = {
    amber: "text-amber-600 dark:text-amber-400",
    sky: "text-sky-600 dark:text-sky-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
  };
  return (
    <div className="flex items-center justify-between rounded-lg px-3 py-2 bg-muted/40">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {badge && (
          <Badge variant="secondary" className="text-[10px]">
            {badge}
          </Badge>
        )}
      </div>
      <span className={cn("text-sm font-bold tabular-nums", tones[tone])}>{value}</span>
    </div>
  );
}
