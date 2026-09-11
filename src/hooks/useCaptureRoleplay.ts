import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

/**
 * Treino da promotora: cenários de roleplay, resumo de progresso (aulas +
 * roleplays) e a máquina de estado de uma sessão de roleplay com a IA.
 * A conversa roda na edge function `capture-roleplay` (JWT vai sozinho no
 * invoke); o progresso das aulas passa pelas RPCs SECURITY DEFINER
 * (migration 20260911120000_captacao_roleplay).
 */

// ─── Tipos ──────────────────────────────────────────────────────────────────

export type RoleplayDifficulty = "facil" | "medio" | "dificil";

export const ROLEPLAY_DIFFICULTY_META: Record<RoleplayDifficulty, { label: string; cls: string }> = {
  facil: { label: "Fácil", cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900" },
  medio: { label: "Médio", cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900" },
  dificil: { label: "Difícil", cls: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900" },
};

/** capture_roleplay_scenarios (select direto — só colunas visíveis pra promotora) */
export interface RoleplayScenario {
  id: string;
  key: string;
  title: string;
  emoji: string;
  difficulty: RoleplayDifficulty;
  summary: string;
  objective: string;
  max_turns: number;
  position: number;
}

export interface RoleplayMessage {
  role: "cliente" | "promotora";
  text: string;
  at: string;
}

export interface RoleplayCriterion {
  key: string;
  label: string;
  score: number;
  max: number;
  feedback: string;
}

export interface RoleplayEvaluation {
  score: number;
  criteria: RoleplayCriterion[];
  strengths: string[];
  improvements: string[];
  best_line?: string | null;
  next_drill?: string | null;
  summary?: string | null;
}

export interface RoleplayResult {
  score: number;
  evaluation: RoleplayEvaluation;
  messages: RoleplayMessage[];
}

/** Retorno de capture_training_summary() */
export interface TrainingSummary {
  lessons_done: string[];
  roleplays: number;
  avg_score: number | null;
  best_score: number | null;
  last_sessions: {
    id: string;
    scenario_key: string | null;
    score: number | null;
    ended_at: string | null;
    title: string | null;
    emoji: string | null;
  }[];
}

export const trainingKeys = {
  scenarios: ["capture", "roleplay", "scenarios"] as const,
  summary: ["capture", "training", "summary"] as const,
};

// ─── Chamada à edge function com extração da mensagem de erro ───────────────

type InvokeBody =
  | { action: "start"; scenario_id: string }
  | { action: "reply"; session_id: string; message: string }
  | { action: "finish"; session_id: string }
  | { action: "abandon"; session_id: string };

async function invokeRoleplay<T>(body: InvokeBody): Promise<T> {
  const { data, error } = await supabase.functions.invoke("capture-roleplay", { body });
  if (error) {
    let msg = error.message || "Falha ao falar com o treino.";
    // FunctionsHttpError guarda a Response em `context` — o corpo tem { error }
    const ctx = (error as { context?: unknown }).context;
    if (typeof Response !== "undefined" && ctx instanceof Response) {
      try {
        const j = await ctx.clone().json();
        if (j && typeof j.error === "string" && j.error) msg = j.error;
      } catch { /* corpo não é JSON — fica a mensagem padrão */ }
    }
    throw new Error(msg);
  }
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

// ─── Queries ────────────────────────────────────────────────────────────────

export function useRoleplayScenarios() {
  return useQuery({
    queryKey: trainingKeys.scenarios,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("capture_roleplay_scenarios")
        .select("id, key, title, emoji, difficulty, summary, objective, max_turns, position")
        .eq("is_active", true)
        .order("position", { ascending: true });
      if (error) throw error;
      return (data ?? []) as RoleplayScenario[];
    },
    staleTime: 5 * 60_000,
  });
}

export function useTrainingSummary() {
  return useQuery({
    queryKey: trainingKeys.summary,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("capture_training_summary");
      if (error) throw error;
      const raw = (data ?? {}) as Partial<TrainingSummary>;
      const out: TrainingSummary = {
        lessons_done: Array.isArray(raw.lessons_done) ? raw.lessons_done : [],
        roleplays: Number(raw.roleplays ?? 0),
        avg_score: raw.avg_score == null ? null : Number(raw.avg_score),
        best_score: raw.best_score == null ? null : Number(raw.best_score),
        last_sessions: Array.isArray(raw.last_sessions) ? raw.last_sessions : [],
      };
      return out;
    },
    staleTime: 15_000,
  });
}

/** Marca/desmarca uma aula (otimista no summary; reverte se a RPC falhar). */
export function useMarkLesson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ lessonId, done, score }: { lessonId: string; done: boolean; score?: number | null }) => {
      const { error } = await supabase.rpc("capture_training_mark_lesson", {
        p_lesson_id: lessonId,
        p_done: done,
        p_score: score ?? null,
      });
      if (error) throw error;
    },
    onMutate: async ({ lessonId, done }) => {
      await qc.cancelQueries({ queryKey: trainingKeys.summary });
      const prev = qc.getQueryData<TrainingSummary>(trainingKeys.summary);
      if (prev) {
        const set = new Set(prev.lessons_done);
        if (done) set.add(lessonId); else set.delete(lessonId);
        qc.setQueryData<TrainingSummary>(trainingKeys.summary, { ...prev, lessons_done: [...set] });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(trainingKeys.summary, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: trainingKeys.summary });
    },
  });
}

