import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronLeft, Loader2, AlertTriangle, Flame } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PhoneInput } from "@/components/ui/phone-input";
import { cn } from "@/lib/utils";
import { useCheckLeadDuplicate } from "@/hooks/useMergeLeads";
import { useCreateCaptureLead } from "@/hooks/useCaptureLeads";
import { useVehicleLookup } from "@/hooks/useVehicleLookup";
import {
  computeCaptureScore,
  temperatureFromScore,
  INTENT_LABEL,
  PRAZO_LABEL,
  TEMP_META,
  type CaptureAceitaAvaliacao,
  type CaptureIntent,
  type CapturePrazo,
  type CreateCaptureLeadResult,
} from "@/types/capture";
import { SCRIPT_CARDS } from "./captureContent";

/**
 * QUICK CAPTURE — cadastro em 20–30 segundos, de pé, no corredor do shopping.
 *
 * Passo 1 (obrigatório): nome, WhatsApp, carro, ano, intenção, prazo, autoriza contato
 *   (consentimento LGPD — sem ele o lead NÃO conta na meta semanal).
 * Passo 2 (opcional, 10s): KM, proprietário, aceita avaliação, observação.
 *
 * Reaproveita PhoneInput + useCheckLeadDuplicate; NÃO expõe o CreateLeadOrDealModal.
 * Grava via RPC create_capture_lead (carimba tenant, captured_by, intent, score).
 */

const DRAFT_KEY = "captacao:draft";
const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: 16 }, (_, i) => CURRENT_YEAR + 1 - i);

interface Draft {
  name: string;
  phone: string;
  vehicle: string;
  year: string;
  intent?: CaptureIntent;
  prazo?: CapturePrazo;
  km: string;
  is_owner?: boolean;
  aceita_avaliacao?: CaptureAceitaAvaliacao;
  autoriza_contato?: boolean;
  observacao: string;
  plate: string;
  brand: string;
  model: string;
  color: string;
  fuel: string;
}

const EMPTY: Draft = { name: "", phone: "", vehicle: "", year: "", km: "", observacao: "", plate: "", brand: "", model: "", color: "", fuel: "" };

/** Placa em MAIÚSCULAS, sem separador, no máximo 7 caracteres (AAA9999 ou AAA9A99). */
function maskPlateBR(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7);
}
const PLATE_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

function loadDraft(): Draft {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Draft) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

