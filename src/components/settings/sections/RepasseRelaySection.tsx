import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Repeat, Sparkles, ArrowRight, Trash2 } from "lucide-react";
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
import {
  useRepasseConfigs, useUazapiInstances, useUazapiGroups,
  useSaveRepasseConfig, useDeleteRepasseConfig, useRepasseLog, usePreviewRepasse,
  type RepasseConfig, type RepasseVoice,
} from "@/hooks/useRepasseRelay";

/**
 * Configurações › Integrações › Repasse → Comunidade.
 * Monitora um grupo de repasse e reposta os carros no grupo da comunidade
 * (TOTEX Abaixo da Tabela) com a margem embutida e no tom da loja.
 */

const brl = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

const onlyDigits = (s: string) => {
  const d = s.replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : 0;
};

const VOICE_LABEL: Record<RepasseVoice, string> = {
  equilibrado: "Equilibrado (recomendado)",
  vendedor: "Vendedor animado",
  consultor: "Consultor confiável",
  descolado: "Descolado / informal",
};

type FormState = {
  id?: string;
  instance_id: string;
  source_group_jid: string;
  target_group_jid: string;
  margin: number;
  voice: RepasseVoice;
  signature: string;
  post_without_price: boolean;
  active: boolean;
};

const EMPTY: FormState = {
  instance_id: "", source_group_jid: "", target_group_jid: "",
  margin: 5000, voice: "equilibrado", signature: "TOTEX Motors",
  post_without_price: false, active: true,
};

