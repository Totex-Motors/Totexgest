import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Gift, Wallet, GraduationCap, UserCircle, Receipt, Megaphone, X, FileSignature, Trophy, Target } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useCaptureWallet, useCaptureRewardProgress } from "@/hooks/useCaptureRewards";
import { WalletCard } from "@/components/capture/WalletCard";
import { RewardCard } from "@/components/capture/RewardCard";
import { LEDGER_STATUS_META, formatBRL, type CaptureWalletItem } from "@/types/capture";
import CaptureTraining from "./CaptureTraining";
import CaptureProfile from "./CaptureProfile";

/**
 * "Prêmios" — carteira (extrato do ledger), catálogo de prêmios com progresso,
 * treino e perfil. Tab via query param `tab` (carteira | premios | treino | perfil)
 * — /captacao/perfil e /captacao/treino redirecionam pra cá.
 *
 * Folgista (sem incentivos financeiros): só `treino | perfil`, default treino;
 * `tab=carteira|premios` na URL cai em treino.
 */

const TABS = ["carteira", "premios", "treino", "perfil"] as const;
const TABS_FOLGISTA = ["treino", "perfil"] as const;
type Tab = (typeof TABS)[number];

/** Aviso da mudança de regra (migration 20260911200000): some depois que a promotora dispensa. */
const REWARDS_NOTICE_KEY = "capture.rewardsNotice.v1";

function loadNoticeDismissed(): boolean {
  try { return localStorage.getItem(REWARDS_NOTICE_KEY) === "1"; } catch { return false; }
}

