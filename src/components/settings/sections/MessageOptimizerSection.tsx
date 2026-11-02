import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Activity, Loader2, Play, FlaskConical, Pause, CheckCircle2, Lightbulb, AlertTriangle } from "lucide-react";

/**
 * Otimizador de conversas: mede cada ponto de contato do WhatsApp oficial, mostra as variantes
 * em teste (A/B automático) e o relatório diário do agente (diagnóstico, hipóteses, propostas).
 * Propostas viram template na Meta com um clique (entram na rotação quando a Meta aprovar).
 */
type Touch = { tipo: string; rotulo: string; enviadas: number; contatos: number; entregues: number; lidas: number; falhas: number; erro_principal: string | null; respondidas_48h: number; taxa_resposta: number };
type Variant = { id: string; touchpoint: string; name: string; kind: string; body: string | null; buttons: { text: string }[]; status: string; origem: string; rationale: string | null };
type VStat = { variant_id: string; enviadas: number; respondidas: number; permitiram: number; taxa: number };
type Run = { id: string; run_at: string; period_days: number; model: string | null; actions_taken: string[]; report: { diagnostico?: string; hipoteses?: string[]; acoes?: string[]; propostas?: { touchpoint: string; name: string; hipotese: string; body: string; buttons: string[]; params_hint?: string }[]; prompt_sugestoes?: string[]; proximo_passo?: string; erro?: string } };
type Stats = { funil: { contatos: number; abordados: number; abordados_responderam: number; iniciados_pelo_cliente: number; conversas_3mais: number; continuidade_pct: number } | null; touchpoints: Touch[]; variantes: Variant[]; variantes_stats: VStat[]; runs: Run[]; touchpoint_labels: Record<string, string> };

async function call<T = any>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("message-optimizer", { body: { action, ...extra } });
  if (error) { let m = "Falha no servidor."; try { const d = await error.context?.json(); if (d?.error) m = d.error; } catch { /* offline */ } throw new Error(m); }
  if (data?.error) throw new Error(data.error);
  return data as T;
}

const STATUS_PT: Record<string, string> = { active: "ativa", submitted: "aguardando Meta", paused: "pausada", proposed: "proposta", rejected: "rejeitada" };

