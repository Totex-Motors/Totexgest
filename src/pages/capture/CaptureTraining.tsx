import { useEffect, useState } from "react";
import { CheckCircle2, Circle, MessageSquareQuote, ShieldQuestion, Handshake, GraduationCap } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { MICRO_LESSONS, QUIZ, SCRIPT_CARDS } from "./captureContent";

/**
 * "Treino" — microaprendizado de campo: aulas de 1–2 min, scripts prontos e
 * quiz rápido. Progresso fica no localStorage nesta fase; vira
 * training_progress (banco) + roleplay com IA na Fase 6.
 */

const DONE_KEY = "captacao:treino:done";

function loadDone(): string[] {
  try { return JSON.parse(localStorage.getItem(DONE_KEY) || "[]"); } catch { return []; }
}

const TAG_ICON = { Abordagem: MessageSquareQuote, Objeção: ShieldQuestion, Fechamento: Handshake } as const;

export default function CaptureTraining() {
  const [done, setDone] = useState<string[]>(loadDone);
  const [openLesson, setOpenLesson] = useState<string | null>(null);
  const [quizAnswers, setQuizAnswers] = useState<Record<number, number>>({});

  useEffect(() => {
    try { localStorage.setItem(DONE_KEY, JSON.stringify(done)); } catch { /* ignore */ }
  }, [done]);

  const toggle = (id: string) =>
    setDone((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const pct = Math.round((done.length / MICRO_LESSONS.length) * 100);
  const quizScore = QUIZ.filter((q, i) => quizAnswers[i] === q.answer).length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">Treino</h1>
        <p className="text-xs text-muted-foreground">Aulas curtas pra usar hoje no corredor.</p>
      </div>

      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-medium flex items-center gap-1.5"><GraduationCap className="h-4 w-4" /> Trilha Captação Totex</span>
            <span className="text-xs text-muted-foreground tabular-nums">{done.length}/{MICRO_LESSONS.length}</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          {pct === 100 && <p className="text-xs text-emerald-700 mt-1.5">Trilha concluída — selo “Captação Totex” liberado 🏅</p>}
        </CardContent>
      </Card>

      <Tabs defaultValue="aulas">
        <TabsList className="grid grid-cols-3 w-full">
          <TabsTrigger value="aulas">Aulas</TabsTrigger>
          <TabsTrigger value="scripts">Scripts</TabsTrigger>
          <TabsTrigger value="quiz">Quiz</TabsTrigger>
        </TabsList>

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
                      <Button size="sm" variant={isDone ? "outline" : "default"} onClick={() => toggle(l.id)}>
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
