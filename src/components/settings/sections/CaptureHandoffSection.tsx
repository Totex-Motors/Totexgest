import { useEffect, useState } from "react";
import { HandCoins, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import {
  DEFAULT_HANDOFF_CONFIG,
  useCaptureHandoffConfig,
  useSaveCaptureHandoffConfig,
  type CaptureHandoffConfig,
} from "@/hooks/useCaptureHandoff";

/**
 * Configurações › Comercial › Captação (promotoras).
 * Quem recebe os leads captados (rodízio), SLA por temperatura, escalonamento
 * e canal de aviso (instância UAZAPI + grupo). Vazio = herda da Torre de Controle.
 */

const NONE = "__none__";

function useUazapiInstances(tenantId: string | null) {
  return useQuery({
    queryKey: ["capture-handoff-instances", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("whatsapp_instances")
        .select("id, name, status, provider")
        .eq("tenant_id", tenantId!)
        .order("name");
      return ((data ?? []) as { id: string; name: string; status: string | null; provider: string | null }[])
        .filter((i) => i.provider !== "meta_cloud");
    },
  });
}

export function CaptureHandoffSection() {
  const { tenantId } = useAuth();
  const { data: cfg, isLoading } = useCaptureHandoffConfig();
  const save = useSaveCaptureHandoffConfig();
  const { data: members = [] } = useAllTeamMembers();
  const { data: instances = [] } = useUazapiInstances(tenantId);

  const [form, setForm] = useState<Omit<CaptureHandoffConfig, "tenant_id">>(DEFAULT_HANDOFF_CONFIG);
  useEffect(() => {
    if (cfg) {
      const { tenant_id: _t, ...rest } = cfg;
      setForm({ ...DEFAULT_HANDOFF_CONFIG, ...rest });
    }
  }, [cfg]);

  const sellers = members.filter((m) => m.is_active && ["comercial", "closer", "admin", "sdr"].includes(m.role ?? ""));
  const toggleSpecialist = (id: string) =>
    setForm((f) => ({
      ...f,
      specialist_member_ids: f.specialist_member_ids.includes(id)
        ? f.specialist_member_ids.filter((x) => x !== id)
        : [...f.specialist_member_ids, id],
    }));

  const onSave = async () => {
    try {
      await save.mutateAsync({ ...form, last_assigned_member_id: cfg?.last_assigned_member_id ?? null });
      toast.success("Configuração de captação salva");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  };

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><HandCoins className="h-4 w-4" /> Handoff da captação</CardTitle>
          <CardDescription>
            Quando a promotora capta um proprietário, o lead vai automaticamente pra um especialista
            (rodízio), vira tarefa e dispara aviso no WhatsApp. Se ninguém fizer o 1º contato dentro do
            SLA, o sistema re-avisa e depois escala.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label>Handoff automático</Label>
              <p className="text-xs text-muted-foreground">Desligado = lead fica no funil sem vendedor, sem aviso.</p>
            </div>
            <Switch checked={form.enabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          </div>

          <div className="space-y-2">
            <Label>Especialistas que recebem os leads (rodízio na ordem marcada)</Label>
            <p className="text-xs text-muted-foreground">Nenhum marcado = todos os vendedores ativos (comercial/closer).</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {sellers.map((m) => {
                const checked = form.specialist_member_ids.includes(m.id);
                const pos = form.specialist_member_ids.indexOf(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm cursor-pointer">
                    <Checkbox checked={checked} onCheckedChange={() => toggleSpecialist(m.id)} />
                    <span className="flex-1 truncate">{m.name}</span>
                    {!m.phone && <span className="text-[10px] text-amber-600">sem telefone</span>}
                    {checked && <span className="text-[10px] text-muted-foreground">#{pos + 1}</span>}
                  </label>
                );
              })}
              {sellers.length === 0 && <p className="text-sm text-muted-foreground">Nenhum vendedor ativo no time.</p>}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>SLA lead quente (min)</Label>
              <Input type="number" min={5} max={1440} value={form.sla_minutes_quente}
                onChange={(e) => setForm({ ...form, sla_minutes_quente: Number(e.target.value) || 30 })} />
            </div>
            <div className="space-y-1.5">
              <Label>SLA lead morno (min)</Label>
              <Input type="number" min={5} max={4320} value={form.sla_minutes_morno}
                onChange={(e) => setForm({ ...form, sla_minutes_morno: Number(e.target.value) || 240 })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Escalar para (2× SLA sem contato)</Label>
            <Select value={form.escalate_to_member_id ?? NONE} onValueChange={(v) => setForm({ ...form, escalate_to_member_id: v === NONE ? null : v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Admins do tenant (com telefone) + grupo</SelectItem>
                {members.filter((m) => m.is_active).map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}{m.phone ? "" : " (sem telefone)"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Canal de aviso (WhatsApp)</CardTitle>
          <CardDescription>
            Deixe em branco pra usar a mesma instância e grupo da Torre de Controle (Configurações › Automações › Alertas).
            Só instâncias UAZAPI — o número oficial (Cloud API) exige template aprovado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Avisar o grupo da operação (com @menção do especialista)</Label>
              <p className="text-xs text-muted-foreground">Canal recomendado. Coloque os vendedores no grupo — eles recebem o lead marcados pelo @.</p>
            </div>
            <Switch checked={form.notify_group} onCheckedChange={(v) => setForm({ ...form, notify_group: v })} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Avisar também no privado do especialista (número OFICIAL, template)</Label>
              <p className="text-xs text-muted-foreground">Vai pelo Cloud API com template aprovado pela Meta. A API não oficial nunca manda no privado.</p>
            </div>
            <Switch checked={form.notify_specialist} onCheckedChange={(v) => setForm({ ...form, notify_specialist: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Nome do template (Cloud API)</Label>
            <Input value={form.specialist_template_name} onChange={(e) => setForm({ ...form, specialist_template_name: e.target.value.trim() })} placeholder="captacao_lead_especialista" />
            <p className="text-xs text-muted-foreground">Variáveis na ordem: 1 nome do especialista · 2 cliente + telefone · 3 carro · 4 prazo · 5 minutos do SLA. Só envia quando o template estiver APROVADO.</p>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <Label>Resumo da captação no grupo</Label>
              <p className="text-xs text-muted-foreground">Por promotora, quentes, quem está sem contato, meta/prêmio da semana.</p>
            </div>
            <Switch checked={form.summary_enabled} onCheckedChange={(v) => setForm({ ...form, summary_enabled: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Horários do resumo (horas, separadas por vírgula)</Label>
            <Input
              value={form.summary_hours.join(", ")}
              onChange={(e) => setForm({
                ...form,
                summary_hours: Array.from(new Set(e.target.value.split(/[,\s]+/).map((s) => Number(s)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23))),
              })}
              placeholder="13, 19"
            />
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Instância</Label>
              <Select value={form.whatsapp_instance_id ?? NONE} onValueChange={(v) => setForm({ ...form, whatsapp_instance_id: v === NONE ? null : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Herdar da Torre de Controle</SelectItem>
                  {instances.map((i) => (
                    <SelectItem key={i.id} value={i.id}>{i.name}{i.status === "connected" ? "" : ` (${i.status ?? "?"})`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>JID do grupo</Label>
              <Input placeholder="1203634…@g.us (vazio = herdar)" value={form.whatsapp_group_jid ?? ""}
                onChange={(e) => setForm({ ...form, whatsapp_group_jid: e.target.value.trim() || null })} />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          Salvar
        </Button>
      </div>
    </div>
  );
}
