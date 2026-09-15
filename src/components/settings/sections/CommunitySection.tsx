import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Users, Clock, Plus, Trash2, Play, Square, Car } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/contexts/AuthContext";
import { useUazapiInstances, useUazapiGroups } from "@/hooks/useRepasseRelay";
import {
  useCommunityConfig, useSaveCommunityConfig, useOpenWindowNow, useCloseWindowNow,
  useCommunityDemand, useUpdateDemandStatus,
  type WindowSlot,
} from "@/hooks/useCommunityWindows";

/**
 * Configurações › Integrações › Comunidade (Janela de Oportunidades).
 * A IA abre janelas por tempo limitado pra captar e qualificar demanda; capta os
 * pedidos e casa com os carros do repasse. Não tranca o grupo (modelo soft).
 */

const DOW = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const brl = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

type FormState = {
  id?: string;
  instance_id: string;
  community_group_jid: string;
  timezone: string;
  windows: WindowSlot[];
  open_template: string;
  close_template: string;
  duration_default: number;
  ack_reaction: string;
  active: boolean;
};

const DEFAULT_OPEN = "🚗 *JANELA DE OPORTUNIDADES ABERTA!* ⏱️\n\nPelos próximos {DURACAO} minutos: me manda aqui o *carro que você está procurando* (modelo, ano e faixa de preço) que eu já saio caçando pra você. 👇";
const DEFAULT_CLOSE = "⛔ *Janela encerrada!* Recebi {QTD} pedido(s) e já vou atrás. Fica de olho que quando achar o seu, te chamo. 🚗💨";

const EMPTY: FormState = {
  instance_id: "", community_group_jid: "", timezone: "America/Sao_Paulo",
  windows: [{ dow: 3, time: "19:00", duration_min: 30 }, { dow: 6, time: "11:00", duration_min: 30 }],
  open_template: DEFAULT_OPEN, close_template: DEFAULT_CLOSE, duration_default: 30, ack_reaction: "👍", active: true,
};

