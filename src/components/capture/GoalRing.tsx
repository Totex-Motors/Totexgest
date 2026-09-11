import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Anel de meta (leads VÁLIDOS / meta, do servidor). Usado em dupla na Home:
 * "Hoje" (meta diária) e "Semana" (meta semanal, com marcos 10/20/30 e
 * celebração única por semana em `captacao:celebrated:<period>`).
 * Tudo decorativo, respeita reduced-motion e nunca bloqueia navegação.
 */

const MILESTONES = [10, 20, 30];

/** Segunda-feira da semana atual (mesma janela do servidor, que usa date_trunc('week')). */
export function currentWeekPeriod(now = new Date()) {
  const d = new Date(now);
  const dow = (d.getDay() + 6) % 7; // seg=0
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
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
  label,
  loading,
  size = 132,
  variant = "week",
}: {
  current: number;
  goal: number;
  /** texto embaixo do número (ex.: "hoje", "semana") */
  label: string;
  loading?: boolean;
  size?: number;
  /** week = marcos 10/20/30 + confete uma vez por semana; day = celebração só com selo */
  variant?: "week" | "day";
}) {
  const reduce = useReducedMotion();
  const safeGoal = Math.max(1, goal || 1);
  const pct = Math.min(1, current / safeGoal);
  const done = !loading && current >= safeGoal;
  const period = useMemo(() => (variant === "week" ? currentWeekPeriod() : new Date().toISOString().slice(0, 10)), [variant]);
  const stroke = Math.max(8, Math.round(size / 13));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const milestones = variant === "week" ? MILESTONES.filter((m) => m < safeGoal) : [];

  // ── Celebração: uma vez por período (só confete no anel da semana) ──
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!done) return;
    const key = `captacao:celebrated:${variant}:${period}`;
    let already = false;
    try { already = localStorage.getItem(key) === "1"; } catch { /* ignore */ }
    if (already) return;
    try { localStorage.setItem(key, "1"); } catch { /* ignore */ }
    if (reduce || variant !== "week") return;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 1800);
    return () => clearTimeout(t);
  }, [done, period, reduce, variant]);

  // ── Marco (10/20/30): glow curto quando cruza ──
  const prev = useRef<number | null>(null);
  const [glow, setGlow] = useState<number | null>(null);
  useEffect(() => {
    if (loading) return;
    const p = prev.current;
    prev.current = current;
    if (p == null) return; // primeira carga: sem glow
    const crossed = milestones.filter((m) => p < m && current >= m).pop();
    if (crossed == null || reduce) return;
    setGlow(crossed);
    const t = setTimeout(() => setGlow(null), 1400);
    return () => clearTimeout(t);
  }, [current, loading, reduce, milestones]);

  return (
    <div className="relative flex flex-col items-center">
      <AnimatePresence>{celebrate && <Confetti key="confetti" />}</AnimatePresence>

      <motion.div
        className="relative"
        style={{ width: size, height: size }}
        animate={glow != null && !reduce ? { scale: [1, 1.04, 1] } : { scale: 1 }}
        transition={{ duration: 0.5 }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} className="stroke-muted" strokeWidth={stroke} fill="none" />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            className={cn(done ? "stroke-emerald-500" : "stroke-emerald-600")}
            strokeDasharray={circumference}
            initial={reduce ? false : { strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: loading ? circumference : circumference * (1 - pct) }}
            transition={{ duration: reduce ? 0 : 0.9, ease: "easeOut" }}
            style={glow != null ? { filter: "drop-shadow(0 0 8px rgb(16 185 129 / 0.8))" } : undefined}
          />
          {milestones.map((m) => {
            const a = (m / safeGoal) * 2 * Math.PI;
            const cx = size / 2 + r * Math.cos(a);
            const cy = size / 2 + r * Math.sin(a);
            const hit = current >= m;
            return <circle key={m} cx={cx} cy={cy} r={hit ? 3 : 2} className={cn(hit ? "fill-white" : "fill-muted-foreground/40")} />;
          })}
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {loading ? (
            <Skeleton className="h-7 w-14" />
          ) : (
            <motion.p
              key={current}
              initial={reduce ? false : { scale: 0.9, opacity: 0.6 }}
              animate={{ scale: 1, opacity: 1 }}
              className={cn("font-bold tabular-nums tracking-tight leading-none", size >= 160 ? "text-4xl" : "text-[26px]")}
            >
              {current}
              <span className={cn("text-muted-foreground font-semibold", size >= 160 ? "text-xl" : "text-sm")}>/{safeGoal}</span>
            </motion.p>
          )}
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">{label}</p>
          {done && (
            <motion.span
              initial={reduce ? false : { scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-600 text-white text-[9px] font-semibold px-1.5 py-0.5"
            >
              <Trophy className="h-2.5 w-2.5" /> BATEU
            </motion.span>
          )}
        </div>
      </motion.div>
    </div>
  );
}

export default GoalRing;
