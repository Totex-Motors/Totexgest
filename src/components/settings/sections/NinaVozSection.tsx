import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PhoneCall, Check, X, Loader2, Sparkles, Link2, FlaskConical, ExternalLink, GraduationCap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Nina — Ligações (módulo de ligação): a IA atende a LIGAÇÃO do WhatsApp oficial.
 * Caminho: Meta → WaVoIP (dispositivo OFFICIAL) → ElevenLabs Agent → Totexgest.
 * Tudo configurado por botão via edge fn `voice-agent-setup` (só superadmin).
 * Guia: docs/NINA-VOZ.md
 */

interface Learning {
  id: string; regra: string; categoria: string | null; evidencia: string | null; ultima_evidencia: string | null;
  vezes: number; status: "pendente" | "aprovada" | "rejeitada"; created_at: string; aprovada_em: string | null;
}

interface Status {
  keys: Record<string, boolean>;
  numero_oficial: string | null;
  voz: { voice_id: string | null; provider: string | null; agente: string | null };
  eleven: { agent_id: string | null; phone_number_id: string | null; tool_ids: Record<string, string>; provisioned_at: string | null };
  wavoip: { device_id: string | null; linked_at: string | null; sip_at: string | null; webhook_at: string | null };
  outbound: {
    enabled: boolean; sources: string; delay_min: number; trunk_configured_at: string | null; sip_user: string | null;
    hora_inicio: number; hora_fim: number; dias: string;
    queue: { counts: Record<string, number>; recent: { id: string; lead_id: string; lead_name: string | null; phone: string; playbook: string | null; reason: string | null; status: string; scheduled_for: string; attempts: number; outcome: string | null; last_error: string | null; created_at: string }[] };
  };
  prompt: string;
  first_message: string;
  urls: { tools: string; postcall: string; wavoip_webhook: string };
}

