import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { animate, motion, useMotionValue, useReducedMotion } from "framer-motion";
import { Wallet, ChevronRight, Gift } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatBRL } from "@/types/capture";

/**
 * Carteira da promotora: "R$ X conquistados • R$ Y pendentes".
 * Valores vêm SÓ do servidor (ledger). O count-up roda apenas quando o valor
 * mudou desde a última vez que a promotora viu (localStorage) — nunca otimista.
 */

const LAST_SEEN_KEY = "captacao:wallet:last";

function readLastSeen(): { earned: number; pending: number } | null {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    return raw ? (JSON.parse(raw) as { earned: number; pending: number }) : null;
  } catch {
    return null;
  }
}

/** Número que faz count-up de `from` até `to` uma vez; depois segue o valor direto. */
function CountUp({ from, to, className }: { from: number; to: number; className?: string }) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(from);
  const [display, setDisplay] = useState(from);

  useEffect(() => {
    const unsub = mv.on("change", (v) => setDisplay(Math.round(v)));
    return unsub;
  }, [mv]);

  useEffect(() => {
    if (reduce || from === to) {
      mv.set(to);
      setDisplay(to);
      return;
    }
    const ctrl = animate(mv, to, { duration: 0.9, ease: "easeOut" });
    return () => ctrl.stop();
  }, [mv, from, to, reduce]);

  return <span className={cn("tabular-nums", className)}>{formatBRL(display)}</span>;
}

export function WalletCard({
  earnedCents,
  pendingCents,
  vouchersPending = 0,
  loading,
  size = "compact",
  to = "/captacao/premios",
  className,
}: {
  earnedCents: number;
  pendingCents: number;
  vouchersPending?: number;
  loading?: boolean;
  size?: "compact" | "large";
  /** Link ao tocar; passe null pra não ser clicável (ex.: dentro da própria aba Carteira) */
  to?: string | null;
  className?: string;
}) {
  const reduce = useReducedMotion();
  // "from" é decidido UMA vez por montagem, com dados do servidor já carregados.
  const fromRef = useRef<{ earned: number; pending: number } | null>(null);
  if (!loading && fromRef.current == null) {
    const last = readLastSeen();
    fromRef.current = last ?? { earned: earnedCents, pending: pendingCents };
  }
  useEffect(() => {
    if (loading) return;
    try { localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ earned: earnedCents, pending: pendingCents })); } catch { /* ignore */ }
  }, [loading, earnedCents, pendingCents]);

  const from = fromRef.current ?? { earned: earnedCents, pending: pendingCents };
  const changed = !loading && (from.earned !== earnedCents || from.pending !== pendingCents);
  const large = size === "large";

  const body = (
    <motion.div
      initial={false}
      animate={changed && !reduce ? { scale: [1, 1.015, 1] } : { scale: 1 }}
      transition={{ duration: 0.6 }}
      className={cn(
        "relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 text-white shadow-md",
        "dark:border-zinc-700",
        large ? "p-5" : "p-4",
        className,
      )}
    >
      <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-emerald-500/20 blur-2xl" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-zinc-400 flex items-center gap-1.5">
          <Wallet className="h-3.5 w-3.5 text-emerald-400" /> Minha carteira
        </span>
        {to && <ChevronRight className="h-4 w-4 text-zinc-500" />}
      </div>

      <div className={cn("mt-2 flex items-end gap-4 flex-wrap", large && "gap-6")}>
        <div className="min-w-0">
          <p className="text-[11px] text-zinc-400">conquistados</p>
          {loading ? (
            <Skeleton className="h-8 w-28 bg-zinc-800" />
          ) : (
            <CountUp from={from.earned} to={earnedCents} className={cn("font-bold text-emerald-400 leading-none", large ? "text-3xl" : "text-2xl")} />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-zinc-400">pendentes</p>
          {loading ? (
            <Skeleton className="h-6 w-20 bg-zinc-800" />
          ) : (
            <CountUp from={from.pending} to={pendingCents} className={cn("font-semibold text-zinc-100 leading-none", large ? "text-xl" : "text-lg")} />
          )}
        </div>
      </div>

      {!loading && vouchersPending > 0 && (
        <p className="mt-2 text-xs text-zinc-300 flex items-center gap-1.5">
          <Gift className="h-3.5 w-3.5 text-emerald-400" />
          {vouchersPending === 1 ? "1 voucher a receber" : `${vouchersPending} vouchers a receber`}
        </p>
      )}
      {large && !loading && (
        <p className="mt-3 text-[11px] text-zinc-500">
          Pendente vira conquistado quando o gestor aprova. Pago = já caiu pra você.
        </p>
      )}
    </motion.div>
  );

  if (!to) return body;
  return (
    <Link to={to} className="block active:scale-[0.99] transition-transform" aria-label="Abrir minha carteira">
      {body}
    </Link>
  );
}

export default WalletCard;