function fmtDate(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export default function CapturePrizes() {
  const { isFolgista } = useAuth();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const allowed: readonly string[] = isFolgista ? TABS_FOLGISTA : TABS;
  const tab: Tab = allowed.includes(raw ?? "") ? (raw as Tab) : isFolgista ? "treino" : "carteira";

  const setTab = (t: string) => {
    const p = new URLSearchParams(params);
    p.set("tab", t);
    setParams(p, { replace: true });
  };

  if (isFolgista) {
    return (
      <div className="space-y-3">
        <h1 className="text-lg font-bold flex items-center gap-2"><GraduationCap className="h-5 w-5 text-emerald-600" /> Treino</h1>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-2 w-full h-11">
            <TabsTrigger value="treino" className="gap-1 text-xs"><GraduationCap className="h-3.5 w-3.5" /> Treino</TabsTrigger>
            <TabsTrigger value="perfil" className="gap-1 text-xs"><UserCircle className="h-3.5 w-3.5" /> Perfil</TabsTrigger>
          </TabsList>

          <TabsContent value="treino" className="mt-3">
            <CaptureTraining />
          </TabsContent>

          <TabsContent value="perfil" className="mt-3">
            <CaptureProfile />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return <PrizesFull tab={tab} setTab={setTab} />;
}

/** Versão completa (perfil padrão): carteira + prêmios + treino + perfil. */
function PrizesFull({ tab, setTab }: { tab: Tab; setTab: (t: string) => void }) {
  const wallet = useCaptureWallet();
  const rewards = useCaptureRewardProgress();

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold flex items-center gap-2"><Gift className="h-5 w-5 text-emerald-600" /> Prêmios</h1>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid grid-cols-4 w-full h-11">
          <TabsTrigger value="carteira" className="gap-1 text-xs"><Wallet className="h-3.5 w-3.5" /> Carteira</TabsTrigger>
          <TabsTrigger value="premios" className="gap-1 text-xs"><Gift className="h-3.5 w-3.5" /> Prêmios</TabsTrigger>
          <TabsTrigger value="treino" className="gap-1 text-xs"><GraduationCap className="h-3.5 w-3.5" /> Treino</TabsTrigger>
          <TabsTrigger value="perfil" className="gap-1 text-xs"><UserCircle className="h-3.5 w-3.5" /> Perfil</TabsTrigger>
        </TabsList>

        <TabsContent value="carteira" className="mt-3 space-y-3">
          <WalletCard
            size="large"
            to={null}
            loading={wallet.isLoading}
            earnedCents={wallet.data?.earned_cents ?? 0}
            pendingCents={wallet.data?.pending_cents ?? 0}
            vouchersPending={wallet.data?.vouchers_pending ?? 0}
          />
          {!wallet.isLoading && wallet.data && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini label="Aprovado" value={formatBRL(wallet.data.approved_cents)} />
              <Mini label="Pago" value={formatBRL(wallet.data.paid_cents)} />
              <Mini label="Vouchers" value={`${wallet.data.vouchers_delivered}/${wallet.data.vouchers_delivered + wallet.data.vouchers_pending}`} hint="entregues" />
            </div>
          )}

          <div>
            <h2 className="text-sm font-semibold flex items-center gap-1.5 mb-2"><Receipt className="h-4 w-4" /> Extrato</h2>
            {wallet.isLoading ? (
              <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
            ) : wallet.isError ? (
              <p className="text-sm text-destructive">Erro ao carregar: {(wallet.error as Error).message}</p>
            ) : (wallet.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                Nada por aqui ainda. Bata a meta da semana ou tenha um contrato de intermediação assinado — o prêmio aparece aqui automaticamente. 🎯
              </p>
            ) : (
              <ul className="space-y-2">
                <AnimatePresence initial={false}>
                  {wallet.data!.items.map((it, i) => <LedgerRow key={it.id} item={it} index={i} />)}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="premios" className="mt-3 space-y-2">
          <RewardsNotice />
          {rewards.isLoading ? (
            <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          ) : (rewards.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">Nenhum prêmio cadastrado ainda — fala com o gestor. 🎁</p>
          ) : (
            rewards.data!.map((r) => <RewardCard key={r.id} reward={r} />)
          )}
          <p className="text-[11px] text-muted-foreground px-1 pt-1">
            Só leads <strong>válidos</strong> contam (nome, WhatsApp, carro, ano, intenção e autorização de contato). O voucher é liberado automaticamente quando a meta bate.
          </p>
        </TabsContent>

        <TabsContent value="treino" className="mt-3">
          <CaptureTraining />
        </TabsContent>

        <TabsContent value="perfil" className="mt-3">
          <CaptureProfile />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * "Novidade nos prêmios" — o R$ 25 de captação passou a entrar na assinatura
 * do contrato de intermediação (antes: quando o carro entrava). Dismissível;
 * a escolha fica só no aparelho (localStorage, com try/catch).
 */
function RewardsNotice() {
  const [dismissed, setDismissed] = useState<boolean>(loadNoticeDismissed);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(REWARDS_NOTICE_KEY, "1"); } catch { /* ignore */ }
  };
  return (
    <Card className="border-emerald-300/70 bg-emerald-50/60 dark:bg-emerald-950/30 dark:border-emerald-900">
      <CardContent className="pt-3 pb-3">
        <div className="flex items-start gap-2">
          <Megaphone className="h-4 w-4 text-emerald-700 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Novidade nos prêmios</p>
            <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
              <li className="flex items-start gap-1.5">
                <FileSignature className="h-3.5 w-3.5 shrink-0 mt-px text-emerald-600" />
                <span><strong className="text-foreground">R$ 25</strong> entram quando o proprietário <strong className="text-foreground">assina o contrato</strong> de intermediação (antes era quando o carro entrava).</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Trophy className="h-3.5 w-3.5 shrink-0 mt-px text-emerald-600" />
                <span><strong className="text-foreground">R$ 50</strong> continuam na <strong className="text-foreground">venda concluída</strong>.</span>
              </li>
              <li className="flex items-start gap-1.5">
                <Target className="h-3.5 w-3.5 shrink-0 mt-px text-emerald-600" />
                <span>A <strong className="text-foreground">meta semanal</strong> de leads válidos (voucher) continua igual.</span>
              </li>
            </ul>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dispensar aviso"
            className="shrink-0 -mr-1 -mt-1 h-7 w-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card px-2 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-bold tabular-nums">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function LedgerRow({ item, index }: { item: CaptureWalletItem; index: number }) {
  const reduce = useReducedMotion();
  const st = LEDGER_STATUS_META[item.status] ?? LEDGER_STATUS_META.pending;
  const cancelled = item.status === "cancelled";
  const isCash = item.reward_type === "cash";
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
      className={cn("rounded-xl border bg-card px-3 py-2.5 flex items-center gap-3", cancelled ? "border-border/40 opacity-70" : "border-border/60")}
    >
      <div className="h-11 w-11 shrink-0 rounded-lg overflow-hidden bg-muted/50 flex items-center justify-center">
        {item.image_url ? (
          <img src={item.image_url} alt="" className="h-full w-full object-cover" />
        ) : isCash ? (
          <Wallet className="h-5 w-5 text-emerald-600" />
        ) : (
          <Gift className="h-5 w-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium truncate", cancelled && "line-through")}>{item.title}</p>
        <p className="text-[11px] text-muted-foreground">
          {fmtDate(item.earned_at)}
          {item.status === "paid" && item.paid_at ? ` · pago em ${fmtDate(item.paid_at)}` : ""}
        </p>
        {cancelled && item.cancel_reason && (
          <p className="text-[11px] text-red-600 dark:text-red-400 mt-0.5">{item.cancel_reason}</p>
        )}
      </div>
      <div className="text-right shrink-0">
        <p className={cn("text-sm font-bold tabular-nums", cancelled ? "text-muted-foreground" : isCash ? "text-emerald-700 dark:text-emerald-400" : "text-foreground")}>
          {isCash ? formatBRL(item.amount_cents) : (item.voucher_label ?? "Voucher")}
        </p>
        <Badge variant="outline" className={cn("border text-[10px] mt-0.5", st.cls)}>{st.label}</Badge>
      </div>
    </motion.li>
  );
}
