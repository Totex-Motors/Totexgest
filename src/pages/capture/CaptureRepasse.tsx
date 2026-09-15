import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  Gift, Copy, Share2, Loader2, Users, CheckCircle2, DoorOpen, Target, Sparkles, QrCode,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { GoalRing } from "@/components/capture/GoalRing";
import { useRepasseStats, useMyReferrals, useEnsureRepasseCode, type RepasseReferralStatus } from "@/hooks/useRepasse";
import { formatPhoneDisplay } from "@/lib/phone";
import { cn } from "@/lib/utils";

// REPASSE POR INDICAÇÃO — tela da promotora (/captacao/repasse)
//
// Novo ganho: ela entrega o cartão NFC (ou compartilha o link/QR). Quem confirma
// o WhatsApp entra no grupo de repasses e fica atrelado a ela. Se essa pessoa
// comprar um carro pela intermediação, ela ganha R$ 150. Meta: 5 convites/dia.

const REWARD_LABEL = "R$ 150";

function brl(cents: number) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const STATUS_META: Record<RepasseReferralStatus, { label: string; cls: string; icon: typeof Users }> = {
  confirmed: { label: "Confirmou WhatsApp", cls: "border-sky-300 text-sky-700 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-300", icon: CheckCircle2 },
  joined: { label: "Entrou no grupo", cls: "border-indigo-300 text-indigo-700 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-300", icon: DoorOpen },
  converted: { label: "Comprou 🎉", cls: "border-emerald-400 text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300", icon: Sparkles },
  invalid: { label: "Inválido", cls: "border-slate-300 text-slate-500 bg-slate-50 dark:bg-slate-900/40", icon: Users },
};