async function callSetup<T = any>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("voice-agent-setup", { body });
  if (error) {
    // supabase-js esconde o corpo do erro; tenta ler
    const ctx = (error as any)?.context;
    let msg = error.message;
    try { const j = await ctx?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

function Row({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <Check className="h-4 w-4 text-emerald-600 mt-0.5" /> : <X className="h-4 w-4 text-red-500 mt-0.5" />}
      <div>
        <span className={cn(ok ? "text-foreground" : "text-muted-foreground")}>{label}</span>
        {!ok && hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function NinaVozSection() {
  const qc = useQueryClient();
  const { data: st, isLoading, error } = useQuery<Status>({ queryKey: ["nina-voz-status"], queryFn: () => callSetup<Status>({ action: "status" }) });
  const [prompt, setPrompt] = useState<string | null>(null);
  const [firstMsg, setFirstMsg] = useState<string | null>(null);
  const [wavoipEmail, setWavoipEmail] = useState("");
  const [wavoipPass, setWavoipPass] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [sipUser, setSipUser] = useState("");
  const [sipPass, setSipPass] = useState("");
  const [sources, setSources] = useState<string | null>(null);
  const [delayMin, setDelayMin] = useState<number | null>(null);
  const [horaIni, setHoraIni] = useState<number | null>(null);
  const [horaFim, setHoraFim] = useState<number | null>(null);
  const [dias, setDias] = useState<string | null>(null);
  const [testLead, setTestLead] = useState("");

  const outboundTrunk = useMutation({
    mutationFn: () => callSetup({ action: "eleven_outbound", sip_user: sipUser, sip_password: sipPass }),
    onSuccess: () => { setSipPass(""); toast.success("Tronco de saída configurado na ElevenLabs."); qc.invalidateQueries({ queryKey: ["nina-voz-status"] }); },
    onError: (e: Error) => toast.error("Tronco de saída", { description: e.message }),
  });
  const setOutbound = useMutation({
    mutationFn: (patch: Record<string, unknown>) => callSetup({ action: "set_outbound", ...patch }),
    onSuccess: () => { toast.success("Salvo."); qc.invalidateQueries({ queryKey: ["nina-voz-status"] }); },
    onError: (e: Error) => toast.error("Não salvou", { description: e.message }),
  });
  const metaDiag = useMutation({
    mutationFn: () => callSetup({ action: "meta_diag", phone: testLead.trim().match(/^\+?\d{10,15}$/) ? testLead.trim() : undefined }),
    onSuccess: (r: any) => { setLog([`Diagnóstico Meta: ${JSON.stringify(r, null, 2)}`]); toast.success("Diagnóstico da Meta no registro abaixo."); },
    onError: (e: Error) => toast.error("Diagnóstico Meta", { description: e.message }),
  });
  const enqueue = useMutation({
    mutationFn: () => callSetup({ action: "enqueue_test", lead_id: testLead.trim() }),
    onSuccess: () => { toast.success("Ligação enfileirada. O discador roda a cada 2 min no horário comercial."); qc.invalidateQueries({ queryKey: ["nina-voz-status"] }); },
    onError: (e: Error) => toast.error("Não enfileirou", { description: e.message }),
  });

  const provision = useMutation({
    mutationFn: () => callSetup({ action: "eleven_provision", prompt: prompt ?? st?.prompt, first_message: firstMsg ?? st?.first_message }),
    onSuccess: (r: any) => { setLog(r.log || []); toast.success("Nina criada/atualizada na ElevenLabs."); qc.invalidateQueries({ queryKey: ["nina-voz-status"] }); },
    onError: (e: Error) => toast.error("ElevenLabs", { description: e.message }),
  });
  const wavoip = useMutation({
    mutationFn: () => callSetup({ action: "wavoip_setup", email: wavoipEmail, password: wavoipPass }),
    onSuccess: (r: any) => { setLog(r.log || []); setWavoipPass(""); toast[r.ok ? "success" : "warning"](r.ok ? "WaVoIP configurada." : "WaVoIP: parte falhou, veja o registro."); qc.invalidateQueries({ queryKey: ["nina-voz-status"] }); },
    onError: (e: Error) => toast.error("WaVoIP", { description: e.message }),
  });
  const test = useMutation({
    mutationFn: () => callSetup({ action: "test_tools" }),
    onSuccess: (r: any) => toast[r.ok ? "success" : "error"](r.ok ? `Ferramentas OK: ${r.data?.texto || "respondeu"}` : `Falhou (${r.status}): ${r.error || JSON.stringify(r.data)}`),
    onError: (e: Error) => toast.error("Teste", { description: e.message }),
  });

  // O que a Nina aprendeu: lições propostas pelo treinador depois de cada ligação (nina_learnings)
  const learnings = useQuery<Learning[]>({
    queryKey: ["nina-learnings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("nina_learnings")
        .select("id, regra, categoria, evidencia, ultima_evidencia, vezes, status, created_at, aprovada_em")
        .neq("status", "rejeitada").order("status", { ascending: false }).order("vezes", { ascending: false }).order("created_at", { ascending: false }).limit(60);
      if (error) throw error;
      return (data || []) as Learning[];
    },
  });
  const setLearning = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "aprovada" | "rejeitada" | "pendente" }) => supabase.rpc("nina_learning_set_status", { p_id: id, p_status: status }).then(({ error }) => { if (error) throw error; }),
    onSuccess: (_r, v) => { toast.success(v.status === "aprovada" ? "Lição aprovada: entra no prompt da Nina em até 2 min." : v.status === "rejeitada" ? "Lição descartada." : "Lição voltou pra pendente."); qc.invalidateQueries({ queryKey: ["nina-learnings"] }); },
    onError: (e: Error) => toast.error("Não salvou", { description: e.message }),
  });

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;
  if (error || !st) return <p className="text-sm text-red-600">Não carregou: {(error as Error)?.message || "sem resposta"}. Só superadmin da plataforma vê esta tela.</p>;

  const k = st.keys;
  const elevenOk = !!st.eleven.agent_id && !!st.eleven.phone_number_id;
  const wavoipOk = !!st.wavoip.linked_at && !!st.wavoip.sip_at;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-violet-500/10 text-violet-600"><PhoneCall className="h-5 w-5" /></div>
        <div>
          <h3 className="text-sm font-medium">Nina — Ligações</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-xl">
            A IA atende a ligação de voz do WhatsApp oficial{st.numero_oficial ? ` (+${st.numero_oficial})` : ""}: Meta → WaVoIP → ElevenLabs → Totexgest.
            Os botões abaixo configuram tudo pela API. Ordem: 1 → 2 → 3.
          </p>
        </div>
      </div>

      {/* 0. Pré-requisitos */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Pré-requisitos (Integrações)</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          <Row ok={k.elevenlabs_api_key} label="Chave da ElevenLabs" hint="Integrações › ElevenLabs (voz): chave sk_…" />
          <Row ok={!!st.voz.voice_id} label={`Voz clonada no agente ${st.voz.agente || ""} ${st.voz.voice_id ? `(${st.voz.voice_id})` : ""}`} hint="Agentes IA › agente › Humanização › Responder por áudio › Voice ID" />
          <Row ok={k.whatsapp_cloud_token && k.whatsapp_phone_number_id} label="Token e ID do número oficial (Meta)" hint="Integrações › WhatsApp Cloud" />
          <Row ok={k.openai_api_key} label="Chave da OpenAI (transcrição do áudio no WhatsApp)" />
          <Row ok={k.voice_agent_token} label="Token das ferramentas da Nina" hint="Gerado automaticamente no passo 1." />
          <Row ok={k.webhook_secret} label="Segredo do webhook pós-chamada" hint="Passo 1b: criar na ElevenLabs e colar em Integrações." />
        </CardContent>
      </Card>

      {/* 1. ElevenLabs */}
      <Card className={cn(elevenOk && "border-emerald-300/60")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-600" /> 1. Criar a Nina na ElevenLabs {elevenOk && <Badge variant="outline" className="text-[10px]">pronto</Badge>}</CardTitle>
          <CardDescription className="text-xs">
            Cria (ou atualiza) o agente com a sua voz clonada, as 5 ferramentas do Totexgest e importa o número oficial como tronco SIP.
            Pode clicar de novo sempre que mudar o texto abaixo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-[11px]">Primeira frase</Label>
            <Input value={firstMsg ?? st.first_message} onChange={(e) => setFirstMsg(e.target.value)} className="mt-1 h-9 text-sm" />
          </div>
          <div>
            <Label className="text-[11px]">Como a Nina atende (prompt)</Label>
            <Textarea value={prompt ?? st.prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} className="mt-1 text-sm font-mono" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => provision.mutate()} disabled={provision.isPending || !k.elevenlabs_api_key || !st.voz.voice_id} className="bg-violet-600 hover:bg-violet-700">
              {provision.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
              {elevenOk ? "Atualizar Nina" : "Criar Nina na ElevenLabs"}
            </Button>
            <Button variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
              {test.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />} Testar ferramentas
            </Button>
            {st.eleven.agent_id && (
              <span className="text-xs inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                {/* Rota do painel ElevenAgents: /app/agents/agents/<id>. A lista é o fallback se a rota mudar. */}
                <a className="text-violet-700 underline inline-flex items-center gap-1" href={`https://elevenlabs.io/app/agents/agents/${st.eleven.agent_id}`} target="_blank" rel="noreferrer">
                  abrir a Nina na ElevenLabs <ExternalLink className="h-3 w-3" />
                </a>
                <a className="text-muted-foreground underline inline-flex items-center gap-1" href="https://elevenlabs.io/app/agents" target="_blank" rel="noreferrer">
                  lista de agentes <ExternalLink className="h-3 w-3" />
                </a>
                <code className="text-[10px] text-muted-foreground">{st.eleven.agent_id}</code>
              </span>
            )}
          </div>
          {!k.webhook_secret && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs">
              <p className="font-medium">1b. Webhook pós-chamada (uma vez, na mão)</p>
              <p className="mt-1">Na ElevenLabs: Agents › Settings › <b>Post-call webhooks</b> › Create › URL abaixo, tipo <i>transcription</i>. Copie o secret e cole em Integrações › "Nina (voz) — segredo do webhook".</p>
              <code className="block mt-1 text-[11px] break-all">{st.urls.postcall}</code>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. WaVoIP */}
      <Card className={cn(wavoipOk && "border-emerald-300/60")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><Link2 className="h-4 w-4 text-violet-600" /> 2. Ligar a WaVoIP ao número oficial {wavoipOk && <Badge variant="outline" className="text-[10px]">pronto</Badge>}</CardTitle>
          <CardDescription className="text-xs">
            Precisa de um dispositivo do tipo <b>OFFICIAL</b> na conta WaVoIP. Entro com seu login só para configurar (vincular ao número, apontar o SIP para a ElevenLabs e o webhook). A senha não é guardada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-[11px]">E-mail da conta WaVoIP</Label>
              <Input value={wavoipEmail} onChange={(e) => setWavoipEmail(e.target.value)} className="mt-1 h-9 text-sm" autoComplete="off" />
            </div>
            <div>
              <Label className="text-[11px]">Senha</Label>
              <Input type="password" value={wavoipPass} onChange={(e) => setWavoipPass(e.target.value)} className="mt-1 h-9 text-sm" autoComplete="new-password" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => wavoip.mutate()} disabled={wavoip.isPending || !wavoipEmail || !wavoipPass || !elevenOk} className="bg-violet-600 hover:bg-violet-700">
              {wavoip.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />} Configurar WaVoIP
            </Button>
            {!elevenOk && <span className="text-[11px] text-muted-foreground">Faça o passo 1 antes.</span>}
          </div>
          <div className="grid sm:grid-cols-3 gap-2 text-xs">
            <Row ok={!!st.wavoip.linked_at} label="Vinculado ao número" />
            <Row ok={!!st.wavoip.sip_at} label="SIP → ElevenLabs" />
            <Row ok={!!st.wavoip.webhook_at} label="Webhook de chamadas" />
          </div>
        </CardContent>
      </Card>

      {/* 4. Nina LIGA (saída) */}
      <Card className={cn(st.outbound?.enabled && "border-emerald-300/60")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><PhoneCall className="h-4 w-4 text-violet-600" /> 4. A Nina liga para o cliente {st.outbound?.enabled && <Badge variant="outline" className="text-[10px]">ligado</Badge>}</CardTitle>
          <CardDescription className="text-xs">
            Quando um lead entra (promotora, QR Code, totem), ele entra na fila e a Nina liga no horário comercial. Antes, ela pede a permissão de ligação no WhatsApp (regra da Meta: vale 7 dias).
            Se não atender, manda "tentei te ligar, qual horário?" e o agente de WhatsApp continua. Tudo isso precisa que a migration <code className="text-[10px]">20261011130000_nina_call_queue.sql</code> esteja aplicada.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs font-medium">4a. Tronco de saída: ElevenLabs → WaVoIP {st.outbound?.trunk_configured_at && <Badge variant="outline" className="ml-1 text-[10px]">ok ({st.outbound.sip_user})</Badge>}</p>
            <p className="text-[11px] text-muted-foreground">No painel da WaVoIP › dispositivo TotexMotors › <b>SIP</b>: copie usuário e senha do tronco. A senha vai só para a ElevenLabs.</p>
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div><Label className="text-[11px]">Usuário SIP</Label><Input value={sipUser || st.outbound?.sip_user || ""} onChange={(e) => setSipUser(e.target.value)} className="mt-1 h-9 text-sm" autoComplete="off" /></div>
              <div><Label className="text-[11px]">Senha SIP</Label><Input type="password" value={sipPass} onChange={(e) => setSipPass(e.target.value)} className="mt-1 h-9 text-sm" autoComplete="new-password" /></div>
              <Button variant="outline" onClick={() => { if (!sipUser && st.outbound?.sip_user) setSipUser(st.outbound.sip_user); outboundTrunk.mutate(); }} disabled={outboundTrunk.isPending || !(sipUser || st.outbound?.sip_user) || !sipPass || !elevenOk}>
                {outboundTrunk.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Link2 className="h-4 w-4 mr-1" />} Configurar saída
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium">4b. Ligação automática quando o lead entra</p>
                <p className="text-[11px] text-muted-foreground">Interruptor mestre. Desligado = nada liga, nem o botão manual.</p>
              </div>
              <Button size="sm" variant={st.outbound?.enabled ? "destructive" : "default"} onClick={() => setOutbound.mutate({ enabled: !st.outbound?.enabled })} disabled={setOutbound.isPending || !st.outbound?.trunk_configured_at}>
                {st.outbound?.enabled ? "Desligar" : "Ligar"}
              </Button>
            </div>
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div className="sm:col-span-2">
                <Label className="text-[11px]">Origens que disparam a ligação (separadas por vírgula)</Label>
                <Input value={sources ?? st.outbound?.sources ?? ""} onChange={(e) => setSources(e.target.value)} className="mt-1 h-9 text-sm" />
                <p className="text-[10px] text-muted-foreground mt-1">Lead captado por promotora sempre entra. Ex.: captacao,stand,stand_totex,totem-compra,marketplace</p>
              </div>
              <div>
                <Label className="text-[11px]">Esperar (min) após o lead entrar</Label>
                <Input type="number" min={0} max={1440} value={delayMin ?? st.outbound?.delay_min ?? 10} onChange={(e) => setDelayMin(Number(e.target.value))} className="mt-1 h-9 text-sm" />
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-2 items-end">
              <div>
                <Label className="text-[11px]">Nina liga a partir de (hora)</Label>
                <Input type="number" min={0} max={23} value={horaIni ?? st.outbound?.hora_inicio ?? 10} onChange={(e) => setHoraIni(Number(e.target.value))} className="mt-1 h-9 text-sm" />
              </div>
              <div>
                <Label className="text-[11px]">até (hora)</Label>
                <Input type="number" min={1} max={24} value={horaFim ?? st.outbound?.hora_fim ?? 22} onChange={(e) => setHoraFim(Number(e.target.value))} className="mt-1 h-9 text-sm" />
              </div>
              <div>
                <Label className="text-[11px]">Dias (0=dom … 6=sáb)</Label>
                <Input value={dias ?? st.outbound?.dias ?? "0,1,2,3,4,5,6"} onChange={(e) => setDias(e.target.value)} className="mt-1 h-9 text-sm font-mono" />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">Horário da Nina, separado do SLA das lojas. Padrão: todos os dias, 10h às 22h (shopping). O botão manual liga a qualquer hora.</p>
            <Button size="sm" variant="outline" onClick={() => setOutbound.mutate({ sources: sources ?? st.outbound?.sources, delay_min: delayMin ?? st.outbound?.delay_min, hora_inicio: horaIni ?? st.outbound?.hora_inicio, hora_fim: horaFim ?? st.outbound?.hora_fim, dias: dias ?? st.outbound?.dias })} disabled={setOutbound.isPending}>Salvar origens, espera e horário</Button>
          </div>

          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs font-medium">4c. Testar: enfileirar uma ligação agora</p>
            <div className="flex gap-2 items-end">
              <div className="flex-1"><Label className="text-[11px]">ID do lead (da URL /comercial/leads/…)</Label><Input value={testLead} onChange={(e) => setTestLead(e.target.value)} placeholder="uuid do lead" className="mt-1 h-9 text-sm font-mono" /></div>
              <Button variant="outline" onClick={() => enqueue.mutate()} disabled={enqueue.isPending || !testLead.trim() || !st.outbound?.enabled}>
                {enqueue.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <PhoneCall className="h-4 w-4 mr-1" />} Nina, liga
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">Ou use o botão "Pedir pra Nina ligar" no detalhe do lead.</p>
            <Button size="sm" variant="ghost" onClick={() => metaDiag.mutate()} disabled={metaDiag.isPending}>
              {metaDiag.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />} Diagnóstico Meta (ligação habilitada? horário? permissão)
            </Button>
            <p className="text-[10px] text-muted-foreground">Dica: no campo acima, em vez do ID do lead, cole um telefone (ex.: 5511947448137) para ver a permissão dele.</p>
          </div>

          {st.outbound?.queue?.recent?.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1">Fila ({Object.entries(st.outbound.queue.counts).map(([k, v]) => `${k}: ${v}`).join(" · ")})</p>
              <div className="max-h-56 overflow-auto rounded-md border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-muted/40 text-muted-foreground"><tr><th className="text-left p-1.5">Lead</th><th className="text-left p-1.5">Playbook</th><th className="text-left p-1.5">Status</th><th className="text-left p-1.5">Quando</th><th className="text-left p-1.5">Tent.</th><th className="text-left p-1.5">Resultado / erro</th></tr></thead>
                  <tbody>
                    {st.outbound.queue.recent.map((r) => (
                      <tr key={r.id} className="border-t border-border/60">
                        <td className="p-1.5"><a className="underline" href={`/comercial/leads/${r.lead_id}`}>{r.lead_name || r.phone}</a></td>
                        <td className="p-1.5">{r.playbook || "-"}</td>
                        <td className="p-1.5"><Badge variant="outline" className="text-[10px]">{r.status}</Badge></td>
                        <td className="p-1.5">{new Date(r.scheduled_for).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                        <td className="p-1.5">{r.attempts}</td>
                        <td className="p-1.5 max-w-[260px] truncate" title={r.last_error || ""}>{r.outcome || r.last_error || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 3. Teste */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">3. Testar de verdade</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p>Abra a conversa com o número oficial no WhatsApp e toque no ícone de ligar. A Nina atende com a sua voz.</p>
          <p>Ao desligar, a ligação aparece na timeline do lead como "Chamada Recebida" com resumo e transcrição.</p>
          <p>Se o botão de ligar não aparecer no WhatsApp: o número precisa ter limite de 2.000 mensagens/dia e o app da Meta em modo Live.</p>
        </CardContent>
      </Card>

      {/* 5. Aprendizado */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><GraduationCap className="h-4 w-4 text-violet-600" /> 5. O que a Nina aprendeu</CardTitle>
          <CardDescription className="text-xs">
            Depois de cada ligação, um treinador de IA avalia a conversa (nota e erros ficam no card da ligação) e propõe lições.
            Aprove as que fazem sentido: elas entram no prompt da Nina em até 2 minutos. Rejeite o resto. Nada entra sem a sua aprovação.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {learnings.isLoading && <p className="text-xs text-muted-foreground">Carregando…</p>}
          {learnings.error && <p className="text-xs text-red-600">Não carregou: {(learnings.error as Error).message}. A tabela nina_learnings precisa estar aplicada.</p>}
          {learnings.data && learnings.data.length === 0 && <p className="text-xs text-muted-foreground">Nenhuma lição ainda. Elas aparecem aqui depois das próximas ligações.</p>}
          {(learnings.data || []).map((l) => (
            <div key={l.id} className={cn("rounded-md border p-2.5 text-xs space-y-1", l.status === "aprovada" ? "border-emerald-300/60 bg-emerald-500/5" : "border-border")}>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="font-medium leading-snug">{l.regra}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {l.categoria && <Badge variant="outline" className="text-[10px] mr-1">{l.categoria}</Badge>}
                    {l.vezes > 1 ? `apareceu em ${l.vezes} ligações` : "1 ligação"} · {new Date(l.created_at).toLocaleDateString("pt-BR")}
                    {l.status === "aprovada" && l.aprovada_em && ` · no prompt desde ${new Date(l.aprovada_em).toLocaleDateString("pt-BR")}`}
                  </p>
                  {(l.ultima_evidencia || l.evidencia) && <p className="text-[11px] text-muted-foreground italic">“{l.ultima_evidencia || l.evidencia}”</p>}
                </div>
                <div className="flex gap-1 shrink-0">
                  {l.status !== "aprovada" && <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={setLearning.isPending} onClick={() => setLearning.mutate({ id: l.id, status: "aprovada" })}><Check className="h-3 w-3 mr-1" />Aprovar</Button>}
                  {l.status === "aprovada" && <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" disabled={setLearning.isPending} onClick={() => setLearning.mutate({ id: l.id, status: "pendente" })}>Tirar do prompt</Button>}
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-red-600" disabled={setLearning.isPending} onClick={() => setLearning.mutate({ id: l.id, status: "rejeitada" })}><X className="h-3 w-3 mr-1" />Rejeitar</Button>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {log.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-[11px] font-medium mb-1">Registro da última ação</p>
          <ul className="text-[11px] font-mono space-y-0.5 whitespace-pre-wrap break-all">{log.map((l, i) => <li key={i}>• {l}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
