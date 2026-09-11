import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Bot, ClipboardCheck, History, Loader2, Play, RotateCcw, Send, Sparkles, Target, Trophy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  ROLEPLAY_DIFFICULTY_META,
  useRoleplay,
  useRoleplayScenarios,
  useTrainingSummary,
  type RoleplayEvaluation,
  type RoleplayMessage,
  type RoleplayScenario,
  type RoleplayScenarioMeta,
  type TrainingSummary,
} from "@/hooks/useCaptureRoleplay";

/**
 * Roleplay com IA: a promotora treina a abordagem do corredor conversando
 * com um "cliente" (IA) num chat estilo WhatsApp, e recebe uma avaliação por
 * critério no fim. Três telas: lista de cenários → chat → resultado.
 * Sair no meio (voltar) abandona a sessão no servidor.
 */

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : "Algo deu errado. Tenta de novo.";
}

function fmtDate(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function scoreTone(score: number) {
  if (score >= 80) return { text: "text-emerald-600 dark:text-emerald-400", stroke: "stroke-emerald-500", bar: "bg-emerald-500", chip: "bg-emerald-600 text-white" };
  if (score >= 60) return { text: "text-amber-600 dark:text-amber-400", stroke: "stroke-amber-500", bar: "bg-amber-500", chip: "bg-amber-500 text-white" };
  return { text: "text-red-600 dark:text-red-400", stroke: "stroke-red-500", bar: "bg-red-500", chip: "bg-red-500 text-white" };
}

export function RoleplayChat() {
  const rp = useRoleplay();
  const scenarios = useRoleplayScenarios();
  const summary = useTrainingSummary();

  const handleStart = async (sc: RoleplayScenarioMeta) => {
    try {
      await rp.start(sc);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  if (rp.phase === "chat" && rp.scenario) {
    return (
      <ChatScreen
        scenario={rp.scenario}
        messages={rp.messages}
        turns={rp.turns}
        maxTurns={rp.maxTurns}
        ended={rp.ended}
        isSending={rp.isSending}
        isFinishing={rp.isFinishing}
        onSend={async (t) => {
          try { await rp.reply(t); return true; } catch (e) { toast.error(errMsg(e)); return false; }
        }}
        onFinish={async () => {
          try { await rp.finish(); } catch (e) { toast.error(errMsg(e)); }
        }}
        onBack={() => { void rp.abandon(); }}
      />
    );
  }

  if (rp.phase === "result" && rp.result && rp.scenario) {
    return (
      <ResultScreen
        scenario={rp.scenario}
        score={rp.result.score}
        evaluation={rp.result.evaluation}
        isStarting={rp.isStarting}
        onRetry={() => { const sc = rp.scenario; if (sc) void handleStart(sc); }}
        onOther={() => rp.reset()}
      />
    );
  }

  return (
    <ScenarioList
      scenarios={scenarios.data ?? []}
      loading={scenarios.isLoading}
      error={scenarios.isError ? errMsg(scenarios.error) : null}
      summary={summary.data}
      startingId={rp.isStarting ? "pending" : null}
      onStart={handleStart}
    />
  );
}

// ─── Tela 1: cenários + histórico ───────────────────────────────────────────

function ScenarioList({
  scenarios, loading, error, summary, startingId, onStart,
}: {
  scenarios: RoleplayScenario[];
  loading: boolean;
  error: string | null;
  summary?: TrainingSummary;
  startingId: string | null;
  onStart: (sc: RoleplayScenarioMeta) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { if (!startingId) setPending(null); }, [startingId]);
  const last = summary?.last_sessions ?? [];

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border/60 bg-zinc-900 text-white p-3 flex items-start gap-3 dark:bg-zinc-950">
        <div className="h-9 w-9 rounded-full bg-emerald-600 flex items-center justify-center shrink-0"><Bot className="h-5 w-5" /></div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">Treine com um cliente de mentira</p>
          <p className="text-xs text-zinc-300 mt-0.5">A IA faz o papel do proprietário no corredor. Você aborda, trata a objeção e pede o WhatsApp. No fim, recebe nota e dicas.</p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
      ) : error ? (
        <p className="text-sm text-destructive">Erro ao carregar cenários: {error}</p>
      ) : scenarios.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">Nenhum cenário disponível ainda — fala com o gestor. 🎭</p>
      ) : (
        <ul className="space-y-2">
          {scenarios.map((sc) => {
            const d = ROLEPLAY_DIFFICULTY_META[sc.difficulty] ?? ROLEPLAY_DIFFICULTY_META.medio;
            const isPending = pending === sc.id && !!startingId;
            return (
              <li key={sc.id} className="rounded-xl border border-border/60 bg-card p-3 space-y-2">
                <div className="flex items-start gap-3">
                  <div className="h-11 w-11 shrink-0 rounded-full bg-muted/60 flex items-center justify-center text-2xl" aria-hidden>{sc.emoji}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold leading-tight">{sc.title}</p>
                      <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", d.cls)}>{d.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{sc.summary}</p>
                  </div>
                </div>
                <p className="text-xs flex items-start gap-1.5 text-foreground/90">
                  <Target className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />
                  <span><span className="font-medium">Objetivo:</span> {sc.objective}</span>
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground tabular-nums">até {sc.max_turns} rodadas</span>
                  <Button
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5"
                    disabled={!!startingId}
                    onClick={() => { setPending(sc.id); onStart(sc); }}
                  >
                    {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    Começar
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {last.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2"><History className="h-4 w-4" /> Últimos roleplays</h3>
          <ul className="space-y-1.5">
            {last.map((s) => {
              const sc = s.score ?? 0;
              const tone = scoreTone(sc);
              return (
                <li key={s.id} className="rounded-lg border border-border/60 bg-card px-3 py-2 flex items-center gap-3">
                  <span className="text-xl" aria-hidden>{s.emoji ?? "🎭"}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{s.title ?? s.scenario_key ?? "Roleplay"}</p>
                    <p className="text-[11px] text-muted-foreground">{fmtDate(s.ended_at)}</p>
                  </div>
                  <span className={cn("text-sm font-bold tabular-nums rounded-full px-2 py-0.5", tone.chip)}>{sc}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Tela 2: chat ───────────────────────────────────────────────────────────

function ChatScreen({
  scenario, messages, turns, maxTurns, ended, isSending, isFinishing, onSend, onFinish, onBack,
}: {
  scenario: RoleplayScenarioMeta;
  messages: RoleplayMessage[];
  turns: number;
  maxTurns: number;
  ended: boolean;
  isSending: boolean;
  isFinishing: boolean;
  onSend: (text: string) => Promise<boolean>;
  onFinish: () => void;
  onBack: () => void;
}) {
  const reduce = useReducedMotion();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasSpoken = messages.some((m) => m.role === "promotora");
  const busy = isSending || isFinishing;

  // auto-scroll pro fim quando chega mensagem / "digitando…"
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, isSending, reduce]);

  // textarea auto-grow leve
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy || ended) return;
    setText("");
    grow(taRef.current);
    const ok = await onSend(t);
    if (!ok) { setText(t); requestAnimationFrame(() => grow(taRef.current)); }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  return (
    <div className="flex flex-col rounded-xl border border-border/60 bg-card overflow-hidden" style={{ height: "min(72vh, 640px)" }}>
      {/* cabeçalho */}
      <div className="flex items-center gap-2 px-2 py-2 bg-zinc-900 text-white dark:bg-zinc-950">
        <Button variant="ghost" size="icon" className="h-8 w-8 text-white hover:bg-white/10 hover:text-white shrink-0" onClick={onBack} aria-label="Voltar">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="h-9 w-9 rounded-full bg-white/10 flex items-center justify-center text-xl shrink-0" aria-hidden>{scenario.emoji}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight truncate">{scenario.title}</p>
          <p className="text-[11px] text-zinc-300 truncate"><span className="font-medium text-emerald-400">Objetivo:</span> {scenario.objective}</p>
        </div>
        <span className="text-[11px] tabular-nums rounded-full bg-white/10 px-2 py-0.5 shrink-0">rodada {Math.min(turns + (ended ? 0 : 1), maxTurns)}/{maxTurns}</span>
      </div>

      {/* balões */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-zinc-100 dark:bg-zinc-900/60">
        <AnimatePresence initial={false}>
          {messages.map((m, i) => {
            const mine = m.role === "promotora";
            return (
              <motion.div
                key={`${m.at}-${i}`}
                initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.18 }}
                className={cn("flex", mine ? "justify-end" : "justify-start")}
              >
                <div className={cn(
                  "max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-snug whitespace-pre-wrap break-words shadow-sm",
                  mine
                    ? "bg-emerald-600 text-white rounded-br-md"
                    : "bg-white text-zinc-900 rounded-bl-md dark:bg-zinc-800 dark:text-zinc-100",
                )}>
                  {m.text}
                </div>
              </motion.div>
            );
          })}
          {isSending && (
            <motion.div
              key="typing"
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex justify-start"
            >
              <div className="rounded-2xl rounded-bl-md bg-white dark:bg-zinc-800 px-3 py-2 flex items-center gap-1.5 shadow-sm">
                <span className="text-[11px] text-muted-foreground">digitando</span>
                <span className="flex items-center gap-0.5" aria-hidden>
                  {[0, 1, 2].map((d) => (
                    <motion.span
                      key={d}
                      className="h-1.5 w-1.5 rounded-full bg-zinc-400"
                      animate={reduce ? {} : { y: [0, -3, 0], opacity: [0.5, 1, 0.5] }}
                      transition={{ duration: 0.9, repeat: Infinity, delay: d * 0.15 }}
                    />
                  ))}
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {ended && (
          <p className="text-center text-[11px] text-muted-foreground pt-1">O cliente encerrou a conversa. Hora de ver como você foi. 👇</p>
        )}
      </div>

      {/* input + ações */}
      <div className="border-t border-border/60 bg-card p-2 space-y-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            maxLength={600}
            disabled={busy || ended}
            placeholder={ended ? "Conversa encerrada" : "Fala com o cliente…"}
            onChange={(e) => { setText(e.target.value); grow(e.target); }}
            onKeyDown={onKey}
            className="flex-1 resize-none rounded-2xl border border-input bg-background px-3 py-2 text-sm leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 min-h-[40px]"
          />
          <Button
            size="icon"
            aria-label="Enviar"
            disabled={busy || ended || !text.trim()}
            onClick={() => { void send(); }}
            className="h-10 w-10 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <Button
          variant={ended ? "default" : "outline"}
          className={cn("w-full gap-1.5", ended && "bg-emerald-600 hover:bg-emerald-700 text-white")}
          disabled={isFinishing || isSending || !hasSpoken}
          onClick={onFinish}
        >
          {isFinishing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
          {isFinishing ? "Avaliando…" : ended ? "Avaliar conversa" : "Encerrar e avaliar"}
        </Button>
      </div>
    </div>
  );
}

// ─── Tela 3: resultado ──────────────────────────────────────────────────────

const RING = 132;
const RING_STROKE = 11;
const RING_R = (RING - RING_STROKE) / 2;

const CONFETTI = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  x: (Math.sin(i * 12.9898) * 43758.5453) % 1,
  delay: (i % 5) * 0.06,
  size: 5 + (i % 3) * 2,
  rot: (i * 47) % 360,
}));

function Confetti() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden>
      {CONFETTI.map((c) => {
        const dx = (Math.abs(c.x) * 2 - 1) * 110;
        return (
          <motion.span
            key={c.id}
            className={cn("absolute left-1/2 top-1/2 rounded-[2px]", c.id % 2 ? "bg-emerald-500" : "bg-emerald-300")}
            style={{ width: c.size, height: c.size * 1.6 }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
            animate={{ x: dx, y: [0, -60 - (c.id % 4) * 14, 80], opacity: [1, 1, 0], rotate: c.rot + 180, scale: 1 }}
            transition={{ duration: 1.1 + (c.id % 4) * 0.15, delay: c.delay, ease: "easeOut" }}
          />
        );
      })}
    </div>
  );
}

function ResultScreen({
  scenario, score, evaluation, isStarting, onRetry, onOther,
}: {
  scenario: RoleplayScenarioMeta;
  score: number;
  evaluation: RoleplayEvaluation;
  isStarting: boolean;
  onRetry: () => void;
  onOther: () => void;
}) {
  const reduce = useReducedMotion();
  const tone = scoreTone(score);
  const great = score >= 80;
  const circumference = 2 * Math.PI * RING_R;
  const criteria = Array.isArray(evaluation?.criteria) ? evaluation.criteria : [];
  const strengths = Array.isArray(evaluation?.strengths) ? evaluation.strengths : [];
  const improvements = Array.isArray(evaluation?.improvements) ? evaluation.improvements : [];
  const bestLine = (evaluation?.best_line ?? "").trim();
  const nextDrill = (evaluation?.next_drill ?? "").trim();
  const summaryText = (evaluation?.summary ?? "").trim();

  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!great || reduce) return;
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 1600);
    return () => clearTimeout(t);
  }, [great, reduce]);

  const headline = useMemo(() => {
    if (score >= 90) return "Mandou muito bem!";
    if (score >= 80) return "Mandou bem!";
    if (score >= 60) return "Bom caminho — dá pra afiar.";
    return "Vale treinar de novo.";
  }, [score]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border/60 bg-card p-4">
        <p className="text-xs text-muted-foreground text-center">{scenario.emoji} {scenario.title}</p>
        <div className="relative flex flex-col items-center mt-2">
          <AnimatePresence>{celebrate && <Confetti key="confetti" />}</AnimatePresence>
          <motion.div
            className="relative"
            style={{ width: RING, height: RING }}
            initial={reduce ? false : { scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.35 }}
          >
            <svg width={RING} height={RING} viewBox={`0 0 ${RING} ${RING}`} className="-rotate-90">
              <circle cx={RING / 2} cy={RING / 2} r={RING_R} className="stroke-muted" strokeWidth={RING_STROKE} fill="none" />
              <motion.circle
                cx={RING / 2} cy={RING / 2} r={RING_R} fill="none"
                strokeWidth={RING_STROKE} strokeLinecap="round"
                className={tone.stroke}
                strokeDasharray={circumference}
                initial={reduce ? false : { strokeDashoffset: circumference }}
                animate={{ strokeDashoffset: circumference * (1 - Math.max(0, Math.min(100, score)) / 100) }}
                transition={{ duration: reduce ? 0 : 0.9, ease: "easeOut" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p className={cn("text-4xl font-bold tabular-nums leading-none", tone.text)}>{score}</p>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">de 100</p>
            </div>
          </motion.div>
          <p className="mt-3 text-sm font-semibold flex items-center gap-1.5">
            {great && <Trophy className="h-4 w-4 text-emerald-600" />} {headline}
          </p>
          {summaryText && <p className="text-xs text-muted-foreground text-center mt-1">{summaryText}</p>}
        </div>
      </div>

      {criteria.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-3 space-y-3">
          <h3 className="text-sm font-semibold">Critérios</h3>
          {criteria.map((c) => {
            const max = Math.max(1, Number(c.max) || 1);
            const val = Math.max(0, Math.min(max, Number(c.score) || 0));
            const pct = Math.round((val / max) * 100);
            const t = scoreTone(pct);
            return (
              <div key={c.key ?? c.label} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{c.label}</span>
                  <span className="tabular-nums text-muted-foreground">{val}/{max}</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <motion.div
                    className={cn("h-full", t.bar)}
                    initial={reduce ? false : { width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: reduce ? 0 : 0.6, ease: "easeOut" }}
                  />
                </div>
                {c.feedback && <p className="text-xs text-muted-foreground leading-snug">{c.feedback}</p>}
              </div>
            );
          })}
        </div>
      )}

      {strengths.length > 0 && (
        <div className="rounded-xl border border-emerald-200/70 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 p-3">
          <h3 className="text-sm font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5"><Sparkles className="h-4 w-4" /> O que mandou bem</h3>
          <ul className="list-disc pl-4 mt-1.5 space-y-1 text-sm">
            {strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {improvements.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5"><Target className="h-4 w-4" /> Pra melhorar</h3>
          <ul className="list-disc pl-4 mt-1.5 space-y-1 text-sm">
            {improvements.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {bestLine && (
        <div className="rounded-xl bg-zinc-900 text-white dark:bg-zinc-950 p-3">
          <p className="text-[11px] uppercase tracking-wide text-emerald-400 font-semibold">Melhor frase</p>
          <p className="text-sm italic mt-1 leading-relaxed">“{bestLine}”</p>
        </div>
      )}

      {nextDrill && (
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Próximo treino</p>
          <p className="text-sm mt-1 leading-relaxed">{nextDrill}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5" disabled={isStarting} onClick={onRetry}>
          {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Treinar de novo
        </Button>
        <Button variant="outline" disabled={isStarting} onClick={onOther}>Outro cenário</Button>
      </div>
    </div>
  );
}

export default RoleplayChat;