export default function CaptureRepasse() {
  const stats = useRepasseStats("all");
  const referrals = useMyReferrals();
  const ensure = useEnsureRepasseCode();
  const [showQr, setShowQr] = useState(false);

  const s = stats.data;
  const code = s?.code ?? null;
  const link = useMemo(
    () => (code ? `${window.location.origin}/r/${code}` : ""),
    [code],
  );
  const dailyGoal = s?.daily_goal ?? 5;

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copiado! Cole onde quiser.");
    } catch {
      toast.error("Não consegui copiar. Segure o link pra copiar manualmente.");
    }
  }

  async function shareLink() {
    if (!link) return;
    const text = `Entra na nossa comunidade de ofertas de carros! Confirma seu WhatsApp aqui: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Comunidade de Ofertas Totex", text, url: link }); } catch { /* cancelado */ }
    } else {
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank");
    }
  }

  return (
    <div className="space-y-4">
      {/* Cabeçalho */}
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Gift className="h-5 w-5 text-emerald-600" /> Indique e ganhe
        </h1>
        <p className="text-sm text-muted-foreground">
          Cada pessoa que você trouxer e comprar um carro te dá <strong className="text-emerald-700 dark:text-emerald-400">{REWARD_LABEL}</strong>.
        </p>
      </div>

      {/* Meta diária de convites */}
      <Card className="border-emerald-200/70 dark:border-emerald-900/50">
        <CardContent className="pt-4 pb-4 flex items-center gap-4">
          <GoalRing current={s?.hoje ?? 0} goal={dailyGoal} label="hoje" variant="day" size={110} loading={stats.isLoading} />
          <div className="min-w-0">
            <p className="text-sm font-semibold flex items-center gap-1.5"><Target className="h-4 w-4 text-emerald-600" /> Meta de convites de hoje</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {stats.isLoading ? "…" : (s?.hoje ?? 0) >= dailyGoal
                ? <>Meta batida! 👏 {s?.hoje} convite{(s?.hoje ?? 0) === 1 ? "" : "s"} hoje.</>
                : <>Faltam <strong className="text-foreground tabular-nums">{Math.max(0, dailyGoal - (s?.hoje ?? 0))}</strong> convite{Math.max(0, dailyGoal - (s?.hoje ?? 0)) === 1 ? "" : "s"} pra bater a meta.</>}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Cartão / link da promotora */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <p className="text-sm font-semibold mb-1 flex items-center gap-1.5"><Share2 className="h-4 w-4" /> Seu link do cartão NFC</p>
          {stats.isLoading ? (
            <Skeleton className="h-10 w-full rounded-lg" />
          ) : !code ? (
            <div className="text-sm text-muted-foreground">
              <p className="mb-3">Você ainda não tem um link. Gere o seu para começar a convidar.</p>
              <button
                type="button"
                onClick={() => ensure.mutate()}
                disabled={ensure.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {ensure.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Gift className="h-4 w-4" />} Gerar meu link
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
                <span className="flex-1 truncate text-sm font-mono">{link}</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button type="button" onClick={copyLink} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
                  <Copy className="h-4 w-4" /> Copiar
                </button>
                <button type="button" onClick={shareLink} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
                  <Share2 className="h-4 w-4" /> Compartilhar
                </button>
                <button type="button" onClick={() => setShowQr((v) => !v)} className="flex flex-col items-center gap-1 rounded-lg border border-border/70 py-2 text-xs font-medium hover:bg-muted/50">
                  <QrCode className="h-4 w-4" /> {showQr ? "Ocultar" : "QR Code"}
                </button>
              </div>
              {showQr && (
                <div className="mt-4 flex flex-col items-center gap-2">
                  <div className="rounded-xl bg-white p-3 shadow-sm">
                    <QRCodeSVG value={link} size={180} level="M" marginSize={0} />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Aponte a câmera para abrir o convite.</p>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Dica: quem tocar o cartão NFC também cai nesse link. É a mesma coisa.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Números */}
      <div className="grid grid-cols-3 gap-2">
        <StatBox icon={Users} label="Indiquei" value={s?.total_periodo} loading={stats.isLoading} />
        <StatBox icon={DoorOpen} label="Entraram" value={s?.entraram} loading={stats.isLoading} />
        <StatBox icon={Sparkles} label="Compraram" value={s?.converteram} loading={stats.isLoading} accent />
      </div>

      {/* Ganho */}
      <Card className="bg-emerald-600 text-white border-emerald-700">
        <CardContent className="pt-4 pb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-emerald-100 uppercase tracking-wide">Você já ganhou com indicações</p>
            <p className="text-2xl font-bold tabular-nums">{stats.isLoading ? "…" : brl(s?.ganho_cents ?? 0)}</p>
          </div>
          <Gift className="h-8 w-8 text-emerald-200" />
        </CardContent>
      </Card>

      {/* Lista de indicações */}
      <div>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5"><Users className="h-4 w-4" /> Suas indicações</h2>
        {referrals.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
        ) : (referrals.data?.length ?? 0) === 0 ? (
          <div className="rounded-xl border border-dashed border-border/80 px-3 py-4 text-xs text-muted-foreground">
            Ainda sem indicações. Compartilhe seu link e comece a convidar — meta de {dailyGoal} por dia! 🚀
          </div>
        ) : (
          <ul className="space-y-2">
            {referrals.data!.map((r) => {
              const meta = STATUS_META[r.status] ?? STATUS_META.confirmed;
              const Icon = meta.icon;
              return (
                <li key={r.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{r.name || "Sem nome"}</p>
                    <p className="text-[11px] text-muted-foreground">{formatPhoneDisplay(r.phone)}</p>
                  </div>
                  <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap", meta.cls)}>
                    <Icon className="h-3 w-3" /> {meta.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatBox({ icon: Icon, label, value, loading, accent }: { icon: typeof Users; label: string; value?: number; loading?: boolean; accent?: boolean }) {
  return (
    <Card className={cn(accent && "border-emerald-300/70 dark:border-emerald-800/60")}>
      <CardContent className="pt-3 pb-3 flex flex-col items-center gap-0.5">
        <Icon className={cn("h-4 w-4", accent ? "text-emerald-600" : "text-muted-foreground")} />
        <span className="text-lg font-bold tabular-nums">{loading ? "…" : (value ?? 0)}</span>
        <span className="text-[10px] text-muted-foreground">{label}</span>
      </CardContent>
    </Card>
  );
}
