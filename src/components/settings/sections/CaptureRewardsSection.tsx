import { useMemo, useRef, useState } from "react";
import {
  Gift, Plus, Pencil, Trash2, Loader2, ImagePlus, CheckCircle2, X, ListChecks, BadgeCheck,
  Trophy, Megaphone, Coins, Ticket, Ban, Crown, Info, Save,
} from "lucide-react";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import { LEDGER_STATUS_META, type CaptureLedgerStatus, type CaptureRewardType } from "@/types/capture";
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
import {
  RULE_EVENT_META,
  REWARD_TYPE_LABEL,
  formatCents,
  useCaptureCampaignForEdit,
  useCaptureLedger,
  useCaptureLocations,
  useCaptureRanking,
  useCaptureRewardRules,
  useCloseCaptureMonth,
  useDeleteCaptureRewardRule,
  useSaveCaptureCampaign,
  useSaveCaptureRewardRule,
  useSetLedgerStatus,
  type CaptureCampaignFull,
  type CaptureLedgerEntry,
  type CaptureRewardRule,
  type CaptureRuleEventType,
  type CaptureRulePeriod,
} from "@/hooks/useCaptureRewardEngine";

/**
 * Configurações › Comercial › Prêmios da captação.
 *
 * Abas: Regras (reward engine) · Aprovações (ledger) · Ranking/ROI ·
 * Catálogo (imagem/estoque dos vouchers) · Campanha (frase/objeção do dia).
 * Dinheiro nasce SÓ no servidor — aqui o gestor configura, aprova e acompanha.
 */

