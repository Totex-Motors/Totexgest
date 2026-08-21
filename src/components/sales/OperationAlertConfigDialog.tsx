import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Send, Sparkles, MessageCircle, Loader2, Bell } from "lucide-react";
import { toast } from "sonner";
import {
  useOperationAlertConfig, useUpsertOperationAlertConfig, useUazapiInstances,
  useWhatsAppGroups, useTestOperationAlert, DEFAULT_ALERT_CONFIG, type OperationAlertConfig,
} from "@/hooks/useOperationAlertConfig";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

export function OperationAlertConfigDialog({ open, onOpenChange }: Props) {
  const { data: saved } = useOperationAlertConfig();
  const upsert = useUpsertOperationAlertConfig();
  const test = useTestOperationAlert();
  const { data: instances } = useUazapiInstances();

  const [form, setForm] = useState<Omit<OperationAlertConfig, "tenant_id">>(DEFAULT_ALERT_CONFIG);
  const { data: groups } = useWhatsAppGroups(form.whatsapp_instance_id);

  useEffect(() => {
    if (saved) {
      const { tenant_id: _t, ...rest } = saved;
      setForm({ ...DEFAULT_ALERT_CONFIG, ...rest, summary_hours: saved.summary_hours || [9, 14] });
    }
  }, [saved]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    try {
      await upsert.mutateAsync(form);
      toast.success("Configuração de alertas salva.");
    } catch (e: any) {
      toast.error("Erro ao salvar: " + (e?.message || "desconhecido"));
    }
  };

  const runTest = async () => {
    try {
      // Salva antes pra testar com o que está na tela
      await upsert.mutateAsync(form);
      const res: any = await test.mutateAsync();
      const sent = res?.results?.[0]?.summary_sent;
      if (sent) toast.success("Teste enviado! Confira o grupo.");
      else toast.warning("Nenhum canal recebeu — confira token/chat_id e se está habilitado.");
    } catch (e: any) {
      toast.error("Erro no teste: " + (e?.message || "desconhecido"));
    }
  };

  const summaryHoursStr = (form.summary_hours || []).join(", ");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-indigo-500" /> Alertas da Operação
          </DialogTitle>
          <DialogDescription>
            Manda avisos pro time quando um lead fica sem atendimento e um resumo diário.
            Telegram é o canal recomendado (nunca cai); WhatsApp é opcional.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Master */}
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label className="text-sm font-semibold">Alertas ligados</Label>
              <p className="text-xs text-muted-foreground">Chave-geral. Desligou, nada é enviado.</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
          </div>

          {/* Tipos */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">O que avisar</p>
            <ToggleRow
              label="Tempo real (SLA + reconversão sem resposta)"
              desc="Lead sem 1º contato que passou do limite abaixo"
              checked={form.realtime_enabled}
              onChange={(v) => set("realtime_enabled", v)}
            />
            <ToggleRow
              label="Resumo diário da operação"
              desc="Foto da operação nos horários definidos"
              checked={form.summary_enabled}
              onChange={(v) => set("summary_enabled", v)}
            />
            <ToggleRow
              label="Incluir plano de ação da IA no resumo"
              desc="O copiloto sugere o que fazer, direto no grupo"
              checked={form.include_ai_plan}
              onChange={(v) => set("include_ai_plan", v)}
            />
          </div>

          {/* Parâmetros */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Alertar após (min sem contato)</Label>
              <Input
                type="number" min={5} value={form.sla_alert_minutes}
                onChange={(e) => set("sla_alert_minutes", Number(e.target.value) || 60)}
              />
            </div>
            <div>
              <Label className="text-xs">Horários do resumo (BRT)</Label>
              <Input
                value={summaryHoursStr}
                placeholder="9, 14"
                onChange={(e) =>
                  set(
                    "summary_hours",
                    e.target.value.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n >= 0 && n <= 23)
                  )
                }
              />
            </div>
          </div>

          {/* Telegram */}
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold flex items-center gap-2">
                <Send className="h-4 w-4 text-sky-500" /> Telegram <span className="text-[10px] text-emerald-600 font-normal">recomendado</span>
              </Label>
              <Switch checked={form.telegram_enabled} onCheckedChange={(v) => set("telegram_enabled", v)} />
            </div>
            {form.telegram_enabled && (
              <div className="space-y-2 pt-1">
                <div>
                  <Label className="text-xs">Token do bot</Label>
                  <Input
                    value={form.telegram_bot_token || ""}
                    placeholder="123456:ABC-DEF..."
                    onChange={(e) => set("telegram_bot_token", e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">Chat ID do grupo</Label>
                  <Input
                    value={form.telegram_chat_id || ""}
                    placeholder="-1001234567890"
                    onChange={(e) => set("telegram_chat_id", e.target.value)}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Crie um bot no @BotFather, adicione-o ao grupo "CRM Captação Tamboré" como admin,
                  e cole aqui o token dele. O Chat ID do grupo você pega adicionando o @RawDataBot ao grupo
                  (ou eu te passo o passo a passo).
                </p>
              </div>
            )}
          </div>

          {/* WhatsApp */}
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-emerald-500" /> WhatsApp (grupo) <span className="text-[10px] text-amber-600 font-normal">opcional</span>
              </Label>
              <Switch checked={form.whatsapp_enabled} onCheckedChange={(v) => set("whatsapp_enabled", v)} />
            </div>
            {form.whatsapp_enabled && (
              <div className="space-y-2 pt-1">
                <div>
                  <Label className="text-xs">Instância (número que envia)</Label>
                  <Select
                    value={form.whatsapp_instance_id || ""}
                    onValueChange={(v) => { set("whatsapp_instance_id", v); set("whatsapp_group_jid", null); }}
                  >
                    <SelectTrigger><SelectValue placeholder="Escolha a instância" /></SelectTrigger>
                    <SelectContent>
                      {(instances || []).map((i: any) => (
                        <SelectItem key={i.id} value={i.id}>
                          {i.name} {i.status === "connected" ? "🟢" : "⚪"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Grupo destino</Label>
                  <Select
                    value={form.whatsapp_group_jid || ""}
                    onValueChange={(v) => set("whatsapp_group_jid", v)}
                    disabled={!form.whatsapp_instance_id}
                  >
                    <SelectTrigger><SelectValue placeholder="Escolha o grupo" /></SelectTrigger>
                    <SelectContent>
                      {(groups || []).map((g: any) => (
                        <SelectItem key={g.id} value={g.group_jid}>{g.name || g.group_jid}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  Se o grupo não aparecer, sincronize os grupos da instância primeiro. Use um número
                  descartável aqui — a UAZAPI pode ser derrubada pela Meta.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={runTest} disabled={test.isPending || upsert.isPending}>
            {test.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
            Enviar teste
          </Button>
          <Button onClick={save} disabled={upsert.isPending}>
            {upsert.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2">
      <div className="min-w-0 pr-2">
        <p className="text-sm">{label}</p>
        <p className="text-[10px] text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
