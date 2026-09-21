import { cn } from "@/lib/utils";
import { formatFipeRef } from "@/hooks/useFipeLookup";

/** Selo "abaixo / na / acima da FIPE + %". Compara o preço pedido/anúncio com a FIPE. */
export function FipeOpportunityBadge({
  fipeCents,
  askCents,
  mesReferencia,
  className,
}: {
  fipeCents: number | null | undefined;
  askCents: number | null | undefined;
  mesReferencia?: string | null;
  className?: string;
}) {
  if (!fipeCents || fipeCents <= 0 || !askCents || askCents <= 0) return null;
  const diffPct = Math.round(((askCents - fipeCents) / fipeCents) * 100);
  const abaixo = diffPct < 0;
  const naFipe = diffPct === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        abaixo ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
          : naFipe ? "bg-slate-100 text-slate-600 dark:bg-slate-800/40"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
        className,
      )}
      title={mesReferencia ? `FIPE ${formatFipeRef(mesReferencia)}` : "Comparado à Tabela FIPE"}
    >
      {abaixo ? "🔥 " : ""}{abaixo ? "Abaixo da FIPE" : naFipe ? "Na FIPE" : "Acima da FIPE"} {diffPct > 0 ? "+" : ""}{diffPct}%
    </span>
  );
}
