import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileSignature, Loader2, Save, Lock, Upload, ExternalLink, Pause, Play, FileWarning, XCircle,
  ChevronDown, ChevronRight, History, Building2, UserRound, CalendarClock, Coins, Info, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import {
  getContractSignedUrl,
  useImportSignedContract,
  useIntermediationByLead,
  useIntermediationEvents,
  useLegalEntities,
  useSetIntermediationCommission,
  useSetIntermediationStatus,
  useSetIntermediationTerms,
} from "@/hooks/useIntermediation";
import {
  COMMISSION_STATUS_META,
  CONTRACT_STATUS_META,
  CUSTODY_MODE_LABEL,
  INTERMEDIATION_EVENT_LABEL,
  INTERMEDIATION_STATUS_META,
  TEST_DRIVE_POLICY_LABEL,
  missingTerms,
  type CommissionStatus,
  type CommissionType,
  type CustodyMode,
  type Intermediation,
  type IntermediationEvent,
  type IntermediationStatusAction,
  type IntermediationTermsInput,
  type TestDrivePolicy,
} from "@/types/intermediation";

/**
 * Card "Intermediação" no detalhe do lead (aba Comercial) — fica ACIMA do
 * card Captação e SÓ aparece quando existe `intermediations.owner_lead_id = lead`.
 *
 * Aqui o time comercial registra as condições comerciais (preço, comissão,
 * prazo…), o admin importa o contrato assinado (formaliza + prêmio R$ 25 da
 * promotora) e qualquer um do comercial pausa/encerra com motivo. A venda em
 * si continua sendo registrada no card Captação (Vendido + evidência).
 * Promotora só lê.
 */

interface Props {
  leadId: string;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL = (v?: number | null) => (v == null ? "—" : BRL.format(Number(v)));
const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  // date-only ('YYYY-MM-DD') → meio-dia local pra não voltar um dia por fuso
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
};
const fmtDateTime = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const todayISO = () => new Date().toISOString().slice(0, 10);

