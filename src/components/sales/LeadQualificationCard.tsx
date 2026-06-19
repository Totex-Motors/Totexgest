import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil, Save, X, Gauge, Flame, CalendarClock, Sparkles } from "lucide-react";
import { useUpdateLeadMetadata } from "@/hooks/useSalesLeads";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Qualificação por INTENÇÃO DE COMPRA (contexto automotivo Totex).
 * Preenchida automaticamente pelo agente do stand (repassar_lead_loja) e editável
 * pelo vendedor. Armazenada em leads.metadata.qualificacao.
 */
export interface LeadQualificacao {
  categoria?: string | null;
  temperatura?: string | null;
  probabilidade?: number | null;
  prazo_compra?: string | null;
  orcamento?: string | null;
  forma_pagamento?: string | null;
  tem_troca?: boolean | null;
  interesse_financiamento?: boolean | null;
  interesse_proposta?: boolean | null;
  interesse_test_drive?: boolean | null;
  interesse_visita?: boolean | null;
  observacoes?: string | null;
  qualificado_em?: string | null;
  origem?: string | null;
}

const CATEGORIA_LABEL: Record<string, string> = {
  curioso: "Curioso",
  sonhador: "Sonhador",
  pesquisador: "Pesquisador",
  comprador_planejado: "Comprador Planejado",
  comprador_ativo: "Comprador Ativo",
  comprador_oculto: "Comprador Oculto",
};

const PRAZO_LABEL: Record<string, string> = {
  ate_30_dias: "Até 30 dias",
  ate_90_dias: "Até 90 dias",
  ate_6_meses: "Até 6 meses",
  acima_6_meses: "Acima de 6 meses",
  sem_previsao: "Sem previsão",
};

const TEMP_META: Record<string, { label: string; cls: string; bar: string }> = {
  frio: { label: "Frio", cls: "bg-sky-100 text-sky-700 border-sky-200", bar: "bg-sky-500" },
  morno: { label: "Morno", cls: "bg-amber-100 text-amber-700 border-amber-200", bar: "bg-amber-500" },
  quente: { label: "Quente", cls: "bg-orange-100 text-orange-700 border-orange-200", bar: "bg-orange-500" },
  muito_quente: { label: "Muito Quente", cls: "bg-red-100 text-red-700 border-red-200", bar: "bg-red-500" },
};

const INTERESSES: { key: keyof LeadQualificacao; label: string }[] = [
  { key: "interesse_financiamento", label: "Financiamento" },
  { key: "interesse_proposta", label: "Proposta" },
  { key: "interesse_test_drive", label: "Test drive" },
  { key: "interesse_visita", label: "Visita" },
  { key: "tem_troca", label: "Troca" },
];

function isEmptyQual(q?: LeadQualificacao | null): boolean {
  if (!q) return true;
  return !q.categoria && !q.temperatura && q.probabilidade == null && !q.prazo_compra &&
    !q.observacoes && !q.interesse_financiamento && !q.interesse_proposta &&
    !q.interesse_test_drive && !q.interesse_visita;
}

