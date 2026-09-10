import { Link } from "react-router-dom";
import { Plus, Flame, Users, ClipboardCheck, Handshake, AlertCircle, MessageSquareQuote, GraduationCap, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useCaptureHomeStats, useCaptureLeads } from "@/hooks/useCaptureLeads";
import { useCaptureEvents, useMarkCaptureEventsRead, type CaptureEventType } from "@/hooks/useCaptureHandoff";
import { useCaptureRewardProgress } from "@/hooks/useCaptureRewards";
import { RewardCard } from "@/components/capture/RewardCard";
import { Bell, CheckCheck } from "lucide-react";
import { TEMP_META } from "@/types/capture";
import { SCRIPT_CARDS, MICRO_LESSONS } from "./captureContent";
import { cn } from "@/lib/utils";

/**
 * Tela "Hoje" — cockpit da promotora. Em 5 segundos ela precisa saber:
 * meta, quanto já fez, qual frase usar, quem precisa de retorno e onde
 * registrar o próximo cliente.
 *
 * Meta diária: placeholder (8 leads/dia) até performance_goals existir (Fase 5).
 */
const META_DIARIA_PLACEHOLDER = 8;

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function firstName(name?: string | null) {
  return (name ?? "").trim().split(/\s+/)[0] || "";
}

const EVENT_ICON: Record<CaptureEventType, string> = {
  handoff: "🤝", contacted: "📞", stage: "➡️", won: "🏆", lost: "❌", reassigned: "🔁", sla: "⏰", info: "ℹ️",
};

