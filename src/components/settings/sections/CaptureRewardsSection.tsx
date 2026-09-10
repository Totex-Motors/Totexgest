import { useRef, useState } from "react";
import { Gift, Plus, Pencil, Trash2, Loader2, ImagePlus, CheckCircle2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  GOAL_TYPE_LABEL,
  useCaptureRewardClaims,
  useCaptureRewards,
  useDeleteCaptureReward,
  useMarkClaimDelivered,
  useSaveCaptureReward,
  useUploadRewardImage,
  type CaptureReward,
  type RewardGoalType,
} from "@/hooks/useCaptureRewards";

/**
 * Configurações › Comercial › Prêmios da captação — "Gerenciar Prêmios".
 * Catálogo (imagem, nome, descrição, meta, estoque, ativo) + resgates pendentes.
 */

type Form = {
  name: string;
  description: string;
  image_url: string;
  goal_type: RewardGoalType;
  goal_value: string;
  stock: string;
  is_active: boolean;
};

const EMPTY: Form = { name: "", description: "", image_url: "", goal_type: "leads_semana", goal_value: "40", stock: "", is_active: true };

function toForm(r: CaptureReward): Form {
  return {
    name: r.name,
    description: r.description ?? "",
    image_url: r.image_url ?? "",
    goal_type: r.goal_type,
    goal_value: String(r.goal_value),
    stock: r.stock == null ? "" : String(r.stock),
    is_active: r.is_active,
  };
}