export function LeadQualificationCard({
  leadId,
  qualificacao,
}: {
  leadId: string;
  qualificacao?: LeadQualificacao | null;
}) {
  const [editing, setEditing] = useState(false);
  const updateMeta = useUpdateLeadMetadata();
  const q = qualificacao ?? null;

  const [form, setForm] = useState(() => toForm(q));

  function openEdit() {
    setForm(toForm(q));
    setEditing(true);
  }

  async function handleSave() {
    const patch = {
      qualificacao: {
        ...(q ?? {}),
        categoria: form.categoria || null,
        temperatura: form.temperatura || null,
        probabilidade: form.probabilidade === "" ? null : Number(form.probabilidade),
        prazo_compra: form.prazo_compra || null,
        interesse_financiamento: form.interesse_financiamento,
        interesse_proposta: form.interesse_proposta,
        interesse_test_drive: form.interesse_test_drive,
        interesse_visita: form.interesse_visita,
        tem_troca: form.tem_troca,
        observacoes: form.observacoes || null,
        // marca edição manual sem apagar a data da qualificação original da IA
        editado_em: new Date().toISOString(),
      },
    };
    try {
      await updateMeta.mutateAsync({ leadId, patch });
      toast.success("Qualificação salva");
      setEditing(false);
    } catch {
      toast.error("Erro ao salvar qualificação");
    }
  }

  const temp = q?.temperatura ? TEMP_META[q.temperatura] : null;

  // ---- View (vazio) ----
  if (!editing && isEmptyQual(q)) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><Flame className="h-4 w-4 text-primary" /> Qualificação</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Lead ainda não qualificado.</p>
        </CardContent>
      </Card>
    );
  }

  // ---- Edição ----
  if (editing) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><Flame className="h-4 w-4 text-primary" /> Qualificação</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setEditing(false)}><X className="h-3 w-3" /></Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleSave} disabled={updateMeta.isPending}><Save className="h-3 w-3" /></Button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Categoria</Label>
              <Select value={form.categoria} onValueChange={(v) => setForm((f) => ({ ...f, categoria: v }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CATEGORIA_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Temperatura</Label>
              <Select value={form.temperatura} onValueChange={(v) => setForm((f) => ({ ...f, temperatura: v }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TEMP_META).map(([v, m]) => <SelectItem key={v} value={v}>{m.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Probabilidade (%)</Label>
              <Input className="h-7 text-xs" type="number" min={0} max={100} placeholder="0-100"
                value={form.probabilidade}
                onChange={(e) => setForm((f) => ({ ...f, probabilidade: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Prazo de compra</Label>
              <Select value={form.prazo_compra} onValueChange={(v) => setForm((f) => ({ ...f, prazo_compra: v }))}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PRAZO_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Sinais de interesse</Label>
            <div className="flex flex-wrap gap-1.5">
              {INTERESSES.map(({ key, label }) => {
                const active = !!form[key as keyof typeof form];
                return (
                  <button
                    key={key as string}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, [key]: !f[key as keyof typeof form] }))}
                    className={cn(
                      "text-[11px] px-2 py-1 rounded-full border transition-colors",
                      active ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground border-transparent",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Observações</Label>
            <Textarea className="text-xs min-h-[60px]" placeholder="Resumo / contexto da qualificação"
              value={form.observacoes}
              onChange={(e) => setForm((f) => ({ ...f, observacoes: e.target.value }))} />
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- View (preenchido) ----
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><Flame className="h-4 w-4 text-primary" /> Qualificação</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={openEdit}><Pencil className="h-3 w-3" /></Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          {temp && <Badge variant="outline" className={cn("text-[11px] font-semibold", temp.cls)}>{temp.label}</Badge>}
          {q?.categoria && <span className="font-medium">{CATEGORIA_LABEL[q.categoria] ?? q.categoria}</span>}
        </div>

        {q?.probabilidade != null && (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Gauge className="h-3 w-3 shrink-0" />
              <span>Probabilidade de compra:</span>
              <span className="font-medium text-foreground">{q.probabilidade}%</span>
            </div>
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div className={cn("h-full rounded-full transition-all", temp?.bar ?? "bg-primary")} style={{ width: `${Math.min(Math.max(q.probabilidade, 0), 100)}%` }} />
            </div>
          </div>
        )}

        {q?.prazo_compra && (
          <div className="flex items-center gap-2">
            <CalendarClock className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Prazo:</span>
            <span className="font-medium">{PRAZO_LABEL[q.prazo_compra] ?? q.prazo_compra}</span>
          </div>
        )}

        {INTERESSES.some(({ key }) => !!q?.[key]) && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {INTERESSES.filter(({ key }) => !!q?.[key]).map(({ key, label }) => (
              <Badge key={key as string} variant="secondary" className="text-[10px] h-5">{label}</Badge>
            ))}
          </div>
        )}

        {q?.observacoes && (
          <p className="text-muted-foreground leading-snug border-l-2 border-muted pl-2">{q.observacoes}</p>
        )}

        {(q?.qualificado_em || q?.origem) && (
          <p className="text-[10px] text-muted-foreground flex items-center gap-1 pt-0.5">
            <Sparkles className="h-3 w-3" />
            {q?.origem === "agente-stand" ? "Qualificado pela IA" : "Qualificado"}
            {q?.qualificado_em ? ` em ${new Date(q.qualificado_em).toLocaleDateString("pt-BR")}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function toForm(q: LeadQualificacao | null) {
  return {
    categoria: q?.categoria ?? "",
    temperatura: q?.temperatura ?? "",
    probabilidade: q?.probabilidade != null ? String(q.probabilidade) : "",
    prazo_compra: q?.prazo_compra ?? "",
    interesse_financiamento: !!q?.interesse_financiamento,
    interesse_proposta: !!q?.interesse_proposta,
    interesse_test_drive: !!q?.interesse_test_drive,
    interesse_visita: !!q?.interesse_visita,
    tem_troca: !!q?.tem_troca,
    observacoes: q?.observacoes ?? "",
  };
}