function relTime(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

export default function CaptureHome() {
  const { teamMember } = useAuth();
  const stats = useCaptureHomeStats();
  const recent = useCaptureLeads();
  const events = useCaptureEvents({ unreadOnly: true, limit: 10 });
  const markRead = useMarkCaptureEventsRead();
  const rewards = useCaptureRewardProgress();
  // Prêmio em destaque na "Hoje": o mais próximo de ser batido (ou já batido)
  const featuredReward = [...(rewards.data ?? [])].sort((a, b) =>
    (b.current_value / b.goal_value) - (a.current_value / a.goal_value))[0];

  const hoje = stats.data?.hoje ?? 0;
  const pct = Math.min(100, Math.round((hoje / META_DIARIA_PLACEHOLDER) * 100));
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const script = SCRIPT_CARDS[dayIndex % SCRIPT_CARDS.length];
  const lesson = MICRO_LESSONS[dayIndex % MICRO_LESSONS.length];
  const pendencias = [
    { n: stats.data?.handoff_pendente ?? 0, label: "lead aguardando o 1º contato do especialista", urgent: true },
    { n: stats.data?.pendentes_complemento ?? 0, label: "lead aguardando complemento (km / autorização)", urgent: false },
  ].filter((p) => p.n > 0);

  return (
    <div className="space-y-4">
      {/* Topo */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">
          {greeting()}, {firstName(teamMember?.name) || "promotora"} 👋
        </h1>
        <p className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
        </p>
      </div>

      {/* Meta de hoje */}
      <Card className="border-emerald-200/70 dark:border-emerald-900/50">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-sm font-medium">Meta de hoje</span>
            {stats.isLoading ? (
              <Skeleton className="h-5 w-14" />
            ) : (
              <span className="text-sm font-semibold tabular-nums">
                {hoje}/{META_DIARIA_PLACEHOLDER} leads
              </span>
            )}
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {pct >= 100 ? "Meta batida! Continue — cada lead a mais conta pro ranking." : `Faltam ${Math.max(0, META_DIARIA_PLACEHOLDER - hoje)} pra bater a meta.`}
          </p>
          {featuredReward && (
            <div className="mt-3">
              <RewardCard reward={featuredReward} compact />
            </div>
          )}
        </CardContent>
      </Card>

      {/* CTA principal */}
      <Button asChild size="lg" className="w-full h-14 text-base font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md">
        <Link to="/captacao/novo"><Plus className="h-5 w-5 mr-2" /> CAPTAR CLIENTE</Link>
      </Button>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3">
        <Kpi icon={Users} label="Captados (semana)" value={stats.data?.semana} loading={stats.isLoading} />
        <Kpi icon={ClipboardCheck} label="Contatados (semana)" value={stats.data?.contatados_semana} loading={stats.isLoading} />
        <Kpi icon={Flame} label="Quentes (semana)" value={stats.data?.quentes_semana} loading={stats.isLoading} accent="text-orange-600" />
        <Kpi icon={Handshake} label="Carros captados (mês)" value={stats.data?.captados_mes} loading={stats.isLoading} accent="text-emerald-700" />
      </div>

      {/* Retornos — o que aconteceu com os leads dela */}
      {(events.data?.length ?? 0) > 0 && (
        <Card className="border-primary/30">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold flex items-center gap-1.5"><Bell className="h-4 w-4 text-primary" /> Retornos dos seus leads</span>
              <button type="button" className="text-xs text-muted-foreground flex items-center gap-1" onClick={() => markRead.mutate(undefined)} disabled={markRead.isPending}>
                <CheckCheck className="h-3.5 w-3.5" /> Lidos
              </button>
            </div>
            <ul className="space-y-2">
              {events.data!.map((e) => (
                <li key={e.id}>
                  <Link to={`/captacao/leads?lead=${e.lead_id}`} className="flex items-start gap-2 text-sm">
                    <span className="shrink-0">{EVENT_ICON[e.event_type] ?? "•"}</span>
                    <span className="flex-1 min-w-0">
                      <span className="font-medium block truncate">{e.title}</span>
                      {e.body && <span className="text-xs text-muted-foreground block">{e.body}</span>}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{relTime(e.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Fila de ação */}
      {pendencias.length > 0 && (
        <Card>
          <CardContent className="pt-4 pb-3 space-y-2">
            {pendencias.map((p) => (
              <Link key={p.label} to="/captacao/leads" className="flex items-center gap-2 text-sm">
                <AlertCircle className={cn("h-4 w-4 shrink-0", p.urgent ? "text-red-500" : "text-amber-500")} />
                <span className="flex-1">
                  <strong>{p.n}</strong> {p.label}{p.n > 1 ? "s" : ""}
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Script do dia */}
      <Card className="bg-muted/40">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            <MessageSquareQuote className="h-3.5 w-3.5" /> Frase do dia · {script.tag}
          </div>
          <p className="text-sm leading-relaxed">“{script.text}”</p>
        </CardContent>
      </Card>

      {/* Microtreino */}
      <Link to="/captacao/treino" className="block">
        <Card className="hover:bg-muted/40 transition-colors">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <GraduationCap className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Microtreino · {lesson.minutes} min</p>
              <p className="text-sm font-medium truncate">{lesson.title}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </CardContent>
        </Card>
      </Link>

      {/* Últimos captados */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">Últimos captados</h2>
          <Link to="/captacao/leads" className="text-xs text-primary">Ver todos</Link>
        </div>
        {recent.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (recent.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">Nenhum cliente captado ainda. Bora pro primeiro? 🚗</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card">
            {recent.data!.slice(0, 5).map((l) => {
              const t = TEMP_META[l.temperatura] ?? TEMP_META.frio;
              return (
                <li key={l.id}>
                  <Link to={`/captacao/leads?lead=${l.id}`} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{l.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {l.vehicle?.description || [l.vehicle?.brand, l.vehicle?.model].filter(Boolean).join(" ") || "Veículo não informado"}
                        {l.vehicle?.year_model ? ` · ${l.vehicle.year_model}` : ""}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("border text-[10px]", t.cls)}>{t.label}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Kpi({
  icon: Icon, label, value, loading, accent,
}: { icon: typeof Users; label: string; value?: number; loading: boolean; accent?: string }) {
  return (
    <Card>
      <CardContent className="pt-3 pb-3">
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
          <Icon className={cn("h-3.5 w-3.5", accent)} /> {label}
        </div>
        {loading ? <Skeleton className="h-7 w-10" /> : <p className={cn("text-2xl font-bold tabular-nums", accent)}>{value ?? 0}</p>}
      </CardContent>
    </Card>
  );
}