export function MessageOptimizerSection() {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["message-optimizer", days], queryFn: () => call<Stats>("stats", { days }), staleTime: 60_000 });
  const run = useMutation({
    mutationFn: () => call("run", { days: Math.min(days, 30) }),
    onSuccess: (r: any) => { toast.success("Análise concluída", { description: (r.acoes || []).join("; ") || "Relatório novo abaixo." }); qc.invalidateQueries({ queryKey: ["message-optimizer"] }); },
    onError: (e: Error) => toast.error("Não rodou", { description: e.message }),
  });
  const approve = useMutation({
    mutationFn: (a: { run_id: string; proposal_index: number }) => call("approve", a),
    onSuccess: (r: any) => { toast.success("Template enviado pra Meta", { description: `Status: ${r.meta_status}. Entra na rotação quando aprovar.` }); qc.invalidateQueries({ queryKey: ["message-optimizer"] }); },
    onError: (e: Error) => toast.error("Meta recusou", { description: e.message }),
  });
  const setStatus = useMutation({
    mutationFn: (a: { variant_id: string; status: string }) => call("set_status", a),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["message-optimizer"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const s = q.data;
  const f = s?.funil;
  const vstat = new Map((s?.variantes_stats || []).map((v) => [v.variant_id, v]));
  const ultimo = s?.runs?.[0];
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "—");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2"><Activity className="h-5 w-5 text-primary" /> Otimizador de conversas</h2>
          <p className="text-sm text-muted-foreground">Mede quem a gente aborda, quem responde e onde a conversa morre. Testa variantes de mensagem sozinho e propõe novas todo dia.</p>
        </div>
        <div className="flex items-center gap-2">
          {[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? "default" : "outline"} onClick={() => setDays(d)}>{d} dias</Button>)}
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />} Rodar análise agora</Button>
        </div>
      </div>

      {q.isLoading && <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Calculando…</p>}
      {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

      {f && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {[
            ["Contatos no período", f.contatos, null],
            ["Abordados por nós", f.abordados, null],
            ["Abordados que responderam", f.abordados_responderam, pct(f.abordados_responderam, f.abordados)],
            ["Conversas com 3+ msgs do cliente", f.conversas_3mais, pct(f.conversas_3mais, f.contatos)],
            ["Continuidade após resposta do agente", `${f.continuidade_pct ?? 0}%`, null],
          ].map(([l, n, sub]) => (
            <Card key={String(l)}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{l}</p><p className="text-2xl font-bold">{n as any}</p>{sub && <p className="text-xs text-muted-foreground">{sub as string}</p>}</CardContent></Card>
          ))}
        </div>
      )}

      {s && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Por ponto de contato (número oficial)</CardTitle></CardHeader>
          <CardContent>
            <Table>
              <TableHeader><TableRow><TableHead>Mensagem</TableHead><TableHead className="text-right">Enviadas</TableHead><TableHead className="text-right">Entregues</TableHead><TableHead className="text-right">Falhas</TableHead><TableHead className="text-right">Respondidas 48h</TableHead><TableHead className="text-right">Taxa</TableHead></TableRow></TableHeader>
              <TableBody>
                {s.touchpoints.map((t) => (
                  <TableRow key={t.tipo}>
                    <TableCell><div className="font-medium">{t.rotulo}</div>{t.falhas > 0 && t.erro_principal && <div className="text-[11px] text-destructive flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {t.erro_principal}</div>}</TableCell>
                    <TableCell className="text-right">{t.enviadas}</TableCell>
                    <TableCell className="text-right">{t.entregues}</TableCell>
                    <TableCell className={`text-right ${t.falhas ? "text-destructive font-medium" : ""}`}>{t.falhas}</TableCell>
                    <TableCell className="text-right">{t.respondidas_48h}</TableCell>
                    <TableCell className="text-right font-semibold">{t.taxa_resposta}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-[11px] text-muted-foreground mt-2">"Falhas" com "Re-engagement message" = texto livre fora da janela de 24 h (a Meta não entrega; só template aprovado). "Respondidas" = cliente mandou algo em até 48 h.</p>
          </CardContent>
        </Card>
      )}

      {s && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><FlaskConical className="h-4 w-4" /> Variantes em teste</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {s.variantes.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma variante ainda. Rode a análise e aprove uma proposta.</p>}
            {s.variantes.map((v) => {
              const st = vstat.get(v.id);
              return (
                <div key={v.id} className="rounded-lg border p-3 flex flex-col md:flex-row md:items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{s.touchpoint_labels[v.touchpoint] || v.touchpoint}</span><span className="font-medium">{v.name}</span><Badge variant={v.status === "active" ? "default" : "secondary"} className="text-[10px]">{STATUS_PT[v.status] || v.status}</Badge>{v.origem === "otimizador" && <Badge variant="outline" className="text-[10px]">IA</Badge>}</div>
                    {v.body && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{v.body}{v.buttons?.length ? ` · botões: ${v.buttons.map((b) => b.text).join(" / ")}` : ""}</p>}
                    {v.rationale && <p className="text-[11px] text-muted-foreground italic">{v.rationale}</p>}
                  </div>
                  <div className="text-sm text-right md:w-44">{st ? <><b>{st.taxa}%</b> <span className="text-muted-foreground">({st.respondidas}/{st.enviadas}{st.permitiram ? `, ${st.permitiram} permitiram` : ""})</span></> : <span className="text-muted-foreground">sem envios</span>}</div>
                  <div className="flex gap-1">
                    {v.status === "active" && <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ variant_id: v.id, status: "paused" })}><Pause className="h-3.5 w-3.5" /></Button>}
                    {(v.status === "paused" || v.status === "submitted") && <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ variant_id: v.id, status: "active" })}><CheckCircle2 className="h-3.5 w-3.5" /></Button>}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {ultimo && (
        <Card className="border-violet-300/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-2"><Lightbulb className="h-4 w-4 text-violet-600" /> Relatório do agente · {new Date(ultimo.run_at).toLocaleString("pt-BR")} · {ultimo.period_days} dias</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {ultimo.report.erro && <p className="text-destructive">{ultimo.report.erro}</p>}
            {ultimo.report.diagnostico && <p>{ultimo.report.diagnostico}</p>}
            {!!ultimo.actions_taken?.length && <p className="text-xs text-muted-foreground">Ações automáticas: {ultimo.actions_taken.join("; ")}</p>}
            {!!ultimo.report.hipoteses?.length && <div><p className="font-medium text-xs text-muted-foreground mb-1">Hipóteses</p><ul className="list-disc pl-5 space-y-0.5">{ultimo.report.hipoteses.map((h, i) => <li key={i}>{h}</li>)}</ul></div>}
            {!!ultimo.report.acoes?.length && <div><p className="font-medium text-xs text-muted-foreground mb-1">Ações imediatas</p><ul className="list-disc pl-5 space-y-0.5">{ultimo.report.acoes.map((h, i) => <li key={i}>{h}</li>)}</ul></div>}
            {!!ultimo.report.propostas?.length && (
              <div className="space-y-2">
                <p className="font-medium text-xs text-muted-foreground">Propostas de variante (viram template na Meta com um clique)</p>
                {ultimo.report.propostas.map((p, i) => {
                  const ja = s?.variantes.some((v) => v.name === String(p.name).toLowerCase().replace(/[^a-z0-9_]/g, "_"));
                  return (
                    <div key={i} className="rounded-lg border p-3 space-y-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{s?.touchpoint_labels[p.touchpoint] || p.touchpoint}</span><span className="font-medium">{p.name}</span>{ja && <Badge variant="secondary" className="text-[10px]">já criada</Badge>}</div>
                      <p className="whitespace-pre-wrap">{p.body}</p>
                      {!!p.buttons?.length && <p className="text-xs text-muted-foreground">Botões: {p.buttons.join(" / ")}</p>}
                      <p className="text-xs italic text-muted-foreground">Testa: {p.hipotese}</p>
                      {!ja && <Button size="sm" onClick={() => approve.mutate({ run_id: ultimo.id, proposal_index: i })} disabled={approve.isPending}>{approve.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null} Aprovar e criar na Meta</Button>}
                    </div>
                  );
                })}
              </div>
            )}
            {!!ultimo.report.prompt_sugestoes?.length && <div><p className="font-medium text-xs text-muted-foreground mb-1">Sugestões pro prompt do agente</p><ul className="list-disc pl-5 space-y-0.5">{ultimo.report.prompt_sugestoes.map((h, i) => <li key={i}>{h}</li>)}</ul></div>}
            {ultimo.report.proximo_passo && <p className="text-xs"><b>Próximo passo:</b> {ultimo.report.proximo_passo}</p>}
          </CardContent>
        </Card>
      )}
      {s && s.runs.length === 0 && <p className="text-sm text-muted-foreground">O agente roda todo dia às 7h40. Clique em "Rodar análise agora" pra ver o primeiro relatório.</p>}
    </div>
  );
}
