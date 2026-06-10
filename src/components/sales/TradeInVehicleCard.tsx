import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeftRight, Pencil, Save, X, Trash2, Plus, Gauge, Calendar } from "lucide-react";
import {
  useTradeInByLead,
  useUpsertTradeIn,
  useDeleteTradeIn,
  type TradeInInput,
} from "@/hooks/useTradeInVehicles";
import { toast } from "sonner";

interface Props {
  leadId: string;
  dealId?: string | null;
  vehiclePrice?: number | null;
}

function fmt(v?: number | null) {
  if (v == null) return null;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseNum(raw: string): number | null {
  const clean = raw.replace(/[^\d,]/g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

const BLANK_FORM = {
  marca: "",
  modelo: "",
  versao: "",
  ano: "",
  km: "",
  placa: "",
  condicao: "" as "" | "otimo" | "bom" | "regular" | "ruim",
  valor_pedido: "",
  valor_avaliado: "",
  observacoes: "",
};

export function TradeInVehicleCard({ leadId, dealId, vehiclePrice }: Props) {
  const { data: tradeIn, isLoading } = useTradeInByLead(leadId);
  const upsert = useUpsertTradeIn();
  const remove = useDeleteTradeIn();

  const [editing, setEditing] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const [form, setForm] = useState(BLANK_FORM);

  function openEdit() {
    if (tradeIn) {
      setForm({
        marca: tradeIn.marca ?? "",
        modelo: tradeIn.modelo ?? "",
        versao: tradeIn.versao ?? "",
        ano: tradeIn.ano != null ? String(tradeIn.ano) : "",
        km: tradeIn.km != null ? String(tradeIn.km) : "",
        placa: tradeIn.placa ?? "",
        condicao: (tradeIn.condicao ?? "") as typeof form.condicao,
        valor_pedido: tradeIn.valor_pedido != null ? String(tradeIn.valor_pedido) : "",
        valor_avaliado: tradeIn.valor_avaliado != null ? String(tradeIn.valor_avaliado) : "",
        observacoes: tradeIn.observacoes ?? "",
      });
    } else {
      setForm(BLANK_FORM);
    }
    setEditing(true);
  }

  async function handleSave() {
    const data: Partial<TradeInInput> = {
      lead_id: leadId,
      deal_id: dealId ?? null,
      marca: form.marca || null,
      modelo: form.modelo || null,
      versao: form.versao || null,
      ano: form.ano ? parseInt(form.ano, 10) : null,
      km: form.km ? parseInt(form.km.replace(/\D/g, ""), 10) : null,
      placa: form.placa || null,
      condicao: form.condicao || null,
      valor_pedido: parseNum(form.valor_pedido),
      valor_avaliado: parseNum(form.valor_avaliado),
      observacoes: form.observacoes || null,
    };
    try {
      await upsert.mutateAsync({ id: tradeIn?.id, data });
      toast.success("Veículo na troca salvo");
      setEditing(false);
    } catch {
      toast.error("Erro ao salvar veículo na troca");
    }
  }

  async function handleDelete() {
    if (!tradeIn) return;
    try {
      await remove.mutateAsync({ id: tradeIn.id, leadId, dealId });
      toast.success("Veículo na troca removido");
      setShowDelete(false);
    } catch {
      toast.error("Erro ao remover veículo na troca");
    }
  }

  if (isLoading) return null;

  const condicaoLabel: Record<string, string> = {
    otimo: "Ótimo",
    bom: "Bom",
    regular: "Regular",
    ruim: "Ruim",
  };

  // Diferença = preço do veículo de interesse - valor avaliado da troca
  const diferenca =
    vehiclePrice != null && tradeIn?.valor_avaliado != null
      ? vehiclePrice - tradeIn.valor_avaliado
      : null;

  if (editing) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-amber-500" /> Veículo na Troca
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditing(false)}>
                <X className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSave} disabled={upsert.isPending}>
                <Save className="h-3 w-3" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Marca</Label>
              <Input className="h-7 text-xs" placeholder="ex: Fiat" value={form.marca}
                onChange={(e) => setForm((f) => ({ ...f, marca: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Modelo</Label>
              <Input className="h-7 text-xs" placeholder="ex: Pulse" value={form.modelo}
                onChange={(e) => setForm((f) => ({ ...f, modelo: e.target.value }))} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Versão</Label>
              <Input className="h-7 text-xs" placeholder="ex: Drive" value={form.versao}
                onChange={(e) => setForm((f) => ({ ...f, versao: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ano</Label>
              <Input className="h-7 text-xs" placeholder="ex: 2021" maxLength={4} value={form.ano}
                onChange={(e) => setForm((f) => ({ ...f, ano: e.target.value.replace(/\D/g, "") }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Placa</Label>
              <Input className="h-7 text-xs" placeholder="ex: ABC1D23" value={form.placa}
                onChange={(e) => setForm((f) => ({ ...f, placa: e.target.value.toUpperCase() }))} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Km</Label>
              <Input className="h-7 text-xs" placeholder="ex: 45000" value={form.km}
                onChange={(e) => setForm((f) => ({ ...f, km: e.target.value.replace(/\D/g, "") }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Condição</Label>
              <Select value={form.condicao} onValueChange={(v) => setForm((f) => ({ ...f, condicao: v as typeof form.condicao }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="otimo">Ótimo</SelectItem>
                  <SelectItem value="bom">Bom</SelectItem>
                  <SelectItem value="regular">Regular</SelectItem>
                  <SelectItem value="ruim">Ruim</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Valor pedido (R$)</Label>
              <Input className="h-7 text-xs" placeholder="ex: 25000" value={form.valor_pedido}
                onChange={(e) => setForm((f) => ({ ...f, valor_pedido: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Valor avaliado (R$)</Label>
              <Input className="h-7 text-xs" placeholder="ex: 22000" value={form.valor_avaliado}
                onChange={(e) => setForm((f) => ({ ...f, valor_avaliado: e.target.value }))} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Observações</Label>
            <Textarea className="text-xs min-h-[56px] resize-none" placeholder="Estado do veículo, histórico..." value={form.observacoes}
              onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))} />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!tradeIn) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-amber-500" /> Veículo na Troca
            </span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}>
              <Plus className="h-3 w-3" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Nenhum veículo de troca registrado.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <ArrowLeftRight className="h-4 w-4 text-amber-500" /> Veículo na Troca
            </span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowDelete(true)}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}>
                <Pencil className="h-3 w-3" />
              </Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div>
            <p className="font-medium text-sm leading-tight">
              {[tradeIn.marca, tradeIn.modelo].filter(Boolean).join(" ") || "Veículo"}
            </p>
            {tradeIn.versao && <p className="text-xs text-muted-foreground">{tradeIn.versao}</p>}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {tradeIn.ano && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" /> {tradeIn.ano}
              </span>
            )}
            {tradeIn.km != null && (
              <span className="flex items-center gap-1">
                <Gauge className="h-3 w-3" /> {tradeIn.km.toLocaleString("pt-BR")} km
              </span>
            )}
            {tradeIn.condicao && (
              <span className="capitalize">{condicaoLabel[tradeIn.condicao]}</span>
            )}
            {tradeIn.placa && <span className="font-mono uppercase">{tradeIn.placa}</span>}
          </div>

          <div className="space-y-0.5 text-xs">
            {tradeIn.valor_pedido != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Valor pedido</span>
                <span>{fmt(tradeIn.valor_pedido)}</span>
              </div>
            )}
            {tradeIn.valor_avaliado != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Avaliado em</span>
                <span className="font-semibold text-amber-600">{fmt(tradeIn.valor_avaliado)}</span>
              </div>
            )}
          </div>

          {diferenca != null && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs space-y-0.5 border">
              <div className="flex justify-between text-muted-foreground">
                <span>Veículo de interesse</span>
                <span>{fmt(vehiclePrice)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>— Avaliação troca</span>
                <span>− {fmt(tradeIn.valor_avaliado)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                <span>Diferença</span>
                <span className={diferenca > 0 ? "text-primary" : "text-green-600"}>
                  {fmt(diferenca)}
                </span>
              </div>
            </div>
          )}

          {tradeIn.observacoes && (
            <p className="text-xs text-muted-foreground italic">{tradeIn.observacoes}</p>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover veículo na troca?</AlertDialogTitle>
            <AlertDialogDescription>
              Essa ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive hover:bg-destructive/90">
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
