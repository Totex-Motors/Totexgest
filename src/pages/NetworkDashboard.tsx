import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
  Network,
  RefreshCw,
  AlertTriangle,
  ShieldAlert,
  Building2,
  Handshake,
  Clock,
  TrendingUp,
  DollarSign,
  Coins,
  Users,
  ShieldCheck,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNetworkDashboard } from "@/hooks/useIntermediation";
import type { IntermediationDashboardPeriod } from "@/types/intermediation";

// ─── Formatação pt-BR ────────────────────────────────────────────────────────

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
/** Valor `numeric` já em reais (ex.: 135000 → R$ 135.000,00). */
const formatReais = (v: number | null | undefined) => brl.format(Number(v) || 0);

const PERIODS: { value: IntermediationDashboardPeriod; label: string }[] = [
  { value: "week", label: "Semana" },
  { value: "month", label: "Mês" },
  { value: "quarter", label: "Trimestre" },
  { value: "all", label: "Tudo" },
];

// ─── Página ──────────────────────────────────────────────────────────────────

export default function NetworkDashboard() {
  const [period, setPeriod] = useState<IntermediationDashboardPeriod>("month");
  const { data, isLoading, isError, error, refetch, isRefetching } = useNetworkDashboard(period);

  const total = data?.total;
  const franquias = data?.franquias ?? [];

  const errMsg =
    (error as { message?: string } | undefined)?.message || "Não consegui carregar a visão da rede.";
  // O RPC recusa quem não é superadmin com "Só superadmin vê a rede".
  const semAcesso = /superadmin|só superadmin/i.test(errMsg);

  return (
    <AppLayout>
      <div className="space-y-5 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
              <Network className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Rede de franquias — Intermediação</h1>
              <p className="text-xs text-muted-foreground">
                Visão do superadmin: intermediação agregada por franquia — atualiza a cada 60s
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!semAcesso && (
              <Badge variant="outline" className="gap-1.5 text-xs">
                <FileText className="h-3.5 w-3.5" />
                {isLoading ? "…" : data?.templates_globais ?? 0} templates globais
              </Badge>
            )}
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
          <Card className={cn(semAcesso ? "border-amber-200 dark:border-amber-900" : "border-red-200 dark:border-red-900")}>
            <CardContent className="py-10 flex flex-col items-center gap-3 text-center">
              {semAcesso ? (
                <ShieldAlert className="h-8 w-8 text-amber-500" />
              ) : (
                <AlertTriangle className="h-8 w-8 text-red-500" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {semAcesso ? "Acesso restrito" : "Não consegui carregar a visão da rede."}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {semAcesso
                    ? "A visão de rede é exclusiva do superadmin da Totex central."
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
            {/* KPIs da rede */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiTile icon={<Building2 className="h-4 w-4" />} label="Franquias ativas" value={total?.franquias} loading={isLoading} tone="indigo" />
              <KpiTile icon={<Handshake className="h-4 w-4" />} label="Intermediações ativas" value={total?.ativas} loading={isLoading} tone="emerald" />
              <KpiTile
                icon={<Clock className="h-4 w-4" />}
                label="Vencendo"
                value={total?.vencendo}
                loading={isLoading}
                tone={total && total.vencendo > 0 ? "amber" : "muted"}
              />
              <KpiTile icon={<TrendingUp className="h-4 w-4" />} label="Vendidas no período" value={total?.vendidas_periodo} loading={isLoading} tone="violet" />
              <KpiTile icon={<DollarSign className="h-4 w-4" />} label="Valor vendido no período" value={total ? formatReais(total.valor_vendido_periodo) : undefined} loading={isLoading} tone="violet" />
              <KpiTile icon={<Coins className="h-4 w-4" />} label="Comissão apurada" value={total ? formatReais(total.comissao_apurada) : undefined} loading={isLoading} tone="blue" />
              <KpiTile icon={<Coins className="h-4 w-4" />} label="Comissão paga" value={total ? formatReais(total.comissao_paga) : undefined} loading={isLoading} tone="emerald" />
              <KpiTile icon={<Users className="h-4 w-4" />} label="Promotoras" value={total?.promotoras} loading={isLoading} tone="sky" />
              <KpiTile
                icon={<ShieldCheck className="h-4 w-4" />}
                label="Aprovações pendentes"
                value={total?.aprovacoes_pendentes}
                loading={isLoading}
                tone={total && total.aprovacoes_pendentes > 0 ? "amber" : "muted"}
              />
            </div>

            {/* Tabela de franquias */}
            <Card className="border shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-indigo-500" /> Franquias
                </CardTitle>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="space-y-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-10" />
                    ))}
                  </div>
                ) : franquias.length > 0 ? (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Franquia</TableHead>
                          <TableHead className="text-right">Ativas</TableHead>
                          <TableHead className="text-right">Vencendo</TableHead>
                          <TableHead className="text-right">Captadas</TableHead>
                          <TableHead className="text-right">Vendidas</TableHead>
                          <TableHead className="text-right">Valor vendido</TableHead>
                          <TableHead className="text-right">Comissão apurada</TableHead>
                          <TableHead className="text-right">Promotoras</TableHead>
                          <TableHead className="text-right">Aprovações</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {franquias.map((f) => (
                          <TableRow key={f.tenant_id}>
                            <TableCell className="font-medium">
                              <div className="flex flex-col">
                                <span className="truncate">{f.tenant_name || "Sem nome"}</span>
                                {f.slug && (
                                  <span className="text-[11px] font-mono text-muted-foreground">{f.slug}</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{f.ativas}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {f.vencendo > 0 ? (
                                <span className="font-medium text-amber-600 dark:text-amber-400">{f.vencendo}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{f.captadas_periodo}</TableCell>
                            <TableCell className="text-right tabular-nums">{f.vendidas_periodo}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatReais(f.valor_vendido_periodo)}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatReais(f.comissao_apurada)}</TableCell>
                            <TableCell className="text-right tabular-nums">{f.promotoras}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {f.aprovacoes_pendentes > 0 ? (
                                <span className="font-medium text-amber-600 dark:text-amber-400">{f.aprovacoes_pendentes}</span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : (
                  <div className="py-10 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <Building2 className="h-8 w-8 text-muted-foreground/60" />
                    Nenhuma franquia com atividade.
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
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
  tone: "blue" | "violet" | "indigo" | "emerald" | "amber" | "sky" | "muted";
}) {
  const tones: Record<string, string> = {
    blue: "text-blue-600 dark:text-blue-400",
    violet: "text-violet-600 dark:text-violet-400",
    indigo: "text-indigo-600 dark:text-indigo-400",
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