function RewardDialog({ reward, onClose }: { reward: CaptureReward | null; onClose: () => void }) {
  const [f, setF] = useState<Form>(reward ? toForm(reward) : EMPTY);
  const save = useSaveCaptureReward();
  const upload = useUploadRewardImage();
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = async (file?: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error("Imagem até 5 MB"); return; }
    try {
      const url = await upload.mutateAsync(file);
      setF((prev) => ({ ...prev, image_url: url }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro no upload");
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const goal = Number(f.goal_value);
    if (!f.name.trim() || !goal || goal <= 0) { toast.error("Nome e meta são obrigatórios"); return; }
    try {
      await save.mutateAsync({
        id: reward?.id,
        name: f.name.trim(),
        description: f.description.trim() || null,
        image_url: f.image_url.trim() || null,
        goal_type: f.goal_type,
        goal_value: goal,
        stock: f.stock.trim() === "" ? null : Math.max(0, Number(f.stock)),
        is_active: f.is_active,
      });
      toast.success(reward ? "Prêmio atualizado" : "Prêmio criado");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reward ? "Editar prêmio" : "Novo prêmio"}</DialogTitle>
          <DialogDescription>A promotora vê o prêmio e o progresso dela na tela "Hoje" e no Perfil.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={cn("h-24 w-24 shrink-0 rounded-lg border border-dashed border-input flex items-center justify-center overflow-hidden bg-muted/40 hover:bg-muted", upload.isPending && "opacity-60")}
            >
              {f.image_url ? (
                <img src={f.image_url} alt="" className="h-full w-full object-cover" />
              ) : upload.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-6 w-6 text-muted-foreground" />}
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
            <div className="flex-1 space-y-2">
              <div className="space-y-1">
                <Label>Nome *</Label>
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Voucher Outback R$ 100,00" />
              </div>
              <div className="space-y-1">
                <Label>URL da imagem (ou clique no quadro pra enviar)</Label>
                <Input value={f.image_url} onChange={(e) => setF({ ...f, image_url: e.target.value })} placeholder="https://… ou /rewards/arquivo.jpg" />
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <Label>Descrição</Label>
            <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Prêmio pra quem bater a meta semanal de 40 clientes captados." />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label>Critério</Label>
              <Select value={f.goal_type} onValueChange={(v) => setF({ ...f, goal_type: v as RewardGoalType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(GOAL_TYPE_LABEL) as RewardGoalType[]).map((k) => (
                    <SelectItem key={k} value={k}>{GOAL_TYPE_LABEL[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Meta *</Label>
              <Input inputMode="numeric" value={f.goal_value} onChange={(e) => setF({ ...f, goal_value: e.target.value.replace(/\D/g, "") })} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 items-end">
            <div className="space-y-1">
              <Label>Estoque (vazio = ilimitado)</Label>
              <Input inputMode="numeric" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value.replace(/\D/g, "") })} placeholder="25" />
            </div>
            <label className="flex items-center justify-between rounded-md border border-input px-3 h-10 text-sm">
              Ativo
              <Switch checked={f.is_active} onCheckedChange={(v) => setF({ ...f, is_active: v })} />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={save.isPending || upload.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CaptureRewardsSection() {
  const { data: rewards = [], isLoading } = useCaptureRewards();
  const { data: claims = [] } = useCaptureRewardClaims();
  const del = useDeleteCaptureReward();
  const mark = useMarkClaimDelivered();
  const [dialog, setDialog] = useState<{ open: boolean; reward: CaptureReward | null }>({ open: false, reward: null });

  const remove = async (r: CaptureReward) => {
    if (!confirm(`Excluir o prêmio "${r.name}"?`)) return;
    try { await del.mutateAsync(r.id); toast.success("Prêmio excluído"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Erro ao excluir"); }
  };

  const pending = claims.filter((c) => c.status === "pending");

  return (
    <div className="space-y-4 max-w-3xl">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Gift className="h-5 w-5 text-purple-600" /> Gerenciar Prêmios</CardTitle>
            <CardDescription>Gamificação da captação — o que a promotora ganha ao bater a meta.</CardDescription>
          </div>
          <Button onClick={() => setDialog({ open: true, reward: null })}><Plus className="h-4 w-4 mr-1" /> Novo Prêmio</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhum prêmio cadastrado. Crie o primeiro pra aparecer na tela das promotoras.</p>
          ) : rewards.map((r) => {
            const g = GOAL_TYPE_LABEL[r.goal_type];
            return (
              <div key={r.id} className="flex items-center gap-4 rounded-lg border border-border/60 p-3">
                <div className="h-20 w-20 shrink-0 rounded-md overflow-hidden bg-muted/40 flex items-center justify-center">
                  {r.image_url ? <img src={r.image_url} alt="" className="h-full w-full object-cover" /> : <Gift className="h-6 w-6 text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold truncate">{r.name}</p>
                    <Badge variant="outline" className={cn("border", r.is_active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-muted text-muted-foreground")}>
                      {r.is_active ? "Ativo" : "Inativo"}
                    </Badge>
                  </div>
                  {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                  <p className="text-sm mt-1">
                    <span className="font-semibold text-primary">{r.goal_value} {g.unit}</span>
                    <span className="text-muted-foreground"> {g.period} · Estoque: {r.stock == null ? "ilimitado" : r.stock}</span>
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button variant="ghost" size="icon" onClick={() => setDialog({ open: true, reward: r })}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="text-red-600" onClick={() => remove(r)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resgates {pending.length > 0 && <Badge className="ml-2">{pending.length} pendente{pending.length > 1 ? "s" : ""}</Badge>}</CardTitle>
          <CardDescription>Quando a promotora bate a meta e clica "Resgatar", aparece aqui. Marque como entregue depois de dar o prêmio.</CardDescription>
        </CardHeader>
        <CardContent>
          {claims.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum resgate ainda.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {claims.map((c) => (
                <li key={c.id} className="py-2 flex items-center gap-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{c.member?.name ?? "—"} → {c.reward?.name ?? "prêmio"}</p>
                    <p className="text-xs text-muted-foreground">
                      Semana de {new Date(c.period_start + "T12:00:00").toLocaleDateString("pt-BR")} · atingiu {c.achieved_value ?? "—"} · pedido em {new Date(c.created_at).toLocaleDateString("pt-BR")}
                    </p>
                  </div>
                  {c.status === "pending" ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => mark.mutate({ id: c.id, status: "delivered" })}><CheckCircle2 className="h-4 w-4 mr-1" /> Entregue</Button>
                      <Button size="sm" variant="ghost" onClick={() => mark.mutate({ id: c.id, status: "cancelled" })}><X className="h-4 w-4" /></Button>
                    </div>
                  ) : (
                    <Badge variant="outline" className={c.status === "delivered" ? "text-emerald-700 border-emerald-200" : "text-muted-foreground"}>
                      {c.status === "delivered" ? "Entregue" : "Cancelado"}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {dialog.open && <RewardDialog reward={dialog.reward} onClose={() => setDialog({ open: false, reward: null })} />}
    </div>
  );
}
