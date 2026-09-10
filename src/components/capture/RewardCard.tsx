import { Gift, PartyPopper, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GOAL_TYPE_LABEL, useClaimCaptureReward, type CaptureRewardProgress } from "@/hooks/useCaptureRewards";

/**
 * Prêmio + progresso da promotora. `compact` = versão da tela "Hoje"
 * (uma linha com miniatura); completo = card do Perfil com barra e resgate.
 */
export function RewardCard({ reward, compact }: { reward: CaptureRewardProgress; compact?: boolean }) {
  const claim = useClaimCaptureReward();
  const g = GOAL_TYPE_LABEL[reward.goal_type];
  const pct = Math.min(100, Math.round((reward.current_value / reward.goal_value) * 100));
  const claimed = !!reward.claim_id && reward.claim_status !== "cancelled";
  const remaining = Math.max(0, reward.goal_value - reward.current_value);

  const doClaim = async () => {
    try {
      const r = await claim.mutateAsync(reward.id);
      toast.success(r.already ? "Resgate já registrado — o gestor vai entregar." : `🎉 Resgate registrado! Fale com o gestor pra receber: ${r.reward}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui resgatar");
    }
  };

  const thumb = (
    <div className={cn("shrink-0 rounded-lg overflow-hidden bg-muted/40 flex items-center justify-center", compact ? "h-12 w-12" : "h-20 w-20")}>
      {reward.image_url ? <img src={reward.image_url} alt="" className="h-full w-full object-cover" /> : <Gift className="h-5 w-5 text-muted-foreground" />}
    </div>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-amber-200/70 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-900/50 px-3 py-2">
        {thumb}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">Bata <strong>{reward.goal_value} {g.unit}</strong> {g.period} e ganhe</p>
          <p className="text-sm font-semibold truncate">🎁 {reward.name}</p>
        </div>
        {claimed ? (
          <span className="text-[11px] text-emerald-700 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Resgatado</span>
        ) : reward.eligible ? (
          <Button size="sm" className="h-8 bg-amber-500 hover:bg-amber-600 text-white" onClick={doClaim} disabled={claim.isPending}>
            {claim.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><PartyPopper className="h-3.5 w-3.5 mr-1" /> Resgatar</>}
          </Button>
        ) : (
          <span className="text-[11px] text-muted-foreground tabular-nums">faltam {remaining}</span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2">
      <div className="flex gap-3">
        {thumb}
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-tight">{reward.name}</p>
          {reward.description && <p className="text-xs text-muted-foreground mt-0.5">{reward.description}</p>}
          <p className="text-xs mt-1">
            <span className="font-medium">{reward.current_value}/{reward.goal_value} {g.unit}</span>
            <span className="text-muted-foreground"> {g.period}</span>
            {reward.stock != null && <span className="text-muted-foreground"> · restam {reward.stock}</span>}
          </p>
        </div>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full transition-all", pct >= 100 ? "bg-amber-500" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      {claimed ? (
        <p className="text-xs text-emerald-700 flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {reward.claim_status === "delivered" ? "Prêmio entregue 🎉" : "Resgate registrado — o gestor vai entregar"}
        </p>
      ) : reward.eligible ? (
        <Button className="w-full h-10 bg-amber-500 hover:bg-amber-600 text-white" onClick={doClaim} disabled={claim.isPending}>
          {claim.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><PartyPopper className="h-4 w-4 mr-2" /> Meta batida — resgatar prêmio</>}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">Faltam <strong>{remaining} {g.unit}</strong> pra ganhar.</p>
      )}
    </div>
  );
}
