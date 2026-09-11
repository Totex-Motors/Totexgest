import { Gift, CheckCircle2, Clock, Sparkles } from "lucide-react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { GOAL_TYPE_LABEL, type CaptureRewardProgress } from "@/hooks/useCaptureRewards";

/**
 * Prêmio + progresso da promotora. `compact` = uma linha com miniatura (Home);
 * completo = card do catálogo (aba Prêmios) com barra.
 *
 * O voucher é AUTOMÁTICO: quando a meta bate, o servidor lança no ledger e
 * `claim_status` reflete isso. Não existe mais botão "Resgatar".
 */

function statusLine(reward: CaptureRewardProgress): { text: string; tone: "done" | "wait" | null } {
  const s = reward.claim_status;
  if (!reward.claim_id || s === "cancelled") return { text: "", tone: null };
  if (s === "paid" || s === "delivered") return { text: "Entregue 🎉", tone: "done" };
  if (s === "approved") return { text: "Voucher aprovado — o gestor vai entregar", tone: "wait" };
  return { text: "Voucher liberado — o gestor vai entregar", tone: "wait" };
}

export function RewardCard({ reward, compact }: { reward: CaptureRewardProgress; compact?: boolean }) {
  const reduce = useReducedMotion();
  const g = GOAL_TYPE_LABEL[reward.goal_type];
  const pct = Math.min(100, Math.round((reward.current_value / Math.max(1, reward.goal_value)) * 100));
  const remaining = Math.max(0, reward.goal_value - reward.current_value);
  const st = statusLine(reward);
  const achieved = !!st.tone;

  const thumb = (
    <div className={cn("shrink-0 rounded-lg overflow-hidden bg-muted/40 flex items-center justify-center", compact ? "h-12 w-12" : "h-20 w-20")}>
      {reward.image_url ? <img src={reward.image_url} alt="" className="h-full w-full object-cover" /> : <Gift className="h-5 w-5 text-muted-foreground" />}
    </div>
  );

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-3 rounded-lg border px-3 py-2",
        achieved ? "border-emerald-300/70 bg-emerald-50/60 dark:bg-emerald-950/20 dark:border-emerald-900/50" : "border-border/60 bg-card",
      )}>
        {thumb}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Bata <strong>{reward.goal_value} {g.unit}</strong> {g.period} e ganhe</p>
          <p className="text-sm font-semibold truncate">🎁 {reward.name}</p>
        </div>
        {achieved ? (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1 text-right">
            {st.tone === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
            {st.tone === "done" ? "Entregue" : "Liberado"}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground tabular-nums">faltam {remaining}</span>
        )}
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border p-3 space-y-2 bg-card", achieved ? "border-emerald-300/70" : "border-border/60")}>
      <div className="flex gap-3">
        {thumb}
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight">{reward.name}</p>
          {reward.description && <p className="text-xs text-muted-foreground mt-0.5">{reward.description}</p>}
          <p className="text-xs mt-1">
            <span className="font-medium tabular-nums">{reward.current_value}/{reward.goal_value} {g.unit}</span>
            <span className="text-muted-foreground"> {g.period}</span>
            {reward.stock != null && <span className="text-muted-foreground"> · restam {reward.stock}</span>}
          </p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <motion.div
          className={cn("h-full", pct >= 100 ? "bg-emerald-500" : "bg-emerald-600/80")}
          initial={reduce ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: reduce ? 0 : 0.6, ease: "easeOut" }}
        />
      </div>
      {achieved ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-medium">
          {st.tone === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          {st.text}
        </p>
      ) : reward.eligible ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
          <Sparkles className="h-3.5 w-3.5" /> Meta batida — o voucher é liberado automaticamente.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Faltam <strong>{remaining} {g.unit}</strong> pra ganhar.</p>
      )}
    </div>
  );
}