const NONE = "__none__";
const fmtDate = (iso: string | null | undefined, withTime = false) =>
  iso ? new Date(iso).toLocaleString("pt-BR", withTime ? { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" } : { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const reaisToCents = (s: string) => Math.round((parseFloat(s.replace(/\./g, "").replace(",", ".")) || 0) * 100);
const centsToReais = (c: number) => (c / 100).toFixed(2).replace(".", ",");

// ═══════════════════════════════════════════════════════════════════════════
// Catálogo (mantido) — "Gerenciar Prêmios" com imagem/estoque
// ═══════════════════════════════════════════════════════════════════════════

type RewardForm = {
  name: string;
  description: string;
  image_url: string;
  goal_type: RewardGoalType;
  goal_value: string;
  stock: string;
  is_active: boolean;
};

const EMPTY_REWARD: RewardForm = { name: "", description: "", image_url: "", goal_type: "leads_semana", goal_value: "40", stock: "", is_active: true };

function toRewardForm(r: CaptureReward): RewardForm {
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
  const [f, setF] = useState<RewardForm>(reward ? toRewardForm(reward) : EMPTY_REWARD);
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
          <DialogDescription>Imagem e estoque do voucher. Vincule este prêmio a uma regra na aba "Regras" pra ele ser gerado automaticamente.</DialogDescription>
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
            <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Prêmio pra quem bater a meta semanal de 40 leads válidos." />
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1 sm:col-span-2">
              <Label>Critério (exibição na tela da promotora)</Label>
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

function CatalogTab() {
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
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Gift className="h-5 w-5 text-purple-600" /> Gerenciar Prêmios</CardTitle>
            <CardDescription>Catálogo de vouchers/brindes (imagem, estoque). A regra na aba "Regras" decide quando cada um é gerado.</CardDescription>
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

      {claims.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Resgates manuais (legado) {pending.length > 0 && <Badge className="ml-2">{pending.length} pendente{pending.length > 1 ? "s" : ""}</Badge>}</CardTitle>
            <CardDescription>Pedidos feitos pelo botão "Resgatar" antigo. Os novos prêmios saem automáticos e aparecem na aba "Aprovações".</CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      )}

      {dialog.open && <RewardDialog reward={dialog.reward} onClose={() => setDialog({ open: false, reward: null })} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Regras (capture_reward_rules)
// ═══════════════════════════════════════════════════════════════════════════

type RuleForm = {
  name: string;
  event_type: CaptureRuleEventType;
  threshold: string;
  period_type: CaptureRulePeriod;
  reward_type: CaptureRewardType;
  amount: string;
  voucher_label: string;
  reward_id: string;
  cap_per_period: string;
  min_valid_leads: string;
  campaign_id: string;
  active: boolean;
};

const EMPTY_RULE: RuleForm = {
  name: "", event_type: "lead_validated", threshold: "40", period_type: "week", reward_type: "voucher",
  amount: "0,00", voucher_label: "", reward_id: NONE, cap_per_period: "1", min_valid_leads: "10", campaign_id: NONE, active: true,
};

function toRuleForm(r: CaptureRewardRule): RuleForm {
  return {
    name: r.name,
    event_type: r.event_type,
    threshold: r.threshold == null ? "" : String(r.threshold),
    period_type: r.period_type ?? (r.event_type === "monthly_champion" ? "month" : "week"),
    reward_type: r.reward_type,
    amount: centsToReais(r.amount_cents),
    voucher_label: r.voucher_label ?? "",
    reward_id: r.reward_id ?? NONE,
    cap_per_period: String(r.cap_per_period),
    min_valid_leads: r.min_valid_leads == null ? "" : String(r.min_valid_leads),
    campaign_id: r.campaign_id ?? NONE,
    active: r.active,
  };
}

function RuleDialog({ rule, onClose, nextPosition }: { rule: CaptureRewardRule | null; onClose: () => void; nextPosition: number }) {
  const [f, setF] = useState<RuleForm>(rule ? toRuleForm(rule) : EMPTY_RULE);
  const save = useSaveCaptureRewardRule();
  const { data: rewards = [] } = useCaptureRewards();
  const { data: campaign } = useCaptureCampaignForEdit();
  const activeRewards = rewards.filter((r) => r.is_active || r.id === f.reward_id);

  const isThreshold = f.event_type === "lead_validated";
  const isChampion = f.event_type === "monthly_champion";

  const setEvent = (event_type: CaptureRuleEventType) =>
    setF((p) => ({
      ...p,
      event_type,
      period_type: event_type === "monthly_champion" ? "month" : p.period_type,
      reward_type: event_type === "lead_validated" ? p.reward_type : p.reward_type === "voucher" && !p.reward_id ? "cash" : p.reward_type,
    }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { toast.error("Dê um nome pra regra"); return; }
    const threshold = isThreshold ? Number(f.threshold) : null;
    if (isThreshold && (!threshold || threshold <= 0)) { toast.error("Informe o limiar de leads válidos"); return; }
    const amount_cents = f.reward_type === "cash" ? reaisToCents(f.amount) : 0;
    if (f.reward_type === "cash" && amount_cents <= 0) { toast.error("Informe o valor em R$"); return; }
    if (f.reward_type === "voucher" && !f.voucher_label.trim() && f.reward_id === NONE) { toast.error("Escolha um prêmio do catálogo ou descreva o voucher"); return; }
    const cap = Math.max(1, Number(f.cap_per_period) || 1);
    try {
      const picked = rewards.find((r) => r.id === f.reward_id);
      await save.mutateAsync({
        id: rule?.id,
        position: rule?.position ?? nextPosition,
        name: f.name.trim(),
        event_type: f.event_type,
        threshold,
        period_type: isThreshold || isChampion ? f.period_type : null,
        reward_type: f.reward_type,
        amount_cents,
        voucher_label: f.reward_type === "voucher" ? (f.voucher_label.trim() || picked?.name || null) : null,
        reward_id: f.reward_type === "voucher" && f.reward_id !== NONE ? f.reward_id : null,
        cap_per_period: cap,
        min_valid_leads: isChampion ? (Number(f.min_valid_leads) || null) : null,
        campaign_id: f.campaign_id === NONE ? null : f.campaign_id,
        active: f.active,
      });
      toast.success(rule ? "Regra atualizada" : "Regra criada");
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Editar regra" : "Nova regra de prêmio"}</DialogTitle>
          <DialogDescription>O servidor aplica a regra sozinho quando o evento acontece e lança no extrato da promotora como pendente.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Nome *</Label>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Meta semanal" />
            </div>
            <div className="space-y-1">
              <Label>Evento</Label>
              <Select value={f.event_type} onValueChange={(v) => setEvent(v as CaptureRuleEventType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(RULE_EVENT_META) as CaptureRuleEventType[]).map((k) => (
                    <SelectItem key={k} value={k}>{RULE_EVENT_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground flex gap-1.5"><Info className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {RULE_EVENT_META[f.event_type].hint}</p>

          {isThreshold && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Limiar (leads válidos) *</Label>
                <Input inputMode="numeric" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value.replace(/\D/g, "") })} placeholder="40" />
              </div>
              <div className="space-y-1">
                <Label>Período</Label>
                <Select value={f.period_type} onValueChange={(v) => setF({ ...f, period_type: v as CaptureRulePeriod })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">Semana</SelectItem>
                    <SelectItem value="month">Mês</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isChampion && (
            <div className="space-y-1">
              <Label>Mínimo de leads válidos no mês pra concorrer</Label>
              <Input inputMode="numeric" value={f.min_valid_leads} onChange={(e) => setF({ ...f, min_valid_leads: e.target.value.replace(/\D/g, "") })} placeholder="10" />
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Tipo de prêmio</Label>
              <Select value={f.reward_type} onValueChange={(v) => setF({ ...f, reward_type: v as CaptureRewardType })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(REWARD_TYPE_LABEL) as CaptureRewardType[]).map((k) => (
                    <SelectItem key={k} value={k}>{REWARD_TYPE_LABEL[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {f.reward_type === "cash" && (
              <div className="space-y-1">
                <Label>Valor (R$) *</Label>
                <Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.,]/g, "") })} placeholder="25,00" />
              </div>
            )}
          </div>

          {f.reward_type === "voucher" && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Prêmio do catálogo (imagem/estoque)</Label>
                <Select value={f.reward_id} onValueChange={(v) => setF({ ...f, reward_id: v, voucher_label: f.voucher_label || rewards.find((r) => r.id === v)?.name || "" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Sem vínculo</SelectItem>
                    {activeRewards.map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}{r.stock != null ? ` (estoque ${r.stock})` : ""}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Descrição do voucher</Label>
                <Input value={f.voucher_label} onChange={(e) => setF({ ...f, voucher_label: e.target.value })} placeholder="Voucher Outback R$ 100" />
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-3 gap-3 items-end">
            <div className="space-y-1">
              <Label>Máx. por período</Label>
              <Input inputMode="numeric" value={f.cap_per_period} onChange={(e) => setF({ ...f, cap_per_period: e.target.value.replace(/\D/g, "") })} />
            </div>
            <div className="space-y-1">
              <Label>Campanha</Label>
              <Select value={f.campaign_id} onValueChange={(v) => setF({ ...f, campaign_id: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Todas</SelectItem>
                  {campaign && <SelectItem value={campaign.id}>{campaign.name}</SelectItem>}
                  {rule?.campaign_id && rule.campaign_id !== campaign?.id && <SelectItem value={rule.campaign_id}>Campanha atual da regra</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center justify-between rounded-md border border-input px-3 h-10 text-sm">
              Ativa
              <Switch checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} />
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Salvar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ruleRewardText(r: CaptureRewardRule) {
  if (r.reward_type === "cash") return formatCents(r.amount_cents);
  if (r.reward_type === "voucher") return r.voucher_label || "Voucher";
  return "Selo";
}

function ruleConditionText(r: CaptureRewardRule) {
  if (r.event_type === "lead_validated") return `${r.threshold ?? "?"} válidos ${r.period_type === "month" ? "no mês" : "na semana"}`;
  if (r.event_type === "monthly_champion") return `mín. ${r.min_valid_leads ?? 1} válidos no mês`;
  return "por veículo";
}

function RulesTab() {
  const { data: rules = [], isLoading } = useCaptureRewardRules();
  const { data: rewards = [] } = useCaptureRewards();
  const del = useDeleteCaptureRewardRule();
  const save = useSaveCaptureRewardRule();
  const [dialog, setDialog] = useState<{ open: boolean; rule: CaptureRewardRule | null }>({ open: false, rule: null });
  const [toDelete, setToDelete] = useState<CaptureRewardRule | null>(null);

  const toggleActive = async (r: CaptureRewardRule) => {
    try {
      await save.mutateAsync({ ...r, active: !r.active });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try { await del.mutateAsync(toDelete.id); toast.success("Regra excluída"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Erro ao excluir"); }
    finally { setToDelete(null); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><ListChecks className="h-5 w-5 text-primary" /> Regras de prêmio</CardTitle>
            <CardDescription>O que a promotora ganha e quando. Aplicadas automaticamente pelo servidor.</CardDescription>
          </div>
          <Button onClick={() => setDialog({ open: true, rule: null })}><Plus className="h-4 w-4 mr-1" /> Nova regra</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-2">
            {(Object.keys(RULE_EVENT_META) as CaptureRuleEventType[]).map((k) => (
              <div key={k} className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-xs font-semibold">{RULE_EVENT_META[k].label}</p>
                <p className="text-[11px] text-muted-foreground leading-snug">{RULE_EVENT_META[k].hint}</p>
              </div>
            ))}
          </div>

          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : rules.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma regra ainda. Sem regra, nenhum prêmio é gerado.</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Regra</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Condição</TableHead>
                    <TableHead>Prêmio</TableHead>
                    <TableHead className="text-center">Máx./período</TableHead>
                    <TableHead className="text-center">Ativa</TableHead>
                    <TableHead className="w-[90px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => {
                    const linked = r.reward_id ? rewards.find((x) => x.id === r.reward_id) : null;
                    return (
                      <TableRow key={r.id} className={cn(!r.active && "opacity-60")}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell className="text-sm">{RULE_EVENT_META[r.event_type].label}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{ruleConditionText(r)}</TableCell>
                        <TableCell className="text-sm">
                          <span className="inline-flex items-center gap-2">
                            {linked?.image_url ? (
                              <img src={linked.image_url} alt="" className="h-7 w-7 rounded object-cover" />
                            ) : r.reward_type === "cash" ? <Coins className="h-4 w-4 text-emerald-600" /> : r.reward_type === "voucher" ? <Ticket className="h-4 w-4 text-purple-600" /> : <BadgeCheck className="h-4 w-4 text-sky-600" />}
                            <span className={cn(r.reward_type === "cash" && "font-semibold text-emerald-700")}>{ruleRewardText(r)}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-center text-sm">{r.cap_per_period}</TableCell>
                        <TableCell className="text-center"><Switch checked={r.active} onCheckedChange={() => toggleActive(r)} /></TableCell>
                        <TableCell>
                          <div className="flex gap-1 justify-end">
                            <Button variant="ghost" size="icon" onClick={() => setDialog({ open: true, rule: r })}><Pencil className="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" className="text-red-600" onClick={() => setToDelete(r)}><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {dialog.open && <RuleDialog rule={dialog.rule} nextPosition={rules.length + 1} onClose={() => setDialog({ open: false, rule: null })} />}

      <AlertDialog open={!!toDelete} onOpenChange={(v) => !v && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir a regra "{toDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>Os lançamentos já gerados no extrato continuam existindo; só novos eventos deixam de premiar.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={confirmDelete}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Aprovações (ledger)
// ═══════════════════════════════════════════════════════════════════════════

function StatTile({ label, value, icon: Icon, tone }: { label: string; value: string; icon: React.ElementType; tone: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-3 flex items-center gap-3">
      <div className={cn("h-9 w-9 rounded-md flex items-center justify-center shrink-0", tone)}><Icon className="h-4 w-4" /></div>
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="font-semibold tabular-nums truncate">{value}</p>
      </div>
    </div>
  );
}

function ApprovalsTab() {
  const [status, setStatus] = useState<CaptureLedgerStatus | "all">("pending");
  const [promoter, setPromoter] = useState<string>(NONE);
  const { data: all = [], isLoading } = useCaptureLedger({ limit: 500 });
  const { data: members = [] } = useAllTeamMembers();
  const setLedger = useSetLedgerStatus();
  const [cancelTarget, setCancelTarget] = useState<CaptureLedgerEntry | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const memberName = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((x) => m.set(x.id, x.name));
    return (id: string | null) => (id ? m.get(id) ?? "—" : null);
  }, [members]);

  const promoters = useMemo(() => {
    const ids = new Set(all.map((e) => e.promoter_id));
    return members.filter((m) => ids.has(m.id));
  }, [all, members]);

  const totals = useMemo(() => {
    const cash = (s: CaptureLedgerStatus) => all.filter((e) => e.status === s && e.reward_type === "cash").reduce((a, e) => a + e.amount_cents, 0);
    return {
      pending: cash("pending"),
      approved: cash("approved"),
      paid: cash("paid"),
      vouchersPending: all.filter((e) => e.reward_type !== "cash" && (e.status === "pending" || e.status === "approved")).length,
    };
  }, [all]);

  const list = all.filter((e) => (status === "all" || e.status === status) && (promoter === NONE || e.promoter_id === promoter));

  const act = async (e: CaptureLedgerEntry, s: "approved" | "paid") => {
    try {
      await setLedger.mutateAsync({ id: e.id, status: s });
      toast.success(s === "approved" ? "Aprovado" : e.reward_type === "cash" ? "Marcado como pago" : "Marcado como entregue");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    }
  };

  const confirmCancel = async () => {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) { toast.error("Informe o motivo"); return; }
    try {
      await setLedger.mutateAsync({ id: cancelTarget.id, status: "cancelled", reason: cancelReason.trim() });
      toast.success("Lançamento cancelado");
      setCancelTarget(null);
      setCancelReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao cancelar");
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatTile label="Pendente" value={formatCents(totals.pending)} icon={Coins} tone="bg-amber-100 text-amber-700" />
        <StatTile label="Aprovado" value={formatCents(totals.approved)} icon={BadgeCheck} tone="bg-emerald-100 text-emerald-700" />
        <StatTile label="Pago" value={formatCents(totals.paid)} icon={CheckCircle2} tone="bg-emerald-600 text-white" />
        <StatTile label="Vouchers a entregar" value={String(totals.vouchersPending)} icon={Ticket} tone="bg-purple-100 text-purple-700" />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2"><BadgeCheck className="h-5 w-5 text-primary" /> Aprovações</CardTitle>
            <CardDescription>Cada prêmio nasce pendente. Aprove, marque como pago/entregue ou cancele (com motivo). Tudo fica auditado.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v as CaptureLedgerStatus | "all")}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                {(Object.keys(LEDGER_STATUS_META) as CaptureLedgerStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>{LEDGER_STATUS_META[s].label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={promoter} onValueChange={setPromoter}>
              <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Todas as promotoras</SelectItem>
                {promoters.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhum lançamento {status === "pending" ? "pendente" : ""}.</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {list.map((e) => {
                const meta = LEDGER_STATUS_META[e.status];
                const canApprove = e.status === "pending";
                const canPay = e.status === "pending" || e.status === "approved";
                return (
                  <li key={e.id} className="py-3 flex items-start gap-3">
                    <div className="h-12 w-12 shrink-0 rounded-md overflow-hidden bg-muted/40 flex items-center justify-center">
                      {e.reward_image_url ? (
                        <img src={e.reward_image_url} alt="" className="h-full w-full object-cover" />
                      ) : e.reward_type === "cash" ? <Coins className="h-5 w-5 text-emerald-600" /> : e.reward_type === "voucher" ? <Ticket className="h-5 w-5 text-purple-600" /> : <BadgeCheck className="h-5 w-5 text-sky-600" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{e.promoter?.name ?? "—"}</p>
                        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{meta.label}</Badge>
                        <span className="font-semibold tabular-nums">
                          {e.reward_type === "cash" ? formatCents(e.amount_cents) : (e.voucher_label || "Voucher")}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground truncate">{e.title}</p>
                      <p className="text-xs text-muted-foreground">
                        Gerado em {fmtDate(e.earned_at, true)}
                        {e.approved_at && <> · aprovado {fmtDate(e.approved_at)}{memberName(e.approved_by) ? ` por ${memberName(e.approved_by)}` : ""}</>}
                        {e.paid_at && <> · {e.reward_type === "cash" ? "pago" : "entregue"} {fmtDate(e.paid_at)}{memberName(e.paid_by) ? ` por ${memberName(e.paid_by)}` : ""}</>}
                        {e.status === "cancelled" && <> · cancelado {fmtDate(e.cancelled_at)}{e.cancel_reason ? `: ${e.cancel_reason}` : ""}</>}
                        {e.note && <> · obs: {e.note}</>}
                      </p>
                    </div>
                    {(canApprove || canPay) && (
                      <div className="flex gap-1 shrink-0">
                        {canApprove && (
                          <Button size="sm" variant="outline" disabled={setLedger.isPending} onClick={() => act(e, "approved")}>
                            <BadgeCheck className="h-4 w-4 mr-1" /> Aprovar
                          </Button>
                        )}
                        {canPay && (
                          <Button size="sm" disabled={setLedger.isPending} onClick={() => act(e, "paid")}>
                            <CheckCircle2 className="h-4 w-4 mr-1" /> {e.reward_type === "cash" ? "Pagar" : "Entregar"}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="text-red-600" disabled={setLedger.isPending} onClick={() => { setCancelTarget(e); setCancelReason(""); }} title="Cancelar">
                          <Ban className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!cancelTarget} onOpenChange={(v) => !v && setCancelTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar lançamento</DialogTitle>
            <DialogDescription>
              {cancelTarget?.promoter?.name} — {cancelTarget?.title}. A promotora vê o motivo no extrato dela.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label>Motivo *</Label>
            <Textarea rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Ex.: lead duplicado / dados inconsistentes" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>Voltar</Button>
            <Button variant="destructive" disabled={setLedger.isPending} onClick={confirmCancel}>
              {setLedger.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Cancelar lançamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Ranking / ROI
// ═══════════════════════════════════════════════════════════════════════════

const pct = (v: number) => `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

function RankingTab() {
  const [period, setPeriod] = useState<CaptureRulePeriod>("month");
  const { data: rows = [], isLoading } = useCaptureRanking(period);
  const closeMonth = useCloseCaptureMonth();
  const [confirmClose, setConfirmClose] = useState(false);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.conv_captured - a.conv_captured || b.captured - a.captured || b.valid - a.valid || a.name.localeCompare(b.name)),
    [rows],
  );

  const doClose = async () => {
    setConfirmClose(false);
    try {
      const r = await closeMonth.mutateAsync(null);
      const month = r.month ? new Date(r.month + "T12:00:00").toLocaleDateString("pt-BR", { month: "long", year: "numeric" }) : "";
      if (!r.ok) {
        toast.warning(r.reason === "ninguém elegível" ? `Ninguém elegível em ${month}.` : r.reason ?? "Não foi possível fechar o mês");
        return;
      }
      if (r.already) {
        toast.info(`${r.champion} já foi premiada como campeã de ${month}.`);
      } else {
        toast.success(`Campeã de ${month}: ${r.champion} (${r.captured} captados / ${r.valid} válidos). Prêmio lançado como pendente.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao fechar o mês");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2"><Trophy className="h-5 w-5 text-amber-500" /> Ranking / ROI</CardTitle>
              <CardDescription>Quem converte mais e quanto custa cada carro captado.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={period} onValueChange={(v) => setPeriod(v as CaptureRulePeriod)}>
                <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="week">Esta semana</SelectItem>
                  <SelectItem value="month">Este mês</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" onClick={() => setConfirmClose(true)} disabled={closeMonth.isPending}>
                {closeMonth.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Crown className="h-4 w-4 mr-1 text-amber-500" />}
                Fechar mês anterior (campeã)
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma promotora com captação no período.</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">#</TableHead>
                    <TableHead>Promotora</TableHead>
                    <TableHead className="text-right">Enviados</TableHead>
                    <TableHead className="text-right">Válidos</TableHead>
                    <TableHead className="text-right">Captados</TableHead>
                    <TableHead className="text-right">Vendidos</TableHead>
                    <TableHead className="text-right">Pendente</TableHead>
                    <TableHead className="text-right">Aprovado</TableHead>
                    <TableHead className="text-right">Pago</TableHead>
                    <TableHead className="text-right">Custo/captação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sorted.map((r, i) => (
                    <TableRow key={r.member_id}>
                      <TableCell className="text-muted-foreground">{i === 0 && r.captured > 0 ? <Crown className="h-4 w-4 text-amber-500" /> : i + 1}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.submitted}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.valid} <span className="text-xs text-muted-foreground">({pct(r.validity_rate)})</span></TableCell>
                      <TableCell className="text-right tabular-nums">{r.captured} <span className="text-xs text-muted-foreground">({pct(r.conv_captured)})</span></TableCell>
                      <TableCell className="text-right tabular-nums">{r.sold} <span className="text-xs text-muted-foreground">({pct(r.conv_sold)})</span></TableCell>
                      <TableCell className="text-right tabular-nums text-amber-700">{formatCents(r.incentives_pending_cents)}</TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-700">{formatCents(r.incentives_approved_cents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCents(r.incentives_paid_cents)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.captured > 0 ? formatCents(r.cost_per_captured_cents) : "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-3">
            Válidos (%) = válidos ÷ enviados · Captados (%) = captados ÷ válidos · Vendidos (%) = vendidos ÷ captados · Custo/captação = incentivos não cancelados ÷ captados.
          </p>
        </CardContent>
      </Card>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fechar o mês anterior e premiar a campeã?</AlertDialogTitle>
            <AlertDialogDescription>
              Usa a regra "Campeã do mês": melhor conversão (captados ÷ válidos) entre quem atingiu o mínimo de leads válidos.
              O prêmio entra como pendente na aba Aprovações. Se já tiver sido fechado, nada é duplicado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={doClose}>Fechar mês</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Campanha (frase/objeção do dia)
// ═══════════════════════════════════════════════════════════════════════════

type CampaignForm = {
  name: string;
  starts_at: string;
  ends_at: string;
  location_id: string;
  focus_phrase: string;
  objection_phrase: string;
  objection_answer: string;
  is_active: boolean;
};

const EMPTY_CAMPAIGN: CampaignForm = {
  name: "", starts_at: new Date().toISOString().slice(0, 10), ends_at: "", location_id: NONE,
  focus_phrase: "", objection_phrase: "", objection_answer: "", is_active: true,
};

function toCampaignForm(c: CaptureCampaignFull): CampaignForm {
  return {
    name: c.name,
    starts_at: c.starts_at ?? "",
    ends_at: c.ends_at ?? "",
    location_id: c.location_id ?? NONE,
    focus_phrase: c.focus_phrase ?? "",
    objection_phrase: c.objection_phrase ?? "",
    objection_answer: c.objection_answer ?? "",
    is_active: c.is_active,
  };
}

function CampaignEditor({ campaign, onDone }: { campaign: CaptureCampaignFull | null; onDone?: () => void }) {
  const [f, setF] = useState<CampaignForm>(campaign ? toCampaignForm(campaign) : EMPTY_CAMPAIGN);
  const { data: locations = [] } = useCaptureLocations();
  const save = useSaveCaptureCampaign();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.name.trim()) { toast.error("Dê um nome pra campanha"); return; }
    try {
      await save.mutateAsync({
        id: campaign?.id,
        name: f.name.trim(),
        starts_at: f.starts_at || null,
        ends_at: f.ends_at || null,
        location_id: f.location_id === NONE ? null : f.location_id,
        focus_phrase: f.focus_phrase.trim() || null,
        objection_phrase: f.objection_phrase.trim() || null,
        objection_answer: f.objection_answer.trim() || null,
        is_active: f.is_active,
      });
      toast.success(campaign ? "Campanha salva" : "Campanha criada");
      onDone?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1 sm:col-span-2">
          <Label>Nome *</Label>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Venda seu carro no Tamboré" />
        </div>
        <div className="space-y-1">
          <Label>Início</Label>
          <Input type="date" value={f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Fim (vazio = sem fim)</Label>
          <Input type="date" value={f.ends_at} onChange={(e) => setF({ ...f, ends_at: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Local</Label>
          <Select value={f.location_id} onValueChange={(v) => setF({ ...f, location_id: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sem local</SelectItem>
              {locations.filter((l) => l.is_active || l.id === f.location_id).map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center justify-between rounded-md border border-input px-3 h-10 text-sm self-end">
          Campanha ativa
          <Switch checked={f.is_active} onCheckedChange={(v) => setF({ ...f, is_active: v })} />
        </label>
      </div>
      <div className="space-y-1">
        <Label>Frase do dia (abordagem)</Label>
        <Textarea rows={2} value={f.focus_phrase} onChange={(e) => setF({ ...f, focus_phrase: e.target.value })} placeholder="Você tem carro? Já pensou em vender aqui no shopping? A Totex avalia de graça e cuida de tudo." />
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Objeção do dia</Label>
          <Textarea rows={3} value={f.objection_phrase} onChange={(e) => setF({ ...f, objection_phrase: e.target.value })} placeholder="Não quero vender agora." />
        </div>
        <div className="space-y-1">
          <Label>Como responder</Label>
          <Textarea rows={3} value={f.objection_answer} onChange={(e) => setF({ ...f, objection_answer: e.target.value })} placeholder="Tranquilo! Está pensando em trocar nos próximos meses? Deixo registrado e nosso especialista te manda a avaliação, sem compromisso." />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        {onDone && campaign === null && <Button type="button" variant="outline" onClick={onDone}>Cancelar</Button>}
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
          {campaign ? "Salvar campanha" : "Criar campanha"}
        </Button>
      </div>
    </form>
  );
}

function CampaignTab() {
  const { data: campaign, isLoading } = useCaptureCampaignForEdit();
  const [creating, setCreating] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><Megaphone className="h-5 w-5 text-primary" /> Campanha ativa</CardTitle>
        <CardDescription>Nome, período, local e a frase/objeção do dia que a promotora vê na tela "Hoje".</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
        ) : campaign ? (
          <CampaignEditor key={campaign.id} campaign={campaign} />
        ) : creating ? (
          <CampaignEditor campaign={null} onDone={() => setCreating(false)} />
        ) : (
          <div className="py-6 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Nenhuma campanha ativa. Sem campanha a promotora não vê frase nem objeção do dia.</p>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" /> Criar campanha</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Seção
// ═══════════════════════════════════════════════════════════════════════════

export function CaptureRewardsSection() {
  const { data: pendingLedger = [] } = useCaptureLedger({ status: "pending", limit: 200 });
  const pendingCount = pendingLedger.length;

  return (
    <div className="space-y-4 max-w-5xl">
      <Tabs defaultValue={pendingCount > 0 ? "aprovacoes" : "regras"} className="space-y-4">
        <TabsList className="flex flex-wrap h-auto justify-start">
          <TabsTrigger value="regras" className="gap-1.5"><ListChecks className="h-4 w-4" /> Regras</TabsTrigger>
          <TabsTrigger value="aprovacoes" className="gap-1.5">
            <BadgeCheck className="h-4 w-4" /> Aprovações
            {pendingCount > 0 && <Badge className="ml-1 h-5 px-1.5 text-[11px]">{pendingCount}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="ranking" className="gap-1.5"><Trophy className="h-4 w-4" /> Ranking / ROI</TabsTrigger>
          <TabsTrigger value="catalogo" className="gap-1.5"><Gift className="h-4 w-4" /> Catálogo</TabsTrigger>
          <TabsTrigger value="campanha" className="gap-1.5"><Megaphone className="h-4 w-4" /> Campanha</TabsTrigger>
        </TabsList>
        <TabsContent value="regras"><RulesTab /></TabsContent>
        <TabsContent value="aprovacoes"><ApprovalsTab /></TabsContent>
        <TabsContent value="ranking"><RankingTab /></TabsContent>
        <TabsContent value="catalogo"><CatalogTab /></TabsContent>
        <TabsContent value="campanha"><CampaignTab /></TabsContent>
      </Tabs>
    </div>
  );
}