// ─── Sessão de roleplay ─────────────────────────────────────────────────────

export type RoleplayPhase = "idle" | "chat" | "result";

export interface RoleplayScenarioMeta {
  id: string;
  title: string;
  emoji: string;
  objective: string;
}

interface StartResponse {
  session_id: string;
  messages: RoleplayMessage[];
  max_turns: number;
  scenario: { title: string; emoji: string; objective: string };
}

interface ReplyResponse {
  reply: string;
  ended: boolean;
  turns: number;
  max_turns: number;
}

export function useRoleplay() {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<RoleplayPhase>("idle");
  const [scenario, setScenario] = useState<RoleplayScenarioMeta | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RoleplayMessage[]>([]);
  const [turns, setTurns] = useState(0);
  const [maxTurns, setMaxTurns] = useState(8);
  const [ended, setEnded] = useState(false);
  const [result, setResult] = useState<RoleplayResult | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);

  // refs pra saber, no unmount, se ainda há sessão ativa (sem closure velha)
  const sessionRef = useRef<string | null>(null);
  const phaseRef = useRef<RoleplayPhase>("idle");
  sessionRef.current = sessionId;
  phaseRef.current = phase;

  const reset = useCallback(() => {
    setPhase("idle");
    setScenario(null);
    setSessionId(null);
    setMessages([]);
    setTurns(0);
    setEnded(false);
    setResult(null);
  }, []);

  const start = useCallback(async (sc: RoleplayScenarioMeta) => {
    setIsStarting(true);
    try {
      const res = await invokeRoleplay<StartResponse>({ action: "start", scenario_id: sc.id });
      setScenario({
        id: sc.id,
        title: res.scenario?.title ?? sc.title,
        emoji: res.scenario?.emoji ?? sc.emoji,
        objective: res.scenario?.objective ?? sc.objective,
      });
      setSessionId(res.session_id);
      setMessages(res.messages ?? []);
      setMaxTurns(res.max_turns || 8);
      setTurns(0);
      setEnded(false);
      setResult(null);
      setPhase("chat");
      return res;
    } finally {
      setIsStarting(false);
    }
  }, []);

  const reply = useCallback(async (text: string) => {
    const sid = sessionRef.current;
    const clean = text.trim();
    if (!sid || !clean) return;
    const mine: RoleplayMessage = { role: "promotora", text: clean, at: new Date().toISOString() };
    setMessages((m) => [...m, mine]);
    setIsSending(true);
    try {
      const res = await invokeRoleplay<ReplyResponse>({ action: "reply", session_id: sid, message: clean });
      setMessages((m) => [...m, { role: "cliente", text: res.reply, at: new Date().toISOString() }]);
      setTurns(res.turns);
      if (res.max_turns) setMaxTurns(res.max_turns);
      setEnded(!!res.ended);
      return res;
    } catch (e) {
      // tira o balão otimista — a promotora recebe o texto de volta no input
      setMessages((m) => m.filter((x) => x !== mine));
      throw e;
    } finally {
      setIsSending(false);
    }
  }, []);

  const finish = useCallback(async () => {
    const sid = sessionRef.current;
    if (!sid) return;
    setIsFinishing(true);
    try {
      const res = await invokeRoleplay<RoleplayResult>({ action: "finish", session_id: sid });
      setResult(res);
      if (Array.isArray(res.messages) && res.messages.length) setMessages(res.messages);
      setEnded(true);
      setPhase("result");
      qc.invalidateQueries({ queryKey: trainingKeys.summary });
      return res;
    } finally {
      setIsFinishing(false);
    }
  }, [qc]);

  const abandon = useCallback(async () => {
    const sid = sessionRef.current;
    const wasChat = phaseRef.current === "chat";
    reset();
    if (!sid || !wasChat) return;
    try { await invokeRoleplay({ action: "abandon", session_id: sid }); } catch { /* best-effort */ }
  }, [reset]);

  // Saiu da tela no meio da conversa (troca de aba, etc.) → abandona no servidor.
  useEffect(() => {
    return () => {
      const sid = sessionRef.current;
      if (sid && phaseRef.current === "chat") {
        invokeRoleplay({ action: "abandon", session_id: sid }).catch(() => { /* best-effort */ });
      }
    };
  }, []);

  return {
    phase, scenario, sessionId, messages, turns, maxTurns, ended, result,
    isStarting, isSending, isFinishing,
    start, reply, finish, abandon, reset,
  };
}
