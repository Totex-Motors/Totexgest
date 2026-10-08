import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Store, Plus, AlertTriangle, ArrowRight, Loader2, Phone, MapPin, Wallet, ExternalLink,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { PipelineKanban } from "@/components/sales/PipelineKanban";
import { LoseDealModal } from "@/components/sales/LoseDealModal";
import { useAuth } from "@/contexts/AuthContext";
import { usePipelineDeals } from "@/hooks/useSalesPipeline";
import { useMoveDealStage } from "@/hooks/useSalesDeals";
import {
  useCreateFranchiseLead, useFranchiseEnsureDeal, useFranchiseLeads, useFranchisePipeline,
} from "@/hooks/useFranchise";
import { FRANCHISE_PIPELINE_NAME } from "@/lib/franchise";
import { LEAD_KIND_LABEL } from "@/lib/leadKind";
import { leadSourceLabel } from "@/lib/leadKind";
import type { Deal } from "@/types/sales.types";
import { cn } from "@/lib/utils";

/**
 * Franqueados — recrutamento de lojista/franqueado (lead_kind = 'franchise').
 *
 * Funil PRÓPRIO ("Recrutamento de Franqueados"), separado do funil de carro:
 * Novo → Contato → Demo enviada → Demo assistida → Call agendada → Call realizada →
 * Proposta → Fechado / Perdido. Entradas: campanha de franquia (receive-lead),
 * marketplace LOJISTA, cadastro manual aqui. A etapa é consequência do evento
 * (sala de demo seta "Demo enviada"/"Demo assistida"); mover na mão é permitido
 * só pras etapas humanas (contato, call, proposta, fechado/perdido).
 */

const onlyDigits = (s: string) => s.replace(/\D/g, "");

function NewFranchiseDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (leadId: string) => void }) {
  const { tenantId } = useAuth();
  const create = useCreateFranchiseLead();
  const [form, setForm] = useState({ name: "", phone: "", email: "", city: "", state: "", capital: "", notes: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const phoneDigits = onlyDigits(form.phone);
  const canSave = form.name.trim().length >= 2 && phoneDigits.length >= 10 && !!tenantId;

  const submit = async () => {
    if (!canSave || !tenantId) return;
    try {
      const r = await create.mutateAsync({
        tenantId,
        name: form.name.trim(),
        phone: phoneDigits,
        email: form.email.trim() || undefined,
        city: form.city.trim() || undefined,
        state: form.state.trim() || undefined,
        capital: form.capital.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      if (r.lead_kind !== "franchise") {
        toast.warning(`Este telefone já existe como ${LEAD_KIND_LABEL[r.lead_kind as keyof typeof LEAD_KIND_LABEL] || r.lead_kind}.`, {
          description: "Não foi convertido em franqueado. Abra o lead pra conferir.",
          action: { label: "Abrir lead", onClick: () => onCreated(r.lead_id) },
        });
      } else if (!r.created) {
        toast.info("Esse franqueado já estava cadastrado.", { description: "Garantimos que ele está no funil." });
        onCreated(r.lead_id);
      } else {
        toast.success("Franqueado cadastrado e colocado no funil.");
        onCreated(r.lead_id);
      }
      setForm({ name: "", phone: "", email: "", city: "", state: "", capital: "", notes: "" });
      onOpenChange(false);
    } catch (e) {
      toast.error("Não foi possível cadastrar", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Store className="h-5 w-5 text-violet-600" /> Novo franqueado</DialogTitle>
          <DialogDescription>
            Lojista interessado em ser franqueado. Entra na etapa <b>Novo</b> do funil de recrutamento.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="fr-name">Nome *</Label>
            <Input id="fr-name" value={form.name} onChange={set("name")} placeholder="Nome do lojista" autoFocus />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="fr-phone">WhatsApp *</Label>
              <Input id="fr-phone" inputMode="tel" value={form.phone} onChange={set("phone")} placeholder="(11) 99999-9999" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fr-email">E-mail</Label>
              <Input id="fr-email" type="email" value={form.email} onChange={set("email")} placeholder="opcional" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5 col-span-2">
              <Label htmlFor="fr-city">Cidade</Label>
              <Input id="fr-city" value={form.city} onChange={set("city")} placeholder="Cidade da loja" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fr-uf">UF</Label>
              <Input id="fr-uf" maxLength={2} value={form.state} onChange={set("state")} placeholder="SP" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fr-capital">Capital disponível</Label>
            <Input id="fr-capital" value={form.capital} onChange={set("capital")} placeholder="ex.: R$ 150 mil" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fr-notes">Observações</Label>
            <Textarea id="fr-notes" rows={2} value={form.notes} onChange={set("notes")} placeholder="Como chegou, o que já conversou…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancelar</Button>
          <Button onClick={submit} disabled={!canSave || create.isPending} className="bg-violet-600 hover:bg-violet-700">
            {create.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Cadastrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Franqueados() {
  const navigate = useNavigate();
  const { pipeline, isLoading: loadingPipelines } = useFranchisePipeline();
  const { data: columns, isLoading: loadingDeals } = usePipelineDeals(undefined, pipeline?.id);
  const { data: franchiseLeads } = useFranchiseLeads();
  const moveDeal = useMoveDealStage();
  const ensureDeal = useFranchiseEnsureDeal();
  const [newOpen, setNewOpen] = useState(false);
  const [loseTarget, setLoseTarget] = useState<Deal | null>(null);

  // Só as colunas DESTE pipeline (usePipelineDeals sem pipelineId traria tudo)
  const board = useMemo(() => (pipeline ? columns || [] : []), [pipeline, columns]);

  const kpis = useMemo(() => {
    const byName = (needle: string) =>
      board.filter((c) => c.stage.name.toLowerCase().includes(needle)).reduce((n, c) => n + c.deals.length, 0);
    const open = board.filter((c) => !c.stage.is_won && !c.stage.is_lost).reduce((n, c) => n + c.deals.length, 0);
    return {
      open,
      novo: byName("novo"),
      demo: byName("demo"),
      call: byName("call"),
      proposta: byName("proposta"),
      fechado: board.filter((c) => c.stage.is_won).reduce((n, c) => n + c.deals.length, 0),
      perdido: board.filter((c) => c.stage.is_lost).reduce((n, c) => n + c.deals.length, 0),
    };
  }, [board]);

  // Franqueados sem deal no funil de recrutamento (lead antigo, erro no trigger, etc.)
  const outOfFunnel = useMemo(() => {
    if (!pipeline) return [];
    return (franchiseLeads || []).filter((l) => !(l.deals || []).some((d) => d.pipeline_id === pipeline.id));
  }, [franchiseLeads, pipeline]);

  const handleDealMove = async (dealId: string, fromStageId: string, toStageId: string) => {
    const target = board.find((c) => c.stage.id === toStageId);
    if (target?.stage.is_lost) {
      const deal = board.find((c) => c.stage.id === fromStageId)?.deals.find((d) => d.id === dealId);
      if (deal) { setLoseTarget(deal); return; }
    }
    try {
      await moveDeal.mutateAsync({ dealId, stageId: toStageId });
      toast.success(`Movido para ${target?.stage.name || "nova etapa"}`);
    } catch (e) {
      toast.error("Erro ao mover", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleEnsure = async (leadId: string) => {
    try {
      await ensureDeal.mutateAsync(leadId);
      toast.success("Colocado no funil (etapa Novo).");
    } catch (e) {
      toast.error("Não deu pra colocar no funil", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const openLead = (leadId: string) => navigate(`/comercial/leads/${leadId}`);
  const isLoading = loadingPipelines || (!!pipeline && loadingDeals);

  return (
    <AppLayout>
      <div className="flex flex-col h-full animate-fade-in">
        {/* Header */}
        <div className="flex-shrink-0 space-y-3 pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-foreground flex items-center gap-3">
                <Store className="h-6 w-6 sm:h-7 sm:w-7 text-violet-600" />
                Franqueados
              </h1>
              <p className="text-sm text-muted-foreground">
                Recrutamento de lojistas — funil separado do de carro. {kpis.open} em andamento.
              </p>
            </div>
            <Button onClick={() => setNewOpen(true)} className="bg-violet-600 hover:bg-violet-700" disabled={!pipeline}>
              <Plus className="h-4 w-4 mr-1" /> Novo franqueado
            </Button>
          </div>

          {/* KPIs por fase */}
          {pipeline && (
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {[
                { label: "Novos", v: kpis.novo, cls: "text-slate-700" },
                { label: "Em demo", v: kpis.demo, cls: "text-indigo-700" },
                { label: "Em call", v: kpis.call, cls: "text-amber-700" },
                { label: "Proposta", v: kpis.proposta, cls: "text-orange-700" },
                { label: "Fechados", v: kpis.fechado, cls: "text-green-700" },
                { label: "Perdidos", v: kpis.perdido, cls: "text-red-700" },
              ].map((k) => (
                <Card key={k.label} className="shadow-none border-border/60">
                  <CardContent className="p-2.5 text-center">
                    <p className={cn("text-lg font-bold leading-tight", k.cls)}>{k.v}</p>
                    <p className="text-[11px] text-muted-foreground">{k.label}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Sem funil neste tenant */}
          {!loadingPipelines && !pipeline && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Funil de recrutamento não encontrado</AlertTitle>
              <AlertDescription>
                Esta loja não tem um pipeline chamado “{FRANCHISE_PIPELINE_NAME}”. Ele existe na Totex Motors (HQ).
                {(franchiseLeads?.length || 0) > 0 && ` Há ${franchiseLeads!.length} franqueado(s) cadastrado(s) aqui sem funil.`}
              </AlertDescription>
            </Alert>
          )}

          {/* Fora do funil */}
          {pipeline && outOfFunnel.length > 0 && (
            <Alert className="border-amber-300 bg-amber-50 dark:bg-amber-950/30">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              <AlertTitle className="text-amber-900 dark:text-amber-200">
                {outOfFunnel.length} franqueado{outOfFunnel.length > 1 ? "s" : ""} fora do funil
              </AlertTitle>
              <AlertDescription>
                <ul className="mt-1 space-y-1">
                  {outOfFunnel.slice(0, 8).map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <button className="font-medium hover:underline" onClick={() => openLead(l.id)}>{l.name || l.phone || "Sem nome"}</button>
                      {l.phone && <span className="text-muted-foreground inline-flex items-center gap-1"><Phone className="h-3 w-3" />{l.phone}</span>}
                      {(l.city_name || l.state) && <span className="text-muted-foreground inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{[l.city_name, l.state].filter(Boolean).join("/")}</span>}
                      {l.capital_disponivel && <span className="text-muted-foreground inline-flex items-center gap-1"><Wallet className="h-3 w-3" />{l.capital_disponivel}</span>}
                      <Badge variant="outline" className="text-[10px]">{leadSourceLabel(l.source, l.utm_source)}</Badge>
                      <Button size="sm" variant="outline" className="h-7 ml-auto" disabled={ensureDeal.isPending} onClick={() => handleEnsure(l.id)}>
                        Colocar no funil <ArrowRight className="h-3 w-3 ml-1" />
                      </Button>
                    </li>
                  ))}
                  {outOfFunnel.length > 8 && <li className="text-xs text-muted-foreground">… e mais {outOfFunnel.length - 8}.</li>}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </div>

        {/* Kanban */}
        {pipeline && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className="bg-slate-50/80 rounded-2xl p-4 h-full overflow-x-auto">
              <PipelineKanban
                columns={board}
                onDealClick={(deal) => deal.lead_id && navigate(`/comercial/leads/${deal.lead_id}?deal=${deal.id}`)}
                onViewLead={openLead}
                onDealMove={handleDealMove}
                isLoading={isLoading}
                sortBy="recent"
              />
            </div>
          </div>
        )}

        {pipeline && (
          <p className="flex-shrink-0 pt-2 text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <ExternalLink className="h-3 w-3" />
            “Demo enviada” e “Demo assistida” são marcadas pela sala de demo; as demais etapas você move aqui.
          </p>
        )}
      </div>

      <NewFranchiseDialog open={newOpen} onOpenChange={setNewOpen} onCreated={() => { /* fica na tela: o card aparece no funil */ }} />
      <LoseDealModal open={!!loseTarget} onOpenChange={(o) => { if (!o) setLoseTarget(null); }} deal={loseTarget} />
    </AppLayout>
  );
}
