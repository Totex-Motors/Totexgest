import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Car, Check, UserCheck, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LEDGER_STATUS_META,
  VEHICLE_JOURNEY,
  VEHICLE_STATUS_META,
  formatBRL,
  vehicleTitle,
  type CaptureLedgerStatus,
  type MyCaptureVehicle,
} from "@/types/capture";

/**
 * Card da jornada de um carro captado pela promotora:
 * identificação → status → timeline (toque numa etapa = explicação curta) →
 * bloco de prêmio (valores e status vêm do ledger; o front nunca calcula).
 */

function fmtDate(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function ledgerLabel(s: CaptureLedgerStatus | null) {
  if (!s) return null;
  return LEDGER_STATUS_META[s]?.label.toLowerCase() ?? s;
}

export function VehicleJourneyCard({ vehicle: v, compact }: { vehicle: MyCaptureVehicle; compact?: boolean }) {
  const reduce = useReducedMotion();
  const [openStep, setOpenStep] = useState<number | null>(null);
  const meta = VEHICLE_STATUS_META[v.status] ?? VEHICLE_STATUS_META.lead;
  const sold = v.status === "vendido";
  const lost = v.status === "perdido";
  const currentStep = meta.step;

  const captured = v.reward_captured_cents ?? 0;
  const soldReward = v.reward_sold_cents ?? 0;

  return (
    <motion.article
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "relative overflow-hidden rounded-2xl border bg-card",
        sold ? "border-emerald-500/70 shadow-[0_0_0_1px_rgb(16_185_129_/_0.25)]" : "border-border/60",
        lost && "opacity-70",
      )}
    >
      {/* brilho do vendido */}
      {sold && !reduce && (
        <motion.div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-emerald-300/25 to-transparent"
          initial={{ x: "-120%" }}
          animate={{ x: "400%" }}
          transition={{ duration: 2.2, repeat: Infinity, repeatDelay: 3, ease: "easeInOut" }}
        />
      )}

      <div className="p-3.5 space-y-3">
        {/* Cabeçalho */}
        <div className="flex items-start gap-3">
          <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center shrink-0", sold ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground")}>
            <Car className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-tight truncate">{vehicleTitle(v)}</p>
            <p className="text-xs text-muted-foreground truncate">
              Captado por você{v.captured_at ? ` • ${fmtDate(v.captured_at)}` : ""} · {v.lead_name}
              {v.km != null ? ` · ${v.km.toLocaleString("pt-BR")} km` : ""}
            </p>
          </div>
          {sold ? (
            <motion.span
              initial={reduce ? false : { scale: 0.7, rotate: -8, opacity: 0 }}
              animate={{ scale: 1, rotate: -6, opacity: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 18 }}
              className="shrink-0 rounded-md border-2 border-emerald-600 text-emerald-700 dark:text-emerald-400 text-[11px] font-black tracking-widest px-2 py-0.5"
            >
              VENDIDO
            </motion.span>
          ) : (
            <Badge variant="outline" className={cn("border text-[10px] shrink-0", meta.cls)}>{meta.label}</Badge>
          )}
        </div>

        {/* Timeline */}
        {!lost && (
          <div>
            <ol className="flex items-center">
              {VEHICLE_JOURNEY.map((s, i) => {
                const doneStep = currentStep > i || (sold && i === VEHICLE_JOURNEY.length - 1);
                const active = currentStep === i;
                const isOpen = openStep === i;
                return (
                  <li key={s.status} className={cn("flex items-center", i < VEHICLE_JOURNEY.length - 1 && "flex-1")}>
                    <button
                      type="button"
                      onClick={() => setOpenStep(isOpen ? null : i)}
                      aria-expanded={isOpen}
                      className="flex flex-col items-center gap-1 focus:outline-none"
                    >
                      <motion.span
                        animate={active && !reduce ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                        transition={{ duration: 1.6, repeat: active ? Infinity : 0, repeatDelay: 1.5 }}
                        className={cn(
                          "h-6 w-6 rounded-full border-2 flex items-center justify-center text-[10px] font-bold",
                          doneStep && "bg-emerald-600 border-emerald-600 text-white",
                          active && "bg-emerald-50 dark:bg-emerald-950/40 border-emerald-600 text-emerald-700 dark:text-emerald-400 ring-4 ring-emerald-500/20",
                          !doneStep && !active && "bg-background border-border text-muted-foreground",
                        )}
                      >
                        {doneStep ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </motion.span>
                      {!compact && (
                        <span className={cn("text-[9px] uppercase tracking-wide", active ? "text-emerald-700 dark:text-emerald-400 font-semibold" : doneStep ? "text-foreground" : "text-muted-foreground")}>
                          {s.label}
                        </span>
                      )}
                    </button>
                    {i < VEHICLE_JOURNEY.length - 1 && (
                      <span className={cn("h-0.5 flex-1 mx-1 rounded", doneStep ? "bg-emerald-600" : "bg-border", !compact && "-mt-4")} />
                    )}
                  </li>
                );
              })}
            </ol>
            <AnimatePresence initial={false}>
              {openStep != null && (
                <motion.p
                  key={openStep}
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? undefined : { height: 0, opacity: 0 }}
                  className="overflow-hidden text-xs text-muted-foreground mt-2 rounded-md bg-muted/50 px-2.5 py-1.5"
                >
                  <strong className="text-foreground">{VEHICLE_JOURNEY[openStep].label}:</strong> {VEHICLE_JOURNEY[openStep].hint}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Prêmio */}
        {!lost && (captured > 0 || soldReward > 0) && (
          <div className="rounded-xl bg-zinc-950 text-white p-3 space-y-1.5 dark:bg-zinc-900">
            <p className="text-[10px] uppercase tracking-wide text-zinc-400 flex items-center gap-1"><Sparkles className="h-3 w-3 text-emerald-400" /> Seu prêmio</p>
            {captured > 0 && (
              <RewardLine
                amount={captured}
                label="captado"
                status={v.ledger_captured_status}
                future={!v.ledger_captured_status && currentStep < 1 ? "quando captado" : null}
              />
            )}
            {soldReward > 0 && (
              <RewardLine
                amount={soldReward}
                label="vendido"
                status={v.ledger_sold_status}
                future={!v.ledger_sold_status ? "se vendido" : null}
                plus
              />
            )}
          </div>
        )}

        {/* Especialista */}
        {!compact && (v.sales_rep_name || v.stage_name) && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <UserCheck className="h-3 w-3" />
            {v.sales_rep_name ? `${v.sales_rep_name.split(" ")[0]} cuida desse carro` : "Aguardando especialista"}
            {v.stage_name ? ` · ${v.stage_name}` : ""}
          </p>
        )}
        {lost && (
          <p className="text-xs text-muted-foreground">Esse não deu certo dessa vez. Bora pro próximo — cada carro captado é uma nova chance. 🚗</p>
        )}
      </div>
    </motion.article>
  );
}

function RewardLine({
  amount, label, status, future, plus,
}: { amount: number; label: string; status: CaptureLedgerStatus | null; future: string | null; plus?: boolean }) {
  const st = status ? LEDGER_STATUS_META[status] : null;
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className={cn("font-semibold tabular-nums", status && status !== "cancelled" ? "text-emerald-400" : "text-zinc-200")}>
        {plus && !status ? "+" : ""}{formatBRL(amount)} <span className="text-xs font-normal text-zinc-400">({label})</span>
      </span>
      {st ? (
        <span className="text-[11px] flex items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", st.dot)} />
          <span className={cn(status === "cancelled" ? "text-zinc-500 line-through" : "text-zinc-200")}>{ledgerLabel(status)}</span>
        </span>
      ) : (
        <span className="text-[11px] text-zinc-400">{future}</span>
      )}
    </div>
  );
}

export default VehicleJourneyCard;
