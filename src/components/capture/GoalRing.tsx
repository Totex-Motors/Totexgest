import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Anel da meta semanal: leads VÁLIDOS / meta (do servidor). Animado com
 * framer-motion; celebra UMA vez por semana ao bater 100% (localStorage
 * `captacao:celebrated:<period>`), e dá um brilho curto nos marcos 10/20/30.
 * Nunca bloqueia navegação — tudo é decorativo e respeita reduced-motion.
 */

const MILESTONES = [10, 20, 30];
const SIZE = 196;
const STROKE = 14;
const R = (SIZE - STROKE) / 2;

/** Segunda-feira da semana atual (mesma janela do servidor, que usa date_trunc('week')). */
export function currentWeekPeriod(now = new Date()) {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // seg=0
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

function celebratedKey(period: string) {
  return `captacao:celebrated:${period}`;
}

const CONFETTI = Array.from({ length: 18 }, (_, i) => ({
  id: i,
  x: (Math.sin(i * 12.9898) * 43758.5453) % 1, // pseudo-random estável
  delay: (i % 6) * 0.06,
  size: 5 + (i % 3) * 2,
  rot: (i * 47) % 360,
}));

function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {CONFETTI.map((c) => {
        const dx = (Math.abs(c.x) * 2 - 1) * 120;
        return (
          <motion.span
            key={c.id}
            className={cn("absolute left-1/2 top-1/2 rounded-[2px]", c.id % 2 ? "bg-emerald-500" : "bg-emerald-300")}
            style={{ width: c.size, height: c.size * 1.6 }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
            animate={{ x: dx, y: [0, -70 - (c.id % 4) * 15, 90], opacity: [1, 1, 0], rotate: c.rot + 180, scale: 1 }}
            transition={{ duration: 1.2 + (c.id % 4) * 0.15, delay: c.delay, ease: "easeOut" }}
          />
        );
      })}
    </div>
  );
}

export function GoalRing({
  current,
  goal,
  metaLabel,
  loading,
}: {
  current: number;
  goal: number;
  metaLabel?: string | null;
  loading?: boolean;
}) {
  const reduce = useReducedMotion();
  const safeGoal = Math.max(1, goal || 1);
  const pct = Math.min(1, current / safeGoal);
  const remaining = Math.max(0, safeGoal - current);
  const done = !loading && current >= safeGoal;
  const period = useMemo(() => currentWeekPeriod(), []);

  // ── Celebração: uma vez por semana ──
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!done) return;
    let already = false;
    try { already = localStorage.getItem(celebratedKey(period)) === "1"; } catch { /* ignore */ }
    if (already) return;
    try { localStorage.setItem(celebratedKey(period), "1"); } catch { /* ignore */ }
    if (reduce) return;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 1800);
    return () => clearTimeout(t);
  }, [done, period, reduce]);

  // ── Marco (10/20/30): glow curto quando cruza ──
  const prev = useRef<number | null>(null);
  const [glow, setGlow] = useState<number | null>(null);
  useEffect(() => {
    if (loading) return;
    const p = prev.current;
    prev.current = current;
    if (p == null) return; // primeira carga: sem glow
    const crossed = MILESTONES.filter((m) => p < m && current >= m).pop();
    if (crossed == null || reduce) return;
    setGlow(crossed);
    const t = setTimeout(() => setGlow(null), 1400);
    return () => clearTimeout(t);
  }, [current, loading, reduce]);

  const reached = MILESTONES.filter((m) => m <= current && m < safeGoal);
  const circumference = 2 * Math.PI * R;

  return (
    <div className="relative flex flex-col items-center">
      <AnimatePresence>{celebrate && <Confetti key="confetti" />}</AnimatePresence>

      <motion.div
        className="relative"
        style={{ width: SIZE, height: SIZE }}
        animate={glow != null && !reduce ? { scale: [1, 1.04, 1] } : { scale: 1 }}
        transition={{ duration: 0.5 }}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="stroke-muted" strokeWidth={STROKE} fill="none" />
          <motion.circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            className={cn(done ? "stroke-emerald-500" : "stroke-emerald-600")}
            strokeDasharray={circumference}
            initial={reduce ? false : { strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: loading ? circumference : circumference * (1 - pct) }}
            transition={{ duration: reduce ? 0 : 0.9, ease: "easeOut" }}
            style={glow != null ? { filter: "drop-shadow(0 0 8px rgb(16 185 129 / 0.8))" } : undefined}
          />
          {/* marcos */}
          {MILESTONES.filter((m) => m < safeGoal).map((m) => {
            const a = (m / safeGoal) * 2 * Math.PI;
            const cx = SIZE / 2 + R * Math.cos(a);
            const cy = SIZE / 2 + R * Math.sin(a);
            const hit = current >= m;
            return (
              <circle
                key={m}
                cx={cx}
                cy={cy}
                r={hit ? 3.5 : 2.5}
                className={cn(hit ? "fill-white" : "fill-muted-foreground/40")}
              />
            );
          })}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {loading ? (
            <Skeleton className="h-10 w-20" />
          ) : (
            <motion.p
              key={current}
              initial={reduce ? false : { scale: 0.9, opacity: 0.6 }}
              animate={{ scale: 1, opacity: 1 }}
              className="text-4xl font-bold tabular-nums tracking-tight leading-none"
            >
              {current}
              <span className="text-xl text-muted-foreground font-semibold">/{safeGoal}</span>
            </motion.p>
          )}
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground mt-1.5">leads válidos</p>
          {done && (
            <motion.span
              initial={reduce ? false : { scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-600 text-white text-[10px] font-semibold px-2 py-0.5"
            >
              <Trophy className="h-3 w-3" /> META BATIDA
            </motion.span>
          )}
        </div>
      </motion.div>

      <div className="mt-3 text-center min-h-[2.5rem]">
        {loading ? (
          <Skeleton className="h-4 w-48 mx-auto" />
        ) : done ? (
          <p className="text-sm font-medium">
            {metaLabel ? <>🎁 {metaLabel} liberado — o gestor vai entregar.</> : "Meta da semana batida! Cada lead a mais conta pro ranking."}
          </p>
        ) : (
          <p className="text-sm">
            faltam <strong className="tabular-nums">{remaining}</strong>
            {metaLabel ? <> pro <strong>{metaLabel}</strong></> : " pra bater a meta da semana"}
          </p>
        )}
        {reached.length > 0 && !done && (
          <div className="mt-1.5 flex items-center justify-center gap-1">
            {reached.map((m) => (
              <motion.span
                key={m}
                animate={glow === m && !reduce ? { boxShadow: ["0 0 0 0 rgb(16 185 129 / 0)", "0 0 0 6px rgb(16 185 129 / 0.35)", "0 0 0 0 rgb(16 185 129 / 0)"] } : {}}
                transition={{ duration: 1.2 }}
                className="rounded-full border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900 text-emerald-800 dark:text-emerald-300 text-[10px] font-semibold px-2 py-0.5"
              >
                {m} ✓
              </motion.span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default GoalRing;