export function CommunitySection() {
  const { tenantId } = useAuth();
  const { data: cfg, isLoading } = useCommunityConfig();
  const { data: instances = [] } = useUazapiInstances(tenantId);
  const save = useSaveCommunityConfig();
  const openNow = useOpenWindowNow();
  const closeNow = useCloseWindowNow();

  const [form, setForm] = useState<FormState>(EMPTY);
  useEffect(() => {
    if (cfg) {
      setForm({
        id: cfg.id, instance_id: cfg.instance_id, community_group_jid: cfg.community_group_jid,
        timezone: cfg.timezone, windows: Array.isArray(cfg.windows) ? cfg.windows : [],
        open_template: cfg.open_template, close_template: cfg.close_template,
        duration_default: Number(cfg.duration_default) || 30, ack_reaction: cfg.ack_reaction ?? "👍", active: cfg.active,
      });
    }
  }, [cfg]);

  const { data: groups = [], isLoading: groupsLoading } = useUazapiGroups(form.instance_id || null);
  const groupOptions = useMemo(() => {
    const map = new Map(groups.map((g) => [g.jid, g.name]));
    if (form.community_group_jid && !map.has(form.community_group_jid)) map.set(form.community_group_jid, form.community_group_jid);
    return Array.from(map, ([jid, name]) => ({ jid, name }));
  }, [groups, form.community_group_jid]);

  const canSave = !!form.instance_id && !!form.community_group_jid;

  const setWindow = (i: number, patch: Partial<WindowSlot>) =>
    setForm((f) => ({ ...f, windows: f.windows.map((w, idx) => idx === i ? { ...w, ...patch } : w) }));
  const addWindow = () => setForm((f) => ({ ...f, windows: [...f.windows, { dow: 1, time: "19:00", duration_min: f.duration_default }] }));
  const removeWindow = (i: number) => setForm((f) => ({ ...f, windows: f.windows.filter((_, idx) => idx !== i) }));

  const onSave = async () => {
    try { await save.mutateAsync(form); toast.success("Configuração da comunidade salva."); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Erro ao salvar"); }
  };
  const doOpen = async () => {
    if (!form.id) { toast.info("Salve a configuração antes de abrir uma janela."); return; }
    try { await openNow.mutateAsync({ configId: form.id, durationMin: form.duration_default }); toast.success("Janela aberta! A IA já avisou o grupo."); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Erro ao abrir"); }
  };
  const doClose = async () => {
    if (!form.id) return;
    try { await closeNow.mutateAsync({ configId: form.id }); toast.success("Janela fechada."); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Erro ao fechar"); }
  };

  if (isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" /> Janela de Oportunidades
            <Badge variant={form.active ? "default" : "secondary"} className="ml-auto">{form.active ? "Ativa" : "Pausada"}</Badge>
          </CardTitle>
          <CardDescription>
            A IA abre uma janela por tempo limitado pra captar o que os membros procuram ("manda o carro que você quer"),
            qualifica cada pedido e casa com os carros do repasse. Não tranca o grupo — a escassez vem do horário marcado.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label>Automação ligada</Label>
              <p className="text-xs text-muted-foreground">Desligada = a IA não abre janelas nem capta demanda.</p>
            </div>
            <Switch checked={form.active} onCheckedChange={(active) => setForm({ ...form, active })} />
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Número (instância)</Label>
              <Select value={form.instance_id} onValueChange={(v) => setForm({ ...form, instance_id: v, community_group_jid: "" })}>
                <SelectTrigger><SelectValue placeholder="Número admin do grupo" /></SelectTrigger>
                <SelectContent>
                  {instances.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Grupo da comunidade</Label>
              <Select value={form.community_group_jid} disabled={!form.instance_id || groupsLoading}
                onValueChange={(v) => setForm({ ...form, community_group_jid: v })}>
                <SelectTrigger><SelectValue placeholder={groupsLoading ? "Carregando…" : "Escolha o grupo"} /></SelectTrigger>
                <SelectContent>{groupOptions.map((g) => <SelectItem key={g.jid} value={g.jid}>{g.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>

          {/* Agenda */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" /> Agenda das janelas</Label>
            <div className="space-y-2">
              {form.windows.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select value={String(w.dow)} onValueChange={(v) => setWindow(i, { dow: Number(v) })}>
                    <SelectTrigger className="w-[92px] h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>{DOW.map((d, idx) => <SelectItem key={idx} value={String(idx)}>{d}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input type="time" className="w-[120px] h-9" value={w.time} onChange={(e) => setWindow(i, { time: e.target.value })} />
                  <div className="flex items-center gap-1">
                    <Input type="number" min={5} max={240} className="w-[76px] h-9"
                      value={w.duration_min ?? form.duration_default}
                      onChange={(e) => setWindow(i, { duration_min: Number(e.target.value) || form.duration_default })} />
                    <span className="text-xs text-muted-foreground">min</span>
                  </div>
                  <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" onClick={() => removeWindow(i)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.windows.length === 0 && <p className="text-xs text-muted-foreground">Sem horários fixos — use só as aberturas manuais abaixo.</p>}
            </div>
            <Button variant="outline" size="sm" onClick={addWindow}><Plus className="h-4 w-4 mr-1" /> Adicionar horário</Button>
            <p className="text-xs text-muted-foreground">2 janelas fortes por semana costuma ser o ponto ideal (ritual + escassez).</p>
          </div>

          <div className="space-y-1.5">
            <Label>Mensagem de abertura <span className="text-muted-foreground font-normal">(use {"{DURACAO}"})</span></Label>
            <Textarea rows={3} value={form.open_template} onChange={(e) => setForm({ ...form, open_template: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Mensagem de fechamento <span className="text-muted-foreground font-normal">(use {"{QTD}"})</span></Label>
            <Textarea rows={2} value={form.close_template} onChange={(e) => setForm({ ...form, close_template: e.target.value })} />
          </div>

          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={doOpen} disabled={!form.id || openNow.isPending}>
                {openNow.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Play className="h-4 w-4 mr-1" />} Abrir agora
              </Button>
              <Button variant="outline" onClick={doClose} disabled={!form.id || closeNow.isPending}>
                {closeNow.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Square className="h-4 w-4 mr-1" />} Fechar agora
              </Button>
            </div>
            <Button onClick={onSave} disabled={!canSave || save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />} Salvar
            </Button>
          </div>
        </CardContent>
      </Card>

      <DemandCard />
    </div>
  );
}

/** Pedidos captados nas janelas + status. */
function DemandCard() {
  const { data: rows = [], isLoading } = useCommunityDemand(50);
  const upd = useUpdateDemandStatus();

  const badge = (s: string) => s === "matched" ? "default" : s === "contacted" ? "secondary" : s === "descartado" ? "outline" : "secondary";
  const label = (s: string) => ({ new: "novo", matched: "casou! 🔥", contacted: "contatado", descartado: "descartado" } as any)[s] ?? s;

  const setStatus = async (id: string, status: any) => {
    try { await upd.mutateAsync({ id, status }); } catch (e) { toast.error(e instanceof Error ? e.message : "Erro"); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Car className="h-4 w-4" /> Demanda captada</CardTitle>
        <CardDescription>Carros que os membros pediram nas janelas. "Casou" = entrou um carro do repasse que bate com o pedido.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum pedido captado ainda. Abra uma janela e peça o carro que os membros procuram.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((d) => (
              <li key={d.id} className="py-2.5 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {d.modelo || "(carro não identificado)"}{d.ano ? ` · ${d.ano}` : ""}
                    {(d.faixa_min || d.faixa_max) ? ` · ${brl(d.faixa_min)}–${brl(d.faixa_max)}` : ""}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {d.member_name || d.member_phone || "membro"} · {new Date(d.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {d.matched_car?.modelo ? ` · casou com ${d.matched_car.modelo}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant={badge(d.status) as any}>{label(d.status)}</Badge>
                  {d.status !== "contacted" && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setStatus(d.id, "contacted")}>contatei</Button>
                  )}
                  {d.status !== "descartado" && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setStatus(d.id, "descartado")}>descartar</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