function parseMoney(raw: string): number | null {
  const clean = raw.replace(/[^\d,.]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
  if (!clean) return null;
  const n = parseFloat(clean);
  return Number.isFinite(n) ? n : null;
}
const moneyToInput = (v: number | null) => (v == null ? "" : String(v).replace(".", ","));

/** Dias entre hoje e ends_at (negativo = já venceu). */
function daysUntil(dateISO: string | null): number | null {
  if (!dateISO) return null;
  const end = new Date(`${dateISO}T12:00:00`);
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return Math.round((end.getTime() - now.getTime()) / 86_400_000);
}

const CLOSE_ACTIONS: { value: IntermediationStatusAction; label: string }[] = [
  { value: "cancelled_by_owner", label: "Cancelada pelo proprietário" },
  { value: "refused_by_totex", label: "Recusada pela Totex" },
  { value: "lost", label: "Perdida" },
  { value: "sold_outside", label: "Vendida por fora" },
];

const ACTION_LABEL: Record<IntermediationStatusAction, string> = {
  paused: "Pausar intermediação",
  docs_pending: "Marcar documentação pendente",
  cancelled_by_owner: "Encerrar — cancelada pelo proprietário",
  refused_by_totex: "Encerrar — recusada pela Totex",
  lost: "Encerrar — perdida",
  sold_outside: "Encerrar — vendida por fora",
  reactivate: "Reativar",
};

const CLOSING_ACTIONS: IntermediationStatusAction[] = ["cancelled_by_owner", "refused_by_totex", "lost", "sold_outside"];

// ─── Formulário de condições comerciais ─────────────────────────────────────

interface TermsForm {
  asking_price: string;
  minimum_authorized_price: string;
  commission_type: CommissionType | "";
  commission_value: string;
  exclusive: boolean;
  starts_at: string;
  ends_at: string;
  custody_mode: CustodyMode;
  physical_display_authorized: boolean;
  test_drive_policy: TestDrivePolicy;
  terms_notes: string;
}

function toTermsForm(i: Intermediation): TermsForm {
  return {
    asking_price: moneyToInput(i.asking_price),
    minimum_authorized_price: moneyToInput(i.minimum_authorized_price),
    commission_type: i.commission_type ?? "",
    commission_value: moneyToInput(i.commission_value),
    exclusive: !!i.exclusive,
    starts_at: i.starts_at ?? "",
    ends_at: i.ends_at ?? "",
    custody_mode: i.custody_mode ?? "owner",
    physical_display_authorized: i.physical_display_authorized ?? true,
    test_drive_policy: i.test_drive_policy ?? "accompanied",
    terms_notes: i.terms_notes ?? "",
  };
}

function TermsBlock({ i, canEdit }: { i: Intermediation; canEdit: boolean }) {
  const [f, setF] = useState<TermsForm>(() => toTermsForm(i));
  const setTerms = useSetIntermediationTerms();

  // Re-sincroniza quando o servidor mudar (ex.: importou contrato → starts_at preenchido)
  useEffect(() => { setF(toTermsForm(i)); }, [i]);

  const locked = i.status === "active" || i.status === "completed";
  const closed = INTERMEDIATION_STATUS_META[i.status].closed;
  const readOnly = !canEdit || closed;
  const missing = missingTerms(i);

  const save = async () => {
    const terms: IntermediationTermsInput = {
      minimum_authorized_price: parseMoney(f.minimum_authorized_price),
      exclusive: f.exclusive,
      starts_at: f.starts_at || null,
      custody_mode: f.custody_mode,
      physical_display_authorized: f.physical_display_authorized,
      test_drive_policy: f.test_drive_policy,
      terms_notes: f.terms_notes.trim() || null,
    };
    if (!locked) {
      // Depois de ativa o servidor recusa mudar preço/comissão/prazo — nem manda
      terms.asking_price = parseMoney(f.asking_price);
      terms.commission_type = f.commission_type || null;
      terms.commission_value = parseMoney(f.commission_value);
      terms.ends_at = f.ends_at || null;
      if (f.commission_type === "percent" && terms.commission_value != null && (terms.commission_value <= 0 || terms.commission_value > 30)) {
        toast.error("Comissão em % precisa ficar entre 0 e 30.");
        return;
      }
      if (terms.minimum_authorized_price != null && terms.asking_price != null && terms.minimum_authorized_price > terms.asking_price) {
        toast.error("Preço mínimo não pode ser maior que o preço pretendido.");
        return;
      }
      if (terms.starts_at && terms.ends_at && terms.ends_at < terms.starts_at) {
        toast.error("O prazo final não pode ser antes do início.");
        return;
      }
    }
    try {
      const r = await setTerms.mutateAsync({ id: i.id, leadId: i.owner_lead_id, terms });
      toast.success(
        r.complete
          ? i.status === "lead"
            ? `Condições completas — ${i.code} foi pra Contratar. Agora é assinar o contrato.`
            : "Condições comerciais salvas."
          : "Condições salvas. Ainda falta preencher pra fechar o contrato.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar as condições.");
    }
  };

  const disabledTerm = readOnly || locked;

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><Coins className="h-4 w-4 text-sky-600" /> Condições comerciais</p>
        {missing.length > 0 ? (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 text-[11px]">
            <AlertTriangle className="h-3 w-3 mr-1" /> Falta: {missing.join(" · ")}
          </Badge>
        ) : (
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 text-[11px]">
            Completas{i.terms_set_at ? ` · ${fmtDate(i.terms_set_at)}` : ""}
          </Badge>
        )}
      </div>

      {locked && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
          <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          Contrato assinado: preço pretendido, comissão e prazo ficam travados (mudam só por aditivo, na fase 2). Os outros campos ainda podem ser ajustados.
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Preço pretendido (R$) *</Label>
          <Input inputMode="decimal" placeholder="Ex.: 85000" value={f.asking_price} disabled={disabledTerm} onChange={(e) => setF({ ...f, asking_price: e.target.value })} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Preço mínimo autorizado (R$)</Label>
          <Input inputMode="decimal" placeholder="Ex.: 80000" value={f.minimum_authorized_price} disabled={readOnly} onChange={(e) => setF({ ...f, minimum_authorized_price: e.target.value })} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Comissão *</Label>
          <div className="flex gap-2">
            <Select value={f.commission_type || "__none__"} disabled={disabledTerm} onValueChange={(v) => setF({ ...f, commission_type: v === "__none__" ? "" : (v as CommissionType) })}>
              <SelectTrigger className="h-9 w-[150px] shrink-0"><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Tipo…</SelectItem>
                <SelectItem value="fixed">Fixa (R$)</SelectItem>
                <SelectItem value="percent">Percentual (%)</SelectItem>
              </SelectContent>
            </Select>
            <Input
              inputMode="decimal"
              placeholder={f.commission_type === "percent" ? "Ex.: 5" : "Ex.: 3000"}
              value={f.commission_value}
              disabled={disabledTerm || !f.commission_type}
              onChange={(e) => setF({ ...f, commission_value: e.target.value })}
              className="h-9"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Prazo (início → fim *)</Label>
          <div className="flex gap-2">
            <Input type="date" value={f.starts_at} disabled={readOnly} onChange={(e) => setF({ ...f, starts_at: e.target.value })} className="h-9" />
            <Input type="date" value={f.ends_at} disabled={disabledTerm} onChange={(e) => setF({ ...f, ends_at: e.target.value })} className="h-9" />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Custódia do carro</Label>
          <Select value={f.custody_mode} disabled={readOnly} onValueChange={(v) => setF({ ...f, custody_mode: v as CustodyMode })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(CUSTODY_MODE_LABEL) as CustodyMode[]).map((k) => <SelectItem key={k} value={k}>{CUSTODY_MODE_LABEL[k]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Test drive</Label>
          <Select value={f.test_drive_policy} disabled={readOnly} onValueChange={(v) => setF({ ...f, test_drive_policy: v as TestDrivePolicy })}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(TEST_DRIVE_POLICY_LABEL) as TestDrivePolicy[]).map((k) => <SelectItem key={k} value={k}>{TEST_DRIVE_POLICY_LABEL[k]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center justify-between rounded-md border border-input px-3 h-9 text-xs">
          Exclusividade
          <Switch checked={f.exclusive} disabled={readOnly} onCheckedChange={(v) => setF({ ...f, exclusive: v })} />
        </label>
        <label className="flex items-center justify-between rounded-md border border-input px-3 h-9 text-xs">
          Exposição física autorizada
          <Switch checked={f.physical_display_authorized} disabled={readOnly} onCheckedChange={(v) => setF({ ...f, physical_display_authorized: v })} />
        </label>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Observações</Label>
          <Textarea rows={2} value={f.terms_notes} disabled={readOnly} onChange={(e) => setF({ ...f, terms_notes: e.target.value })} placeholder="Ex.: carro com 2 chaves, revisões em dia, proprietário aceita financiamento" />
        </div>
      </div>

      {!readOnly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={setTerms.isPending}>
            {setTerms.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Salvar condições
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Contrato ───────────────────────────────────────────────────────────────

function ContractBlock({ i, memberName }: { i: Intermediation; memberName: (id: string | null) => string | null }) {
  const { isAdmin, isPromotora } = useAuth();
  const importContract = useImportSignedContract();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [signedAt, setSignedAt] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [opening, setOpening] = useState(false);

  const meta = CONTRACT_STATUS_META[i.contract_status] ?? CONTRACT_STATUS_META.none;
  const missing = missingTerms(i);
  const hasContract = i.contract_status === "signed" || i.contract_status === "imported";
  const canImportStatus = ["lead", "contracting", "docs_pending", "paused"].includes(i.status);
  const showImport = !hasContract && canImportStatus && !isPromotora;

  const reset = () => { setFile(null); setSignedAt(todayISO()); setReason(""); };

  const confirm = async () => {
    if (!file) { toast.error("Escolha o PDF do contrato assinado."); return; }
    if (reason.trim().length < 3) { toast.error("Descreva o motivo/origem (ex.: assinado em papel na loja)."); return; }
    try {
      const r = await importContract.mutateAsync({ id: i.id, leadId: i.owner_lead_id, file, signedAt, reason });
      if (r.already) toast.info(`${r.code} já estava formalizada.`);
      else toast.success(`${r.code} formalizada — prêmio de R$ 25 gerado (pendente de aprovação).`);
      setOpen(false);
      reset();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui importar o contrato.");
    }
  };

  const openPdf = async () => {
    if (!i.contract_file_path) return;
    setOpening(true);
    try {
      const url = await getContractSignedUrl(i.contract_file_path);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui abrir o PDF.");
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><FileSignature className="h-4 w-4 text-emerald-600" /> Contrato</p>
        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{meta.label}</Badge>
      </div>

      {hasContract ? (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>Assinado em <strong className="text-foreground">{fmtDate(i.contract_signed_at)}</strong>{i.contract_imported_by && memberName(i.contract_imported_by) ? <> · importado por <strong className="text-foreground">{memberName(i.contract_imported_by)}</strong></> : null}</p>
          {i.contract_sha256 && <p>Hash SHA-256: <code className="text-[11px]">{i.contract_sha256.slice(0, 12)}…</code></p>}
          {i.contract_import_reason && <p>Origem: {i.contract_import_reason}</p>}
          {i.contract_file_path && (
            <button type="button" onClick={openPdf} disabled={opening} className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-60">
              {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF
            </button>
          )}
        </div>
      ) : showImport ? (
        isAdmin ? (
          <div className="space-y-1.5">
            <Button size="sm" variant="outline" disabled={missing.length > 0} onClick={() => setOpen(true)}>
              <Upload className="h-4 w-4 mr-1" /> Importar contrato assinado (PDF)
            </Button>
            {missing.length > 0 && (
              <p className="text-[11px] text-muted-foreground">Antes de importar, preencha nas condições comerciais: {missing.join(", ")}.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Peça ao admin pra importar o contrato assinado{missing.length > 0 ? ` (antes, complete: ${missing.join(", ")})` : ""}.</p>
        )
      ) : (
        <p className="text-xs text-muted-foreground">Sem contrato assinado.</p>
      )}

      <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Info className="h-3 w-3" /> Assinatura eletrônica (Clicksign) chega na fase 3.</p>

      <Dialog open={open} onOpenChange={(o) => { if (!importContract.isPending) { setOpen(o); if (!o) reset(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Importar contrato assinado — {i.code}</DialogTitle>
            <DialogDescription>
              Isso <strong>formaliza a intermediação</strong> (status Formalizada), move o funil pra Preparação e gera o prêmio da promotora (pendente de aprovação). O PDF fica guardado com hash pra auditoria.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">PDF do contrato assinado *</Label>
              <Input type="file" accept="application/pdf,.pdf" className="h-9 file:text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {file && <p className="text-[11px] text-muted-foreground">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Data da assinatura *</Label>
              <Input type="date" value={signedAt} max={todayISO()} onChange={(e) => setSignedAt(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Motivo / origem *</Label>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Assinado em papel na loja e escaneado" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpen(false); reset(); }} disabled={importContract.isPending}>Cancelar</Button>
            <Button onClick={confirm} disabled={importContract.isPending || !file}>
              {importContract.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileSignature className="h-4 w-4 mr-1" />}
              Formalizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Estado (pausar / encerrar / reativar) ──────────────────────────────────

function StateBlock({ i, vehicleListed }: { i: Intermediation; vehicleListed: boolean }) {
  const { isAdmin, isPromotora } = useAuth();
  const setStatus = useSetIntermediationStatus();
  const [pending, setPending] = useState<IntermediationStatusAction | null>(null);
  const [reason, setReason] = useState("");

  const meta = INTERMEDIATION_STATUS_META[i.status];
  if (isPromotora || meta.closed) {
    return i.status_reason ? (
      <p className="text-xs text-muted-foreground">Motivo: {i.status_reason}{i.closed_at ? ` · ${fmtDate(i.closed_at)}` : ""}</p>
    ) : null;
  }

  const isPausedLike = i.status === "paused" || i.status === "docs_pending";
  const closingNeedsAdmin = i.status === "active" && !isAdmin;

  const run = async (action: IntermediationStatusAction, r?: string) => {
    try {
      const res = await setStatus.mutateAsync({ id: i.id, leadId: i.owner_lead_id, status: action, reason: r ?? null });
      const label = INTERMEDIATION_STATUS_META[res.status]?.label ?? res.status;
      toast.success(
        action === "reactivate"
          ? `${i.code} reativada (${label}).`
          : `${i.code}: ${label}.${res.unpublish_task ? " Criei uma tarefa pra retirar o anúncio do site." : ""}`,
      );
      setPending(null);
      setReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui alterar o status.");
    }
  };

  const confirm = () => {
    if (!pending) return;
    if (reason.trim().length < 3) { toast.error("Descreva o motivo."); return; }
    void run(pending, reason.trim());
  };

  const pendingIsClosing = pending ? CLOSING_ACTIONS.includes(pending) : false;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {isPausedLike ? (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={setStatus.isPending} onClick={() => run("reactivate")}>
            <Play className="h-3.5 w-3.5 mr-1" /> Reativar
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={setStatus.isPending} onClick={() => setPending("paused")}>
            <Pause className="h-3.5 w-3.5 mr-1" /> Pausar
          </Button>
        )}
        {i.status !== "docs_pending" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" disabled={setStatus.isPending} onClick={() => setPending("docs_pending")}>
            <FileWarning className="h-3.5 w-3.5 mr-1" /> Documentação pendente
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={setStatus.isPending || closingNeedsAdmin}>
              <XCircle className="h-3.5 w-3.5 mr-1" /> Encerrar <ChevronDown className="h-3 w-3 ml-1" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {/* setTimeout: deixa o menu fechar antes de abrir o Dialog (evita body travado com pointer-events none) */}
            {CLOSE_ACTIONS.map((a) => (
              <DropdownMenuItem key={a.value} onSelect={() => setTimeout(() => setPending(a.value), 0)}>{a.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {closingNeedsAdmin && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Lock className="h-3 w-3" /> Encerrar uma intermediação com contrato assinado é só admin. Pausar ou marcar documentação pendente você pode.</p>
      )}
      {i.status_reason && isPausedLike && (
        <p className="text-xs text-muted-foreground">Motivo: {i.status_reason}</p>
      )}

      <Dialog open={!!pending} onOpenChange={(o) => { if (!setStatus.isPending && !o) { setPending(null); setReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{pending ? ACTION_LABEL[pending] : ""} — {i.code}</DialogTitle>
            <DialogDescription>
              {pendingIsClosing
                ? "A intermediação vai pra Encerrada no funil e o carro sai da jornada. Fica registrado no histórico com o motivo."
                : pending === "paused"
                  ? "A intermediação fica em espera. Dá pra reativar depois e ela volta pro status anterior."
                  : "Marca que falta documento do proprietário/carro. Dá pra reativar quando resolver."}
              {pending === "sold_outside" && " Vai abrir uma tarefa pra analisar a comissão devida (cláusula 8.1)."}
            </DialogDescription>
          </DialogHeader>
          {vehicleListed && pending !== "docs_pending" && (
            <p className="text-xs rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> O carro está anunciado no site — vai gerar uma tarefa pra retirar o anúncio.
            </p>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: proprietário desistiu de vender / vendeu pra um parente" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPending(null); setReason(""); }} disabled={setStatus.isPending}>Cancelar</Button>
            <Button variant={pendingIsClosing ? "destructive" : "default"} onClick={confirm} disabled={setStatus.isPending}>
              {setStatus.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Comissão (só quando concluída) ─────────────────────────────────────────

function CommissionBlock({ i }: { i: Intermediation }) {
  const { isAdmin } = useAuth();
  const setCommission = useSetIntermediationCommission();
  const meta = COMMISSION_STATUS_META[i.commission_status] ?? COMMISSION_STATUS_META.pending;

  const change = async (status: CommissionStatus) => {
    if (status === i.commission_status) return;
    try {
      await setCommission.mutateAsync({ id: i.id, leadId: i.owner_lead_id, status });
      toast.success(`Comissão: ${COMMISSION_STATUS_META[status].label}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui atualizar a comissão.");
    }
  };

  const commissionText = i.commission_type === "percent"
    ? `${i.commission_value ?? "—"}% sobre ${fmtBRL(i.sale_price)}`
    : i.commission_type === "fixed" ? "valor fixo" : "—";

  return (
    <div className="rounded-md border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><Coins className="h-4 w-4 text-emerald-600" /> Comissão</p>
        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{meta.label}</Badge>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div><p className="text-muted-foreground">Venda</p><p className="font-medium">{fmtBRL(i.sale_price)}</p></div>
        <div><p className="text-muted-foreground">Comissão apurada</p><p className="font-medium">{fmtBRL(i.commission_due)} <span className="text-muted-foreground font-normal">({commissionText})</span></p></div>
        <div><p className="text-muted-foreground">{i.commission_paid_at ? "Paga em" : "Concluída em"}</p><p className="font-medium">{fmtDate(i.commission_paid_at ?? i.completed_at)}</p></div>
      </div>
      {isAdmin && (
        <div className="flex items-center gap-2">
          <Label className="text-xs shrink-0">Status</Label>
          <Select value={i.commission_status} disabled={setCommission.isPending} onValueChange={(v) => change(v as CommissionStatus)}>
            <SelectTrigger className="h-8 w-[180px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(COMMISSION_STATUS_META) as CommissionStatus[]).map((k) => <SelectItem key={k} value={k}>{COMMISSION_STATUS_META[k].label}</SelectItem>)}
            </SelectContent>
          </Select>
          {setCommission.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      )}
    </div>
  );
}

// ─── Timeline ───────────────────────────────────────────────────────────────

function summarizePayload(ev: IntermediationEvent): string | null {
  const p = ev.payload ?? {};
  const parts: string[] = [];
  const s = (k: string) => (typeof p[k] === "string" && (p[k] as string).trim() ? (p[k] as string) : null);
  if (s("reason")) parts.push(`motivo: ${s("reason")}`);
  if (typeof p.sale_price === "number") parts.push(`venda ${BRL.format(p.sale_price)}`);
  if (typeof p.commission_due === "number") parts.push(`comissão ${BRL.format(p.commission_due)}`);
  if (typeof p.amount === "number") parts.push(BRL.format(p.amount));
  if (s("status")) parts.push(INTERMEDIATION_STATUS_META[s("status") as keyof typeof INTERMEDIATION_STATUS_META]?.label ?? COMMISSION_STATUS_META[s("status") as CommissionStatus]?.label ?? s("status")!);
  if (s("to")) parts.push(`→ ${INTERMEDIATION_STATUS_META[s("to") as keyof typeof INTERMEDIATION_STATUS_META]?.label ?? s("to")}`);
  if (s("ends_at")) parts.push(`prazo ${fmtDate(s("ends_at"))}`);
  if (s("contract_status")) parts.push(CONTRACT_STATUS_META[s("contract_status") as keyof typeof CONTRACT_STATUS_META]?.label ?? s("contract_status")!);
  if (s("mode") === "imported") parts.push("PDF importado");
  if (s("sha256")) parts.push(`hash ${(s("sha256") as string).slice(0, 12)}…`);
  if (typeof p.listing_price === "number") parts.push(`anúncio ${BRL.format(p.listing_price)}`);
  if (ev.event_type === "commercial_terms_set") {
    if (typeof p.asking_price === "number" || typeof p.asking_price === "string") parts.push(`preço ${BRL.format(Number(p.asking_price))}`);
    if (p.commission_type && p.commission_value != null) parts.push(`comissão ${p.commission_value}${p.commission_type === "percent" ? "%" : " R$"}`);
    if (typeof p.complete === "boolean") parts.push(p.complete ? "completas" : "incompletas");
  }
  if (p.backfill === true) parts.push("migração");
  return parts.length ? parts.join(" · ") : null;
}

function TimelineBlock({ intermediationId, memberName }: { intermediationId: string; memberName: (id: string | null) => string | null }) {
  const [open, setOpen] = useState(false);
  const eventsQ = useIntermediationEvents(open ? intermediationId : null);
  const events = eventsQ.data ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <History className="h-3.5 w-3.5" /> Histórico da intermediação
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {eventsQ.isLoading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Carregando…</p>
        ) : events.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nenhum evento registrado.</p>
        ) : (
          <ul className="space-y-1.5 border-l border-border/60 pl-3">
            {events.map((ev) => {
              const summary = summarizePayload(ev);
              const actor = memberName(ev.actor_member_id);
              return (
                <li key={ev.id} className="text-xs relative">
                  <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-border" />
                  <p className="font-medium">{INTERMEDIATION_EVENT_LABEL[ev.event_type] ?? ev.event_type}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {fmtDateTime(ev.created_at)}{actor ? ` · ${actor}` : ""}{summary ? ` · ${summary}` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

export function IntermediationCard({ leadId }: Props) {
  const { isPromotora } = useAuth();
  const q = useIntermediationByLead(leadId);
  const { data: members = [] } = useAllTeamMembers();
  const { data: legalEntities = [] } = useLegalEntities();

  const memberName = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((x) => m.set(x.id, x.name));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [members]);

  // Só pra avisar "vai gerar tarefa pra retirar o anúncio"
  const vehicleId = q.data?.vehicle_id ?? null;
  const vehicleQ = useQuery({
    queryKey: ["intermediation", "vehicle-listing", vehicleId ?? ""],
    enabled: !!vehicleId,
    queryFn: async () => {
      const { data, error } = await supabase.from("seller_vehicles").select("id, listing_url, listing_missing_since").eq("id", vehicleId!).maybeSingle();
      if (error) throw error;
      return data as { id: string; listing_url: string | null; listing_missing_since: string | null } | null;
    },
    staleTime: 30_000,
  });
  const vehicleListed = !!vehicleQ.data?.listing_url && !vehicleQ.data?.listing_missing_since;

  if (q.isLoading || q.isError || !q.data) return null;
  const i = q.data;

  const statusMeta = INTERMEDIATION_STATUS_META[i.status] ?? INTERMEDIATION_STATUS_META.lead;
  const contractMeta = CONTRACT_STATUS_META[i.contract_status] ?? CONTRACT_STATUS_META.none;
  const promoterName = memberName(i.promoter_id);
  const entity = legalEntities.find((e) => e.id === i.legal_entity_id) ?? null;
  const canEdit = !isPromotora;

  const days = daysUntil(i.ends_at);
  const deadlineBadge = (() => {
    if (i.status !== "active" || !i.ends_at) return null;
    if (i.deadline_status === "expired" || (days != null && days < 0)) {
      return <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300 text-[11px]"><CalendarClock className="h-3 w-3 mr-1" /> Prazo venceu ({fmtDate(i.ends_at)})</Badge>;
    }
    if (i.deadline_status === "expiring" || (days != null && days <= 7)) {
      return <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 text-[11px]"><CalendarClock className="h-3 w-3 mr-1" /> {days === 0 ? "Vence hoje" : `Vence em ${days} dia${days === 1 ? "" : "s"}`}</Badge>;
    }
    return <Badge variant="outline" className="text-[11px] text-muted-foreground"><CalendarClock className="h-3 w-3 mr-1" /> Até {fmtDate(i.ends_at)}</Badge>;
  })();

  return (
    <Card className="border-sky-200/70 dark:border-sky-900/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              <FileSignature className="h-4 w-4 text-sky-600" />
              Intermediação <span className="font-mono text-sm text-muted-foreground">{i.code}</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="inline-flex items-center gap-1"><UserRound className="h-3 w-3" /> Promotora: <strong>{promoterName ?? "—"}</strong></span>
              <span className="inline-flex items-center gap-1"><Building2 className="h-3 w-3" /> {entity?.trade_name ?? entity?.legal_name ?? "Entidade jurídica não definida"}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("border text-[11px]", statusMeta.cls)}>{statusMeta.label}</Badge>
            <Badge variant="outline" className={cn("border text-[11px]", contractMeta.cls)}>{contractMeta.label}</Badge>
            {deadlineBadge}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <TermsBlock i={i} canEdit={canEdit} />
        <ContractBlock i={i} memberName={memberName} />

        {i.status === "completed" && <CommissionBlock i={i} />}

        <StateBlock i={i} vehicleListed={vehicleListed} />

        <TimelineBlock intermediationId={i.id} memberName={memberName} />
      </CardContent>
    </Card>
  );
}
