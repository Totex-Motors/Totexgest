import { useEffect, useState } from "react";
import { CheckCircle2, Circle, MessageSquareQuote, ShieldQuestion, Handshake, GraduationCap, Bot } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useMarkLesson, useTrainingSummary } from "@/hooks/useCaptureRoleplay";
import { RoleplayChat } from "@/components/capture/RoleplayChat";
import { MICRO_LESSONS, QUIZ, SCRIPT_CARDS } from "./captureContent";

/**
 * "Treino" — roleplay com IA, microaulas de 1–2 min, scripts prontos e quiz.
 * Progresso das aulas vive no servidor (capture_training_progress via RPC);
 * o localStorage fica só como espelho/fallback offline.
 */

const DONE_KEY = "captacao:treino:done";

function loadDone(): string[] {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || "[]"); } catch { return []; }
}

const TAG_ICON = { Abordagem: MessageSquareQuote, Objeção: ShieldQuestion, Fechamento: Handshake } as const;

export default function CaptureTraining() {
  const summary = useTrainingSummary();
  const markLesson = useMarkLesson();
  const [localDone, setLocalDone] = useState<string[]>(loadDone);
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});

  // fonte: servidor; fallback: espelho local (offline / erro)
  const done = summary.data?.lessons_done ?? localDone;

  useEffect(() => {
    if (!summary.data) return;
    setLocalDone(summary.data.lessons_done);
    try { localStorage.setItem(DONE_KEY, JSON.stringify(summary.data.lessons_done)); } catch { /* ignore */ }
  }, [summary.data]);

  const toggle = (id: string) => {
    const next = !done.includes(id);
    setLocalDone((prev) => (next ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)));
    markLesson.mutate(
      { lessonId: id, done: next },
      { onError: (e) => toast.error(`Não consegui salvar o progresso: ${(e as Error).message}`) },
    );
  };

  const total = MICRO_LESSONS.length;
  const doneCount = MICRO_LESSONS.filter((l) => done.includes(l.id)).length;
  const pct = Math.round((doneCount / total) * 100);
  const quizScore = QUIZ.filter((q, i) => quizAnswers[i] === q.answer).length;
  const roleplays = summary.data?.roleplays ?? 0;
  const avg = summary.data?.avg_score;
  const best = summary.data?.best_score;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">Treino</h1>
        <p className="text-xs text-muted-foreground">Aulas curtas e roleplay com IA pra usar hoje no corredor.</p>
      </div>

      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium flex items-center gap-1.5"><GraduationCap className="h-4 w-4" /> Trilha Captação Totex</span>
            <span className="text-xs text-muted-foreground tabular-nums">{doneCount}/{total}</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          {pct === 100 && <p className="text-xs text-emerald-700 mt-1.5">Trilha concluída — selo “Captação Totex” liberado 🏅</p>}
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5 tabular-nums">
            <Bot className="h-3.5 w-3.5 text-emerald-600" />
            Roleplays: <strong className="text-foreground">{roleplays}</strong>
            {roleplays > 0 && (
              <>
                {" · "}média <strong className="text-foreground">{avg ?? "—"}</strong>
                {" · "}melhor <strong className="text-foreground">{best ?? "—"}</strong>
              </>
            )}
          </p>
          {summary.isError && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-1">Sem conexão com o servidor — mostrando progresso salvo no aparelho.</p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="roleplay">
        <TabsList className="grid grid-cols-4 w-full">
          <TabsTrigger value="roleplay">Roleplay</TabsTrigger>
          <TabsTrigger value="aulas">Aulas</TabsTrigger>
          <TabsTrigger value="scripts">Scripts</TabsTrigger>
          <TabsTrigger value="quiz">Quiz</TabsTrigger>
        </TabsList>

        <TabsContent value="roleplay" className="mt-3">
          <RoleplayChat />
        </TabsContent>

        <TabsContent value="aulas" className="space-y-2 mt-3">
          {MICRO_LESSONS.map((l) => {
            const isDone = done.includes(l.id);
            const isOpen = openLesson === l.id;
            return (
              <Card key={l.id} className={cn(isDone && "border-emerald-200/70")}>
                <CardContent className="pt-3 pb-3">
                  <button type="button" className="w-full text-left flex items-start gap-2" onClick={() => setOpenLesson(isOpen ? null : l.id)}>
                    {isDone ? <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" /> : <Circle className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{l.title}</p>
                      <p className="text-xs text-muted-foreground">{l.minutes} min · {l.summary}</p>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="mt-3 pl-7 space-y-3">
                      <ul className="list-disc pl-4 space-y-1 text-sm">
                        {l.bullets.map((b) => <li key={b}>{b}</li>)}
                      </ul>
                      <Button size="sm" variant={isDone ? "outline" : "default"} disabled={markLesson.isPending} onClick={() => toggle(l.id)}>
                        {isDone ? "Desmarcar" : "Concluí esta aula"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="scripts" className="space-y-2 mt-3">
          {SCRIPT_CARDS.map((s) => {
            const Icon = TAG_ICON[s.tag];
            return (
              <Card key={s.title}>
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="text-[10px] gap-1"><Icon className="h-3 w-3" /> {s.tag}</Badge>
                    <span className="text-xs font-medium truncate">{s.title}</span>
                  </div>
                  <p className="text-sm leading-relaxed">“{s.text}”</p>
                </CardContent>
              </Card>
            );
          })}
        </TabsContent>

        <TabsContent value="quiz" className="space-y-3 mt-3">
          {QUIZ.map((q, i) => {
            const chosen = quizAnswers[i];
            return (
              <Card key={q.q}>
                <CardContent className="pt-3 pb-3 space-y-2">
                  <p className="text-sm font-medium">{i + 1}. {q.q}</p>
                  <div className="space-y-1.5">
                    {q.options.map((o, oi) => {
                      const state = chosen == null ? "idle" : oi === q.answer ? "right" : chosen === oi ? "wrong" : "idle";
                      return (
                        <button
                          key={o}
                          type="button"
                          disabled={chosen != null}
                          onClick={() => setQuizAnswers({ ...quizAnswers, [i]: oi })}
                          className={cn(
                            "w-full text-left text-sm rounded-md border px-3 py-2",
                            state === "right" && "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40",
                            state === "wrong" && "border-red-400 bg-red-50 dark:bg-red-950/40",
                            state === "idle" && "border-input",
                          )}
                        >
                          {o}
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {Object.keys(quizAnswers).length === QUIZ.length && (
            <p className="text-sm text-center font-medium">
              Você acertou {quizScore}/{QUIZ.length}. {quizScore === QUIZ.length ? "Mandou bem! 🎯" : "Revise as aulas e tente de novo."}
            </p>
          )}
          {Object.keys(quizAnswers).length > 0 && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setQuizAnswers({})}>Refazer quiz</Button>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
