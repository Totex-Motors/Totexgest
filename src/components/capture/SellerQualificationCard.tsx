import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pencil, Save, X, Gauge } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useUpdateMyCaptureLead } from "@/hooks/useCaptureLeads";
import {
  computeCaptureScore,
  temperatureFromScore,
  INTENT_LABEL,
  MOTIVO_OPTIONS,
  PRAZO_LABEL,
  TEMP_META,
  type CaptureLead,
  type SellerQualification,
} from "@/types/capture";

/**
 * Qualificação de INTERMEDIAÇÃO (proprietário que quer vender). Irmã do
 * LeadQualificationCard (compra), mas com semântica própria: prazo pra vender,
 * motivo, é proprietário, aceita avaliação, autoriza contato do especialista.
 * Salva via RPC update_my_capture_lead (promotora só edita os próprios leads).
 */

const ACEITA_LABEL: Record<string, string> = { sim: "Sim", talvez: "Talvez", nao: "Não" };

function yesNo(v?: boolean | null) {
  return v === true ? "Sim" : v === false ? "Não" : "—";
}

/** Segmented control com botões grandes (uso em pé, no celular). */
function Segment<T extends string>({
  value, options, onChange,
}: { value?: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-10 rounded-md border text-sm font-medium transition-colors",
            value === o.value
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background hover:bg-muted border-input",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SellerQualificationCard({ lead }: { lead: CaptureLead }) {
  const q = lead.seller_qualification ?? {};
  const v = lead.vehicle;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SellerQualification>(q);
  const [km, setKm] = useState<string>(v?.km != null ? String(v.km) : "");
  const update = useUpdateMyCaptureLead();

  const previewScore = computeCaptureScore(form, {
    description: v?.description ?? undefined,
    model: v?.model ?? undefined,
    year_model: v?.year_model,
    km: km || v?.km,
  });
  const previewTemp = temperatureFromScore(previewScore);
  const temp = TEMP_META[lead.temperatura] ?? TEMP_META.frio;

  const startEdit = () => {
    setForm(q);
    setKm(v?.km != null ? String(v.km) : "");
    setEditing(true);
  };

  const save = async () => {
    try {
      const res = await update.mutateAsync({
        leadId: lead.id,
        patch: {
          qualification: form,
          vehicle: km ? { km: Number(km) } : undefined,
        },
      });
      toast.success(`Qualificação salva — ${TEMP_META[res.temperatura].label} (${res.score})`);
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Gauge className="h-4 w-4 text-muted-foreground" /> Qualificação
        </CardTitle>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={startEdit}><Pencil className="h-4 w-4 mr-1" /> Editar</Button>
        ) : (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={update.isPending}><X className="h-4 w-4" /></Button>
            <Button size="sm" onClick={save} disabled={update.isPending}><Save className="h-4 w-4 mr-1" /> Salvar</Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Termômetro */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <Badge variant="outline" className={cn("border", (editing ? TEMP_META[previewTemp] : temp).cls)}>
              {(editing ? TEMP_META[previewTemp] : temp).label}
            </Badge>
            <span className="text-xs text-muted-foreground">Score {editing ? previewScore : (q.score ?? lead.sales_score ?? 0)}/100</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className={cn("h-full transition-all", (editing ? TEMP_META[previewTemp] : temp).bar)}
              style={{ width: `${Math.min(100, editing ? previewScore : (q.score ?? lead.sales_score ?? 0))}%` }}
            />
          </div>
        </div>

        {!editing ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Intenção</dt><dd>{q.intent ? INTENT_LABEL[q.intent] : "—"}</dd>
            <dt className="text-muted-foreground">Quando quer vender</dt><dd>{q.prazo_venda ? PRAZO_LABEL[q.prazo_venda] : "—"}</dd>
            <dt className="text-muted-foreground">Motivo</dt><dd>{MOTIVO_OPTIONS.find((m) => m.value === q.motivo)?.label ?? "—"}</dd>
            <dt className="text-muted-foreground">É o proprietário</dt><dd>{yesNo(q.is_owner)}</dd>
            <dt className="text-muted-foreground">Aceita avaliação</dt><dd>{q.aceita_avaliacao ? ACEITA_LABEL[q.aceita_avaliacao] : "—"}</dd>
            <dt className="text-muted-foreground">Autoriza contato</dt><dd>{yesNo(q.autoriza_contato)}</dd>
            <dt className="text-muted-foreground">Valor em mente</dt>
            <dd>{q.expectativa_valor ? Number(q.expectativa_valor).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }) : "—"}</dd>
            <dt className="text-muted-foreground">KM</dt><dd>{v?.km != null ? v.km.toLocaleString("pt-BR") : "—"}</dd>
            {q.observacao && (
              <>
                <dt className="text-muted-foreground col-span-2">Observação</dt>
                <dd className="col-span-2 whitespace-pre-wrap">{q.observacao}</dd>
              </>
            )}
          </dl>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Quando pensa em vender?</Label>
              <Segment
                value={form.prazo_venda}
                options={(Object.keys(PRAZO_LABEL) as (keyof typeof PRAZO_LABEL)[]).map((k) => ({ value: k, label: PRAZO_LABEL[k] }))}
                onChange={(prazo_venda) => setForm({ ...form, prazo_venda })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Por que quer vender?</Label>
              <Select value={form.motivo ?? ""} onValueChange={(motivo) => setForm({ ...form, motivo })}>
                <SelectTrigger className="h-11"><SelectValue placeholder="Escolha um motivo" /></SelectTrigger>
                <SelectContent>
                  {MOTIVO_OPTIONS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>É o proprietário do carro?</Label>
              <Segment
                value={form.is_owner === true ? "sim" : form.is_owner === false ? "nao" : undefined}
                options={[{ value: "sim", label: "Sim" }, { value: "nao", label: "Não" }]}
                onChange={(val) => setForm({ ...form, is_owner: val === "sim" })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Aceita uma avaliação gratuita?</Label>
              <Segment
                value={form.aceita_avaliacao}
                options={[{ value: "sim", label: "Sim" }, { value: "talvez", label: "Talvez" }, { value: "nao", label: "Não" }]}
                onChange={(aceita_avaliacao) => setForm({ ...form, aceita_avaliacao })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Autoriza nosso especialista a chamar no WhatsApp?</Label>
              <Segment
                value={form.autoriza_contato === true ? "sim" : form.autoriza_contato === false ? "nao" : undefined}
                options={[{ value: "sim", label: "Sim" }, { value: "nao", label: "Não" }]}
                onChange={(val) => setForm({ ...form, autoriza_contato: val === "sim" })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>KM aproximado</Label>
                <Input inputMode="numeric" value={km} onChange={(e) => setKm(e.target.value.replace(/\D/g, ""))} placeholder="45000" className="h-11" />
              </div>
              <div className="space-y-1.5">
                <Label>Valor em mente (R$)</Label>
                <Input
                  inputMode="numeric"
                  value={form.expectativa_valor ?? ""}
                  onChange={(e) => setForm({ ...form, expectativa_valor: e.target.value.replace(/\D/g, "") })}
                  placeholder="65000"
                  className="h-11"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Observação (uma frase)</Label>
              <Textarea
                rows={2}
                value={form.observacao ?? ""}
                onChange={(e) => setForm({ ...form, observacao: e.target.value })}
                placeholder="Ex.: carro da esposa, quer trocar por SUV até dezembro"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
