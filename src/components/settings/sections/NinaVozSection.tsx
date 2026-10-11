import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PhoneCall, Check, X, Loader2, Sparkles, Link2, FlaskConical, ExternalLink } from "lucide-react";
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

interface Status {
  keys: Record<string, boolean>;
  numero_oficial: string | null;
  voz: { voice_id: string | null; provider: string | null; agente: string | null };
  eleven: { agent_id: string | null; phone_number_id: string | null; tool_ids: Record<string, string>; provisioned_at: string | null };
  wavoip: { device_id: string | null; linked_at: string | null; sip_at: string | null; webhook_at: string | null };
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
              <a className="text-xs text-violet-700 underline inline-flex items-center gap-1" href={`https://elevenlabs.io/app/agents/${st.eleven.agent_id}`} target="_blank" rel="noreferrer">
                abrir na ElevenLabs <ExternalLink className="h-3 w-3" />
              </a>
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

      {/* 3. Teste */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">3. Testar de verdade</CardTitle></CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          <p>Abra a conversa com o número oficial no WhatsApp e toque no ícone de ligar. A Nina atende com a sua voz.</p>
          <p>Ao desligar, a ligação aparece na timeline do lead como "Chamada Recebida" com resumo e transcrição.</p>
          <p>Se o botão de ligar não aparecer no WhatsApp: o número precisa ter limite de 2.000 mensagens/dia e o app da Meta em modo Live.</p>
        </CardContent>
      </Card>

      {log.length > 0 && (
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-[11px] font-medium mb-1">Registro da última ação</p>
          <ul className="text-[11px] font-mono space-y-0.5">{log.map((l, i) => <li key={i}>• {l}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
