import { useMemo } from "react";
import { Link } from "react-router-dom";
import { motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle, MessageSquareQuote, GraduationCap, ChevronRight, Bell, CheckCheck, Car, ShieldQuestion, ArrowRight, Sparkles,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/contexts/AuthContext";
import { useCaptureHomeStats } from "@/hooks/useCaptureLeads";
import { useCaptureEvents, useMarkCaptureEventsRead, type CaptureEventType } from "@/hooks/useCaptureHandoff";
import { useActiveCaptureCampaign, useMyCaptureVehicles } from "@/hooks/useCaptureRewards";
import { GoalRing } from "@/components/capture/GoalRing";
import { WalletCard } from "@/components/capture/WalletCard";
import { VEHICLE_STATUS_META, vehicleTitle, type MyCaptureVehicle } from "@/types/capture";
import { SCRIPT_CARDS, MICRO_LESSONS } from "./captureContent";
import { cn } from "@/lib/utils";

/**
 * Tela "Hoje" — tela de AÇÃO, não dashboard. Em 5 segundos a promotora sabe:
 * quanto falta pra meta (leads válidos, do servidor), quanto já ganhou, o que
 * fazer agora (próximo passo) e a frase pra usar no corredor.
 *
 * Dinheiro e meta vêm SÓ de capture_home_stats — nada é calculado aqui.
 */

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function firstName(name?: string | null) {
  return (name ?? "").trim().split(/\s+/)[0] || "";
}

const EVENT_ICON: Record<CaptureEventType | "sold" | "reward", string> = {
  handoff: "🤝", contacted: "📞", stage: "➡️", won: "🏆", sold: "🎉", lost: "❌", reassigned: "🔁", sla: "⏰", info: "ℹ️", reward: "🎁",
};

function relTime(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** invalidos_motivos (motivo → qtd) vira frase concreta de próximo passo. */
function invalidReasonPhrase(reason: string, n: number): string {
  const pl = n > 1;
  const lead = pl ? `${n} leads precisam` : `1 lead precisa`;
  const r = reason.toLowerCase();
  if (r.startsWith("invalidado")) return `${pl ? `${n} leads foram invalidados` : "1 lead foi invalidado"} pelo gestor (${reason.replace(/^invalidado:\s*/i, "")})`;
  if (r.includes("autoriza")) return `${lead} de autorização de contato pra contar na meta`;
  if (r.includes("ano")) return `${lead} do ano do veículo`;
  if (r.includes("veículo") || r.includes("veiculo")) return `${lead} do modelo do carro`;
  if (r.includes("telefone")) return `${lead} de um WhatsApp válido`;
  if (r.includes("nome")) return `${lead} do nome completo`;
  if (r.includes("inten")) return `${lead} da intenção (vender, trocar ou entender)`;
  return `${lead} de: ${reason}`;
}

export default function CaptureHome() {
  const { teamMember } = useAuth();
  const stats = useCaptureHomeStats();
  const events = useCaptureEvents({ unreadOnly: true, limit: 10 });
  const markRead = useMarkCaptureEventsRead();
  const vehicles = useMyCaptureVehicles();
  const campaign = useActiveCaptureCampaign();

  const s = stats.data;
  const dayIndex = Math.floor(Date.now() / 86_400_000);
  const staticScript = SCRIPT_CARDS.filter((c) => c.tag === "Abordagem")[dayIndex % 2];
  const staticObjection = SCRIPT_CARDS.filter((c) => c.tag === "Objeção")[dayIndex % 3];
  const lesson = MICRO_LESSONS[dayIndex % MICRO_LESSONS.length];

  const focusPhrase = campaign.data?.focus_phrase?.trim() || staticScript.text;
  const objection = campaign.data?.objection_phrase?.trim()
    ? { q: campaign.data.objection_phrase!.trim(), a: campaign.data.objection_answer?.trim() || "" }
    : { q: staticObjection.title.replace(/[“”"]/g, ""), a: staticObjection.text };

  const nextSteps = useMemo(() => {
    const out: { key: string; text: string; to: string; urgent: boolean }[] = [];
    const motivos = s?.invalidos_motivos ?? {};
    Object.entries(motivos)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => {
        if (n > 0) out.push({ key: `inv:${reason}`, text: invalidReasonPhrase(reason, n), to: "/captacao/leads", urgent: /autoriza/i.test(reason) });
      });
    if ((s?.handoff_pendente ?? 0) > 0) {
      const n = s!.handoff_pendente!;
      out.push({ key: "handoff", text: `${n} lead${n > 1 ? "s" : ""} aguardando o 1º contato do especialista`, to: "/captacao/leads", urgent: true });
    }
    return out;
  }, [s]);

  const myVehicles = (vehicles.data ?? []).filter((v) => v.status !== "lead" && v.status !== "perdido").slice(0, 8);

  return (
    <div className="space-y-4">
      {/* Topo: saudação + frase do dia */}
      <div>
        <h1 className="text-xl font-bold tracking-tight">
          {greeting()}, {firstName(teamMember?.name) || "promotora"} 👋
        </h1>
        <p className="text-sm text-muted-foreground">
          {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })}
          {campaign.data?.name ? ` · ${campaign.data.name}` : ""}
        </p>
      </div>

      <Card className="bg-zinc-950 text-white border-zinc-800 dark:bg-zinc-900">
        <CardContent className="pt-3.5 pb-3.5">
          <div className="flex items-center gap-2 text-[11px] font-medium text-emerald-400 uppercase tracking-wide mb-1">
            <MessageSquareQuote className="h-3.5 w-3.5" /> Frase do dia
          </div>
          <p className="text-sm leading-relaxed">“{focusPhrase}”</p>
        </CardContent>
      </Card>

      {/* Metas — dois anéis no mesmo card: HOJE (meta diária) e SEMANA (meta do voucher) */}
      <Card className="border-emerald-200/70 dark:border-emerald-900/50">
        <CardContent className="pt-4 pb-4">
          <div className="grid grid-cols-2 divide-x divide-border/60">
            <div className="flex flex-col items-center px-1">
              <span className="text-xs font-semibold mb-2">Meta de hoje</span>
              <GoalRing current={s?.validos_hoje ?? 0} goal={s?.meta_diaria ?? 8} label="hoje" variant="day" loading={stats.isLoading} />
              <p className="mt-2 text-[11px] text-center text-muted-foreground">
                {stats.isLoading ? "…" : (s?.validos_hoje ?? 0) >= (s?.meta_diaria ?? 8)
                  ? "Meta do dia batida 👏"
                  : <>faltam <strong className="text-foreground tabular-nums">{Math.max(0, (s?.meta_diaria ?? 8) - (s?.validos_hoje ?? 0))}</strong> hoje</>}
              </p>
            </div>
            <div className="flex flex-col items-center px-1">
              <span className="text-xs font-semibold mb-2">Meta da semana</span>
              <GoalRing current={s?.validos_semana ?? 0} goal={s?.meta_semanal ?? 40} label="semana" variant="week" loading={stats.isLoading} />
              <p className="mt-2 text-[11px] text-center text-muted-foreground">
                {stats.isLoading ? "…" : (s?.validos_semana ?? 0) >= (s?.meta_semanal ?? 40)
                  ? <>🎁 {s?.meta_label ?? "Voucher"} liberado</>
                  : <>faltam <strong className="text-foreground tabular-nums">{Math.max(0, (s?.meta_semanal ?? 40) - (s?.validos_semana ?? 0))}</strong>{s?.meta_label ? <> pro <strong className="text-foreground">{s.meta_label}</strong></> : ""}</>}
              </p>
            </div>
          </div>
          {!stats.isLoading && (s?.invalidos_semana ?? 0) > 0 && (
            <Link to="/captacao/leads" className="mt-3 block text-center text-[11px] text-amber-700 dark:text-amber-400">
              {s!.invalidos_semana} lead{s!.invalidos_semana! > 1 ? "s" : ""} da semana ainda não conta{s!.invalidos_semana! > 1 ? "m" : ""} — ver o que falta
            </Link>
          )}
        </CardContent>
      </Card>

      {/* (sem CTA retangular: o botão central "Captar" do bottom-nav já é a ação principal) */}

      {/* Carteira — só dados do servidor */}
      <WalletCard
        earnedCents={s?.wallet?.earned_cents ?? 0}
        pendingCents={s?.wallet?.pending_cents ?? 0}
        vouchersPending={s?.wallet?.vouchers_pending ?? 0}
        loading={stats.isLoading}
      />

      {/* Meus carros — carrossel */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold flex items-center gap-1.5"><Car className="h-4 w-4" /> Meus carros</h2>
          <Link to="/captacao/carros" className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-0.5">
            {s?.captados_mes != null ? `${s.captados_mes} no mês` : "Ver todos"} <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {vehicles.isLoading ? (
          <div className="flex gap-2 overflow-hidden">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-40 shrink-0 rounded-xl" />)}</div>
        ) : myVehicles.length === 0 ? (
          <Link to="/captacao/carros" className="block rounded-xl border border-dashed border-border/80 px-3 py-3 text-xs text-muted-foreground">
            Quando um lead seu virar carro no estoque, ele aparece aqui — com o seu prêmio. 🚗
          </Link>
        ) : (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 snap-x">
            {myVehicles.map((v, i) => <MiniVehicle key={v.vehicle_id} v={v} index={i} />)}
          </div>
        )}
      </div>

      {/* Próximo passo */}
      {(nextSteps.length > 0 || (events.data?.length ?? 0) > 0) && (
        <Card className="border-primary/30">
          <CardContent className="pt-4 pb-3 space-y-3">
            {nextSteps.length > 0 && (
              <div>
                <p className="text-sm font-semibold flex items-center gap-1.5 mb-2"><ArrowRight className="h-4 w-4 text-emerald-600" /> Próximo passo</p>
                <ul className="space-y-2">
                  {nextSteps.map((p) => (
                    <li key={p.key}>
                      <Link to={p.to} className="flex items-center gap-2 text-sm">
                        <AlertCircle className={cn("h-4 w-4 shrink-0", p.urgent ? "text-amber-500" : "text-muted-foreground")} />
                        <span className="flex-1">{p.text}</span>
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(events.data?.length ?? 0) > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold flex items-center gap-1.5"><Bell className="h-4 w-4 text-primary" /> Retornos dos seus leads</span>
                  <button type="button" className="text-xs text-muted-foreground flex items-center gap-1" onClick={() => markRead.mutate(undefined)} disabled={markRead.isPending}>
                    <CheckCheck className="h-3.5 w-3.5" /> Lidos
                  </button>
                </div>
                <ul className="space-y-2">
                  {events.data!.map((e) => (
                    <li key={e.id}>
                      <Link to={e.event_type === "sold" || e.event_type === "won" ? "/captacao/carros" : `/captacao/leads?lead=${e.lead_id}`} className="flex items-start gap-2 text-sm">
                        <span className="shrink-0">{EVENT_ICON[e.event_type as keyof typeof EVENT_ICON] ?? "•"}</span>
                        <span className="flex-1 min-w-0">
                          <span className="font-medium block truncate">{e.title}</span>
                          {e.body && <span className="text-xs text-muted-foreground block">{e.body}</span>}
                        </span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{relTime(e.created_at)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Objeção do dia — 20–40s */}
      <Card className="bg-muted/40">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
            <ShieldQuestion className="h-3.5 w-3.5" /> Objeção do dia
          </div>
          <p className="text-sm font-semibold">“{objection.q}”</p>
          {objection.a && <p className="text-sm leading-relaxed mt-1.5 text-muted-foreground"><span className="text-foreground font-medium">Responda:</span> {objection.a}</p>}
        </CardContent>
      </Card>

      {/* Microtreino */}
      <Link to="/captacao/premios?tab=treino" className="block">
        <Card className="hover:bg-muted/40 transition-colors">
          <CardContent className="pt-4 pb-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center shrink-0">
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

    </div>
  );
}

function MiniVehicle({ v, index }: { v: MyCaptureVehicle; index: number }) {
  const reduce = useReducedMotion();
  const meta = VEHICLE_STATUS_META[v.status] ?? VEHICLE_STATUS_META.lead;
  const sold = v.status === "vendido";
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className="snap-start shrink-0"
    >
      <Link
        to="/captacao/carros"
        className={cn(
          "block w-40 rounded-xl border px-3 py-2.5 bg-card active:bg-muted/60",
          sold ? "border-emerald-500/70" : "border-border/60",
        )}
      >
        <p className="text-sm font-semibold truncate">{vehicleTitle(v)}</p>
        <p className="text-[11px] text-muted-foreground truncate">{v.lead_name}</p>
        <span className={cn("mt-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", meta.cls)}>
          {sold && <Sparkles className="h-3 w-3" />}{meta.label}
        </span>
      </Link>
    </motion.div>
  );
}