export function RepasseRelaySection() {
  const { tenantId } = useAuth();
  const { data: configs = [], isLoading } = useRepasseConfigs();
  const { data: instances = [] } = useUazapiInstances(tenantId);
  const save = useSaveRepasseConfig();
  const del = useDeleteRepasseConfig();

  const [form, setForm] = useState<FormState>(EMPTY);
  useEffect(() => {
    const c: RepasseConfig | undefined = configs[0];
    if (c) {
      setForm({
        id: c.id, instance_id: c.instance_id,
        source_group_jid: c.source_group_jid, target_group_jid: c.target_group_jid,
        margin: Number(c.margin) || 5000, voice: c.voice, signature: c.signature,
        post_without_price: c.post_without_price, active: c.active,
      });
    }
  }, [configs]);

  const { data: groups = [], isLoading: groupsLoading, isError: groupsError } =
    useUazapiGroups(form.instance_id || null);

  // Garante que o JID salvo apareça no select mesmo enquanto a lista carrega.
  const groupOptions = useMemo(() => {
    const map = new Map(groups.map((g) => [g.jid, g.name]));
    for (const jid of [form.source_group_jid, form.target_group_jid]) {
      if (jid && !map.has(jid)) map.set(jid, jid);
    }
    return Array.from(map, ([jid, name]) => ({ jid, name }));
  }, [groups, form.source_group_jid, form.target_group_jid]);

  const canSave = form.instance_id && form.source_group_jid && form.target_group_jid
    && form.source_group_jid !== form.target_group_jid;

  const onSave = async () => {
    if (form.source_group_jid === form.target_group_jid) {
      toast.error("O grupo de origem e o de destino não podem ser o mesmo.");
      return;
    }
    try {
      await save.mutateAsync(form);
      toast.success("Configuração salva. A partir de agora os carros do repasse são repostados sozinhos.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  };

  const onDelete = async () => {
    if (!form.id) { setForm(EMPTY); return; }
    try {
      await del.mutateAsync(form.id);
      setForm(EMPTY);
      toast.success("Configuração removida.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao remover");
    }
  };

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>;
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Repeat className="h-4 w-4" /> Repasse → Comunidade
            <Badge variant={form.active ? "default" : "secondary"} className="ml-auto">
              {form.active ? "Ativo" : "Pausado"}
            </Badge>
          </CardTitle>
          <CardDescription>
            Todo carro postado no <strong>grupo de repasse</strong> é reescrito no tom da loja — com a sua
            margem embutida, o preço original escondido e a foto real — e repostado sozinho no
            <strong> grupo da comunidade</strong>. Só posta em grupo (regra da API não oficial).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label>Automação ligada</Label>
              <p className="text-xs text-muted-foreground">Desligado = os carros do repasse não são repostados.</p>
            </div>
            <Switch checked={form.active} onCheckedChange={(active) => setForm({ ...form, active })} />
          </div>

          <div className="space-y-1.5">
            <Label>Número (instância WhatsApp)</Label>
            <Select value={form.instance_id} onValueChange={(v) => setForm({ ...form, instance_id: v, source_group_jid: "", target_group_jid: "" })}>
              <SelectTrigger><SelectValue placeholder="Escolha o número que está nos dois grupos" /></SelectTrigger>
              <SelectContent>
                {instances.map((i) => (
                  <SelectItem key={i.id} value={i.id}>{i.name}{i.status === "connected" ? "" : ` (${i.status ?? "?"})`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Precisa ser um número que participa do grupo de repasse E do grupo da comunidade.</p>
          </div>

          <div className="grid sm:grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div className="space-y-1.5">
              <Label>Grupo de repasse (origem)</Label>
              <Select
                value={form.source_group_jid}
                disabled={!form.instance_id || groupsLoading}
                onValueChange={(v) => setForm({ ...form, source_group_jid: v })}
              >
                <SelectTrigger><SelectValue placeholder={groupsLoading ? "Carregando grupos…" : "Escolha o grupo"} /></SelectTrigger>
                <SelectContent>
                  {groupOptions.map((g) => <SelectItem key={g.jid} value={g.jid}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground mb-2.5 hidden sm:block" />
            <div className="space-y-1.5">
              <Label>Comunidade (destino)</Label>
              <Select
                value={form.target_group_jid}
                disabled={!form.instance_id || groupsLoading}
                onValueChange={(v) => setForm({ ...form, target_group_jid: v })}
              >
                <SelectTrigger><SelectValue placeholder={groupsLoading ? "Carregando grupos…" : "Escolha o grupo"} /></SelectTrigger>
                <SelectContent>
                  {groupOptions.map((g) => <SelectItem key={g.jid} value={g.jid}>{g.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {groupsError && <p className="text-xs text-amber-600">Não consegui listar os grupos dessa instância agora. Confira se ela está conectada.</p>}

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Sua margem</Label>
              <Input
                inputMode="numeric"
                value={form.margin ? form.margin.toLocaleString("pt-BR") : ""}
                onChange={(e) => setForm({ ...form, margin: onlyDigits(e.target.value) })}
                placeholder="5.000"
              />
              <p className="text-xs text-muted-foreground">Somada ao preço do anúncio. O "abaixo da FIPE" é recalculado sozinho.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Tom do post</Label>
              <Select value={form.voice} onValueChange={(v) => setForm({ ...form, voice: v as RepasseVoice })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(VOICE_LABEL) as RepasseVoice[]).map((v) => (
                    <SelectItem key={v} value={v}>{VOICE_LABEL[v]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Assinatura / rodapé</Label>
            <Input value={form.signature} onChange={(e) => setForm({ ...form, signature: e.target.value })} placeholder="TOTEX Motors" />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Postar mesmo sem preço claro</Label>
              <p className="text-xs text-muted-foreground">Desligado (recomendado) = se o anúncio não tiver preço, o carro é pulado em vez de sair "(consultar)".</p>
            </div>
            <Switch checked={form.post_without_price} onCheckedChange={(v) => setForm({ ...form, post_without_price: v })} />
          </div>

          <div className="flex justify-between gap-2 pt-1">
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete} disabled={del.isPending}>
              <Trash2 className="h-4 w-4 mr-2" /> {form.id ? "Remover" : "Limpar"}
            </Button>
            <Button onClick={onSave} disabled={!canSave || save.isPending}>
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Salvar
            </Button>
          </div>
        </CardContent>
      </Card>

      <TestCard instanceId={form.instance_id} sourceJid={form.source_group_jid} />

      <LogCard />
    </div>
  );
}

/** Cola um anúncio de exemplo e vê o post que sairia, sem enviar. */
function TestCard({ instanceId, sourceJid }: { instanceId: string; sourceJid: string }) {
  const preview = usePreviewRepasse();
  const [text, setText] = useState("");

  const run = async () => {
    if (!instanceId || !sourceJid) { toast.info("Salve a configuração (número e grupo de origem) antes de testar."); return; }
    if (text.trim().length < 15) { toast.info("Cole o texto de um anúncio pra testar."); return; }
    try {
      await preview.mutateAsync({ instance_id: instanceId, source_group_jid: sourceJid, text: text.trim() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar a prévia");
    }
  };

  const r = preview.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4" /> Testar (sem enviar)</CardTitle>
        <CardDescription>Cole um anúncio do repasse e veja exatamente o post que iria pra comunidade.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          rows={5}
          placeholder="Cole aqui o texto do carro (com preço, FIPE, etc.)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex justify-end">
          <Button variant="outline" onClick={run} disabled={preview.isPending}>
            {preview.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
            Gerar prévia
          </Button>
        </div>

        {r && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-px rounded-md overflow-hidden border border-border/60 bg-border/60 text-center">
              <div className="bg-card p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Repasse</div>
                <div className="font-mono text-sm mt-0.5">{brl(r.precoOriginal)}</div>
              </div>
              <div className="bg-card p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Margem</div>
                <div className="font-mono text-sm mt-0.5 text-amber-600">+ {brl(r.margem)}</div>
              </div>
              <div className="bg-card p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Anunciar por</div>
                <div className="font-mono text-sm mt-0.5 text-emerald-600">{brl(r.precoFinal)}</div>
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap break-words border border-border/60">
              {r.post}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Histórico dos últimos carros processados. */
function LogCard() {
  const { data: rows = [], isLoading } = useRepasseLog(20);
  const statusColor = (s: string) => s === "posted" ? "text-emerald-600" : s === "error" ? "text-destructive" : "text-muted-foreground";
  const statusLabel = (s: string) => s === "posted" ? "postado" : s === "error" ? "erro" : "pulado";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Últimos processados</CardTitle>
        <CardDescription>Cada carro que chegou no grupo de repasse e o que aconteceu com ele.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum carro processado ainda. Assim que cair um no grupo de repasse, aparece aqui.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((row) => (
              <li key={row.id} className="py-2 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{row.modelo ?? "Carro"}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {new Date(row.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    {row.status === "posted" && row.preco_final != null && <> · {brl(row.preco_final)}</>}
                    {row.status === "skipped" && row.skip_reason && <> · {row.skip_reason}</>}
                    {row.status === "error" && row.error && <> · {row.error}</>}
                  </p>
                </div>
                <span className={`text-[11px] font-medium shrink-0 ${statusColor(row.status)}`}>{statusLabel(row.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