function Segment<T extends string>({
  value, options, onChange, cols,
}: { value?: T; options: { value: T; label: string }[]; onChange: (v: T) => void; cols?: number }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols ?? options.length}, minmax(0,1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-12 rounded-lg border text-sm font-medium transition-colors active:scale-[0.98]",
            value === o.value
              ? "bg-primary text-primary-foreground border-primary shadow-sm"
              : "bg-background hover:bg-muted border-input",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function CaptureNewLead() {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [d, setD] = useState<Draft>(loadDraft);
  const [done, setDone] = useState<CreateCaptureLeadResult | null>(null);
  const [dupe, setDupe] = useState<{ id: string; name: string } | null>(null);
  const checkDup = useCheckLeadDuplicate();
  const create = useCreateCaptureLead();
  const plateLookup = useVehicleLookup();
  const [plateInfo, setPlateInfo] = useState<string | null>(null);
  const [plateDupe, setPlateDupe] = useState<string | null>(null);

  const buscarPlaca = async () => {
    const placa = maskPlateBR(d.plate);
    if (!PLATE_RE.test(placa)) { toast.error("Placa incompleta. Use o padrão ABC1D23."); return; }
    setPlateInfo(null);
    setPlateDupe(null);
    try {
      const res = await plateLookup.mutateAsync({ placa });
      if (res.already_captured) {
        setPlateDupe(
          `Essa placa já foi captada${res.already_captured.promoter_name ? ` por ${res.already_captured.promoter_name}` : ""}` +
          `${res.already_captured.lead_name ? ` (cliente ${res.already_captured.lead_name})` : ""}.`,
        );
      }
      if (!res.found) { toast.warning("Não achei os dados dessa placa. Pode preencher na mão."); return; }
      const v = res.vehicle;
      const desc = [v.marca, v.modelo].filter(Boolean).join(" ").trim();
      setD((cur) => ({
        ...cur,
        plate: res.plate,
        brand: v.marca ?? cur.brand,
        model: v.modelo ?? cur.model,
        vehicle: desc || cur.vehicle,
        year: v.ano_modelo ? String(v.ano_modelo) : (v.ano_fabricacao ? String(v.ano_fabricacao) : cur.year),
        color: v.cor ?? cur.color,
        fuel: v.combustivel ?? cur.fuel,
      }));
      setPlateInfo(res.cached ? "Dados da placa preenchidos (consulta recente)." : "Dados da placa preenchidos.");
    } catch (e) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 412) {
        toast.error("Consulta de placa ainda não configurada. Preencha o carro na mão.");
      } else {
        toast.error(e instanceof Error ? e.message : "Não consegui consultar a placa.");
      }
    }
  };

  // Auto-save do rascunho — se a tela recarregar no meio, não perde o cliente.
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* ignore */ }
  }, [d]);

  // Dedupe ao completar o telefone (mesmo hook do CRM)
  useEffect(() => {
    const digits = d.phone.replace(/\D/g, "");
    if (digits.length < 10) { setDupe(null); return; }
    const t = setTimeout(() => {
      checkDup.mutateAsync({ phone: digits })
        .then((rows) => setDupe(rows[0] ? { id: rows[0].id, name: rows[0].name } : null))
        .catch(() => setDupe(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.phone]);

  const step1Ok =
    d.name.trim().length >= 2 &&
    d.phone.replace(/\D/g, "").length >= 10 &&
    d.vehicle.trim().length >= 2 &&
    /^\d{4}$/.test(d.year) &&
    !!d.intent &&
    !!d.prazo &&
    typeof d.autoriza_contato === "boolean";

  const previewScore = useMemo(
    () => computeCaptureScore(
      { prazo_venda: d.prazo, is_owner: d.is_owner, aceita_avaliacao: d.aceita_avaliacao, autoriza_contato: d.autoriza_contato, observacao: d.observacao },
      { description: d.vehicle, year_model: d.year, km: d.km },
    ),
    [d],
  );
  const previewTemp = TEMP_META[temperatureFromScore(previewScore)];

  const submit = async () => {
    if (!step1Ok || !d.intent || !d.prazo) return;
    try {
      const res = await create.mutateAsync({
        name: d.name.trim(),
        phone: d.phone,
        intent: d.intent,
        vehicle: {
          description: d.vehicle.trim(),
          year_model: Number(d.year),
          km: d.km ? Number(d.km) : null,
          brand: d.brand.trim() || undefined,
          model: d.model.trim() || undefined,
          plate: PLATE_RE.test(maskPlateBR(d.plate)) ? maskPlateBR(d.plate) : undefined,
          color: d.color.trim() || undefined,
          fuel: d.fuel.trim() || undefined,
        },
        qualification: {
          prazo_venda: d.prazo,
          is_owner: d.is_owner,
          aceita_avaliacao: d.aceita_avaliacao,
          autoriza_contato: d.autoriza_contato,
          observacao: d.observacao.trim() || undefined,
        },
        channel: "presencial",
      });
      setDone(res);
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar. Tenta de novo.");
    }
  };

  const reset = () => {
    setD(EMPTY);
    setDone(null);
    setDupe(null);
    setStep(1);
  };

  // ── Tela de sucesso ──
  if (done) {
    const t = TEMP_META[done.temperatura];
    const closing = SCRIPT_CARDS.find((s) => s.tag === "Fechamento")!;
    return (
      <div className="space-y-5 pt-6 text-center">
        <div className="mx-auto h-16 w-16 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
          <Check className="h-9 w-9" />
        </div>
        <div>
          <h1 className="text-xl font-bold">{done.duplicate ? "Cliente já existia — atualizado!" : "Cliente captado!"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {done.duplicate
              ? "Esse WhatsApp já estava no CRM. Anexei o carro e a qualificação de hoje."
              : "Já está no funil de captação com o seu nome."}
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Badge variant="outline" className={cn("border text-sm px-3 py-1", t.cls)}>
            {done.temperatura === "quente" && <Flame className="h-3.5 w-3.5 mr-1" />}
            {t.label}
          </Badge>
          <span className="text-sm text-muted-foreground">Score {done.score}/100</span>
        </div>
        {d.autoriza_contato === true ? (
          <p className="text-sm font-medium text-emerald-700 flex items-center justify-center gap-1">
            <Check className="h-4 w-4" /> Conta na meta semanal
          </p>
        ) : (
          <p className="text-sm font-medium text-amber-700 flex items-center justify-center gap-1">
            <AlertTriangle className="h-4 w-4" /> Não conta na meta — sem autorização de contato
          </p>
        )}
        {done.handoff?.assigned ? (
          <p className="text-sm">
            🤝 Passado pra <strong>{done.handoff.specialist_name?.split(" ")[0] ?? "especialista"}</strong>
            {done.temperatura !== "frio" && done.handoff.sla_minutes
              ? <> — contato em até <strong>{done.handoff.sla_minutes} min</strong>.</>
              : <> — entrou em nutrição.</>}
          </p>
        ) : done.handoff?.reason === "no_specialist" ? (
          <p className="text-xs text-amber-700">Nenhum especialista configurado — avise o gestor (Configurações › Captação).</p>
        ) : null}
        <Card className="text-left bg-muted/40">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Diga agora</p>
            <p className="text-sm leading-relaxed">
              “{done.handoff?.assigned && done.handoff.specialist_name
                ? closing.text.replace("nosso especialista", `${done.handoff.specialist_name.split(" ")[0]}, nosso especialista,`)
                : closing.text}”
            </p>
          </CardContent>
        </Card>
        <div className="grid gap-2">
          <Button size="lg" className="h-12 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={reset}>
            + Captar outro cliente
          </Button>
          <Button size="lg" variant="outline" className="h-12" onClick={() => navigate(`/captacao/leads?lead=${done.lead_id}`)}>
            Ver o lead
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        {step === 2 ? (
          <button type="button" onClick={() => setStep(1)} className="text-muted-foreground -ml-1 p-1"><ChevronLeft className="h-5 w-5" /></button>
        ) : null}
        <div className="flex-1">
          <h1 className="text-lg font-bold leading-tight">{step === 1 ? "Capte uma oportunidade" : "Mais 10 segundos?"}</h1>
          <p className="text-xs text-muted-foreground">
            {step === 1 ? "7 campos. Dá pra fazer de pé." : "Esses dados deixam o lead quente pro especialista. Pode pular."}
          </p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{step}/2</span>
      </div>

      {step === 1 ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Nome</Label>
            <Input id="name" autoFocus className="h-12 text-base" placeholder="Como a pessoa se chama?" value={d.name}
              onChange={(e) => setD({ ...d, name: e.target.value })} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="phone">WhatsApp</Label>
            <PhoneInput id="phone" className="h-12 text-base" value={d.phone} onChange={(phone) => setD({ ...d, phone })} />
            {dupe && (
              <p className="text-xs text-amber-700 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Já existe no CRM como <strong>{dupe.name}</strong> — vou só atualizar, sem duplicar.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plate">Placa do carro <span className="text-muted-foreground font-normal">(opcional — preenche o resto sozinho)</span></Label>
            <div className="flex gap-2">
              <Input id="plate" className="h-12 text-base uppercase font-mono tracking-wider" placeholder="ABC1D23" maxLength={7}
                value={d.plate} inputMode="text"
                onChange={(e) => { setD({ ...d, plate: maskPlateBR(e.target.value) }); setPlateInfo(null); setPlateDupe(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); buscarPlaca(); } }} autoComplete="off" />
              <Button type="button" variant="secondary" className="h-12 shrink-0"
                disabled={plateLookup.isPending || !PLATE_RE.test(maskPlateBR(d.plate))} onClick={buscarPlaca}>
                {plateLookup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Buscar"}
              </Button>
            </div>
            {plateInfo && <p className="text-[11px] text-emerald-700 flex items-center gap-1"><Check className="h-3.5 w-3.5" /> {plateInfo}</p>}
            {plateDupe && <p className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {plateDupe}</p>}
          </div>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="vehicle">Qual o carro?</Label>
              <Input id="vehicle" className="h-12 text-base" placeholder="Ex.: Civic EXL" value={d.vehicle}
                onChange={(e) => setD({ ...d, vehicle: e.target.value })} autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="year">Ano</Label>
              <select
                id="year"
                className="h-12 w-full rounded-md border border-input bg-background px-3 text-base"
                value={d.year}
                onChange={(e) => setD({ ...d, year: e.target.value })}
              >
                <option value="">—</option>
                {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>O que a pessoa quer?</Label>
            <Segment
              value={d.intent}
              options={(Object.keys(INTENT_LABEL) as CaptureIntent[]).map((k) => ({ value: k, label: INTENT_LABEL[k] }))}
              onChange={(intent) => setD({ ...d, intent })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Quando pensa em vender?</Label>
            <Segment
              value={d.prazo}
              cols={2}
              options={(Object.keys(PRAZO_LABEL) as CapturePrazo[]).map((k) => ({ value: k, label: PRAZO_LABEL[k] }))}
              onChange={(prazo) => setD({ ...d, prazo })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Autoriza nosso especialista a chamar no WhatsApp?</Label>
            <Segment
              value={d.autoriza_contato === true ? "sim" : d.autoriza_contato === false ? "nao" : undefined}
              options={[{ value: "sim", label: "Sim, autoriza" }, { value: "nao", label: "Não" }]}
              onChange={(v) => setD({ ...d, autoriza_contato: v === "sim" })}
            />
            <p className={cn("text-[11px]", d.autoriza_contato === false ? "text-amber-700" : "text-muted-foreground")}>
              {d.autoriza_contato === false
                ? "Sem autorização o lead é salvo, mas não conta na meta semanal."
                : "Consentimento pra contato (LGPD). Sem ele o lead não conta na meta."}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="km">KM aproximado</Label>
            <Input id="km" inputMode="numeric" className="h-12 text-base" placeholder="Ex.: 60000" value={d.km}
              onChange={(e) => setD({ ...d, km: e.target.value.replace(/\D/g, "") })} />
          </div>
          <div className="space-y-1.5">
            <Label>É o proprietário do carro?</Label>
            <Segment
              value={d.is_owner === true ? "sim" : d.is_owner === false ? "nao" : undefined}
              options={[{ value: "sim", label: "Sim" }, { value: "nao", label: "Não" }]}
              onChange={(v) => setD({ ...d, is_owner: v === "sim" })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Aceita uma avaliação gratuita?</Label>
            <Segment
              value={d.aceita_avaliacao}
              options={[{ value: "sim", label: "Sim" }, { value: "talvez", label: "Talvez" }, { value: "nao", label: "Não" }]}
              onChange={(aceita_avaliacao) => setD({ ...d, aceita_avaliacao })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="obs">Observação (uma frase)</Label>
            <Textarea id="obs" rows={2} placeholder="Ex.: quer trocar por SUV até dezembro" value={d.observacao}
              onChange={(e) => setD({ ...d, observacao: e.target.value })} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
            <span className="text-xs text-muted-foreground">Temperatura prevista</span>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={cn("border", previewTemp.cls)}>{previewTemp.label}</Badge>
              <span className="text-xs tabular-nums text-muted-foreground">{previewScore}/100</span>
            </div>
          </div>
        </div>
      )}

      {/* Rodapé de ação — fixo acima do bottom-nav */}
      <div className="fixed bottom-16 inset-x-0 z-20 pointer-events-none">
        <div className="mx-auto max-w-[520px] px-4 pb-3 pt-6 bg-gradient-to-t from-background via-background/95 to-transparent pointer-events-auto">
          {step === 1 ? (
            <Button size="lg" className="w-full h-12 text-base bg-emerald-600 hover:bg-emerald-700 text-white" disabled={!step1Ok || create.isPending} onClick={() => setStep(2)}>
              Continuar
            </Button>
          ) : (
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <Button size="lg" variant="outline" className="h-12" disabled={create.isPending} onClick={submit}>
                Pular
              </Button>
              <Button size="lg" className="h-12 text-base bg-emerald-600 hover:bg-emerald-700 text-white" disabled={create.isPending} onClick={submit}>
                {create.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Check className="h-4 w-4 mr-2" />}
                Concluir captação
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
