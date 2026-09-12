import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileSignature, Loader2, Save, Lock, Upload, ExternalLink, Pause, Play, FileWarning, XCircle,
  ChevronDown, ChevronRight, History, Building2, UserRound, CalendarClock, Coins, Info, AlertTriangle,
  Eye, FileText, RefreshCw, ClipboardList, Car, CheckCircle2, Settings2, Layers, Send, Ban, Activity, Search,
  UserPlus, Handshake, Wallet, BadgeCheck, Trophy, Check, DollarSign,
  ShieldAlert, ShieldCheck, Gift, Scale,
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
import { maskCep, maskChassis, maskCpfCnpj, maskPlate, maskRenavam, maskUF, onlyDigits } from "@/lib/brMasks";
import { useAuth } from "@/contexts/AuthContext";
import { useAllTeamMembers } from "@/hooks/useTeamMembers";
import { useSalesLead } from "@/hooks/useSalesLeads";
import {
  ContractRenderError,
  getContractSignedUrl,
  openContractPreview,
  useAddProposal,
  useApprovalRequests,
  useChangeCommission,
  useConcludeSale,
  useConfirmPayment,
  useContractCancel,
  useContractDocuments,
  useContractEvents,
  useContractResend,
  useContractSnapshot,
  useContractStatus,
  useDecideProposal,
  useGenerateContract,
  useImportSaleContract,
  useImportSignedContract,
  useIntermediationByLead,
  useIntermediationEvents,
  useIntermediationProposals,
  useLegalEntities,
  usePowersOfAttorney,
  useRequestConcession,
  useSetBuyer,
  useSetContractData,
  useSetIntermediationCommission,
  useSetIntermediationStatus,
  useSetIntermediationTerms,
  useWaiveCommission,
} from "@/hooks/useIntermediation";
import { ContractSignatureDialog } from "@/components/sales/ContractSignatureDialog";
import { useVehicleLookup } from "@/hooks/useVehicleLookup";
import {
  COMMISSION_STATUS_META,
  CONTRACT_DOCUMENT_STATUS_META,
  CONTRACT_EVENT_TYPE_LABEL,
  CONTRACT_FAILED_STATUSES,
  CONTRACT_IN_FLIGHT_STATUSES,
  CONTRACT_MISSING_SOURCE_LABEL,
  CONTRACT_SENDABLE_STATUSES,
  CONTRACT_SIGNER_STATUS_META,
  CONTRACT_STATUS_META,
  CUSTODY_MODE_LABEL,
  INTERMEDIATION_EVENT_LABEL,
  INTERMEDIATION_STATUS_META,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATUS_META,
  PROPOSAL_STATUS_META,
  SALE_CONTRACT_STATUS_META,
  SIGNER_CHANNEL_LABEL,
  SIGNER_PARTY_LABEL,
  TEST_DRIVE_POLICY_LABEL,
  POA_ROLE,
  isNeedsApproval,
  missingTerms,
  type BuyerData,
  type CommissionStatus,
  type CommissionType,
  type ContractDocument,
  type ContractEvent,
  type ContractEventType,
  type ContractMissing,
  type ContractMissingSource,
  type ContractSnapshot,
  type CustodyMode,
  type Intermediation,
  type IntermediationEvent,
  type IntermediationStatusAction,
  type IntermediationTermsInput,
  type PaymentMethod,
  type Proposal,
  type ProposalInput,
  type TestDrivePolicy,
} from "@/types/intermediation";

/** Toast padrão quando uma RPC de domínio devolve needs_approval (não é erro nem sucesso aplicado). */
const APPROVAL_TOAST = "Enviado para aprovação de uma administradora.";

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

/** Campos do lead que pré-preenchem o proprietário (colunas de `leads`). */
interface LeadContractFields {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  cpf_cnpj?: string | null;
  address?: string | null;
  address_number?: string | null;
  address_complement?: string | null;
  address_province?: string | null;
  postal_code?: string | null;
  city_name?: string | null;
  state?: string | null;
}

/** Colunas de `seller_vehicles` que o contrato usa. */
interface VehicleContractFields {
  id: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  year_model: number | null;
  km: number | null;
  color: string | null;
  fuel: string | null;
  plate: string | null;
  renavam: string | null;
  chassis: string | null;
  condition_notes: string | null;
  listing_url: string | null;
  listing_missing_since: string | null;
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

// ─── Dados do contrato (proprietário + veículo) ─────────────────────────────

interface ContractDataForm {
  cpf_cnpj: string; rg: string; address: string; address_number: string; complement: string; district: string;
  zip: string; city: string; state: string; email: string; phone: string;
  plate: string; renavam: string; chassis: string; color: string; fuel: string; brand: string; model: string;
  version: string; year_model: string; km: string; accessories: string;
}

/** Primeiro valor preenchido (owner_data → lead → vazio). */
function pick(...vals: (string | number | null | undefined)[]): string {
  for (const v of vals) if (v != null && String(v).trim() !== "") return String(v).trim();
  return "";
}

function toContractDataForm(i: Intermediation, lead: LeadContractFields | null, v: VehicleContractFields | null): ContractDataForm {
  const o = i.owner_data ?? {};
  const st = pick(o.state, lead?.state);
  return {
    cpf_cnpj: maskCpfCnpj(pick(o.cpf_cnpj, lead?.cpf_cnpj)),
    rg: pick(o.rg),
    address: pick(o.address, lead?.address),
    address_number: pick(o.address_number, lead?.address_number),
    complement: pick(o.complement, lead?.address_complement),
    district: pick(o.district, lead?.address_province),
    zip: maskCep(pick(o.zip, lead?.postal_code)),
    city: pick(o.city, lead?.city_name),
    state: st.length <= 2 ? st.toUpperCase() : st,
    email: pick(o.email, lead?.email),
    phone: pick(o.phone, lead?.phone),
    plate: maskPlate(pick(v?.plate)),
    renavam: pick(v?.renavam),
    chassis: pick(v?.chassis),
    color: pick(v?.color),
    fuel: pick(v?.fuel),
    brand: pick(v?.brand),
    model: pick(v?.model, v?.description),
    version: pick(v?.version),
    year_model: pick(v?.year_model),
    km: pick(v?.km),
    accessories: pick(v?.condition_notes),
  };
}

function Field({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function ContractDataBlock({ i, lead, vehicle, open, onOpenChange, canEdit, missing, sectionRef }: {
  i: Intermediation;
  lead: LeadContractFields | null;
  vehicle: VehicleContractFields | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canEdit: boolean;
  missing: ContractMissing[];
  sectionRef: RefObject<HTMLDivElement>;
}) {
  const { isAdmin } = useAuth();
  const setData = useSetContractData();
  const plateLookup = useVehicleLookup();
  const [f, setF] = useState<ContractDataForm>(() => toContractDataForm(i, lead, vehicle));
  const [dirty, setDirty] = useState(false);

  // Re-sincroniza com o servidor só enquanto o usuário não mexeu (não apaga o que ele está digitando)
  useEffect(() => { if (!dirty) setF(toContractDataForm(i, lead, vehicle)); }, [i, lead, vehicle, dirty]);

  const signedLocked = (i.contract_status === "signed" || i.contract_status === "imported") && !isAdmin;
  const closed = INTERMEDIATION_STATUS_META[i.status].closed;
  const readOnly = !canEdit || signedLocked || closed;
  const ownerMissing = missing.filter((m) => m.source === "contract_data.owner");
  const vehicleMissing = missing.filter((m) => m.source === "contract_data.vehicle");
  const missingCount = ownerMissing.length + vehicleMissing.length;

  const set = (k: keyof ContractDataForm, v: string) => { setF((prev) => ({ ...prev, [k]: v })); setDirty(true); };

  const consultarPlaca = async () => {
    const placa = f.plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (placa.length !== 7) { toast.error("Preencha a placa (7 caracteres, ex.: ABC1D23) antes de consultar."); return; }
    try {
      const res = await plateLookup.mutateAsync({ placa, lead_id: i.owner_lead_id });
      if (!res.found) { toast.warning("Não achei os dados dessa placa. Preencha na mão."); return; }
      const v = res.vehicle;
      setF((prev) => ({
        ...prev,
        plate: res.plate,
        brand: v.marca ?? prev.brand,
        model: v.modelo ?? prev.model,
        year_model: v.ano_modelo ? String(v.ano_modelo) : (v.ano_fabricacao ? String(v.ano_fabricacao) : prev.year_model),
        color: v.cor ?? prev.color,
        fuel: v.combustivel ?? prev.fuel,
        chassis: v.chassi ? String(v.chassi).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17) : prev.chassis,
        renavam: v.renavam ? String(v.renavam).replace(/\D/g, "").slice(0, 11) : prev.renavam,
      }));
      setDirty(true);
      toast.success(`Dados da placa preenchidos${res.cached ? " (consulta recente)" : ""}. Confira e salve.`);
    } catch (e) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 412) {
        toast.error("Consulta de placa não configurada (Configurações › Integrações › PuxaPlaca).");
      } else {
        toast.error(e instanceof Error ? e.message : "Não consegui consultar a placa.");
      }
    }
  };

  const save = async () => {
    if (f.year_model && !/^\d{4}$/.test(f.year_model)) { toast.error("Ano do veículo precisa ter 4 dígitos (ex.: 2021)."); return; }
    if (f.plate && f.plate.length !== 7) { toast.error("Placa precisa ter 7 caracteres (ex.: ABC1D23)."); return; }
    if (f.chassis && f.chassis.length !== 17) { toast.error("Chassi precisa ter 17 caracteres."); return; }
    if (f.renavam && (f.renavam.length < 9 || f.renavam.length > 11)) { toast.error("Renavam tem 11 dígitos (9 nos documentos antigos)."); return; }
    if (f.km && !/^\d+$/.test(f.km)) { toast.error("Quilometragem: só números."); return; }
    const vehicleTouched = [f.plate, f.renavam, f.chassis, f.color, f.fuel, f.brand, f.model, f.version, f.year_model, f.km, f.accessories].some(Boolean);
    if (!vehicle && vehicleTouched) {
      toast.error("Esse lead ainda não tem veículo cadastrado — cadastre o carro no card Captação antes de preencher os dados dele.");
      return;
    }
    try {
      const snap = await setData.mutateAsync({
        id: i.id,
        leadId: i.owner_lead_id,
        data: {
          owner: {
            cpf_cnpj: f.cpf_cnpj.trim(), rg: f.rg.trim(), address: f.address.trim(), address_number: f.address_number.trim(),
            complement: f.complement.trim(), district: f.district.trim(), zip: f.zip.trim(), city: f.city.trim(),
            state: f.state.trim(), email: f.email.trim().toLowerCase(), phone: f.phone.trim(),
          },
          vehicle: vehicle
            ? {
                plate: f.plate, renavam: f.renavam, chassis: f.chassis, color: f.color, fuel: f.fuel, brand: f.brand,
                model: f.model, version: f.version, year_model: f.year_model, km: f.km, accessories: f.accessories,
              }
            : undefined,
        },
      });
      setDirty(false);
      if (snap.ready) toast.success("Dados salvos. Tudo pronto pra gerar o contrato.");
      else if (snap.missing.length) {
        const first = snap.missing.slice(0, 4).map((m) => m.label).join(", ");
        toast.success(`Dados salvos. Ainda falta: ${first}${snap.missing.length > 4 ? "…" : ""}.`);
      } else toast.success("Dados salvos.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar os dados do contrato.");
    }
  };

  const inputCls = "h-9";

  return (
    <div ref={sectionRef} className="rounded-md border border-border/60 p-3 space-y-3 scroll-mt-24">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="text-sm font-semibold flex items-center gap-1.5 hover:text-foreground">
              {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
              <ClipboardList className="h-4 w-4 text-violet-600" /> Dados do contrato
            </button>
          </CollapsibleTrigger>
          {missingCount > 0 ? (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300 text-[11px]">
              <AlertTriangle className="h-3 w-3 mr-1" /> Falta: {missingCount} {missingCount === 1 ? "campo" : "campos"}
            </Badge>
          ) : (
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 text-[11px]">
              <CheckCircle2 className="h-3 w-3 mr-1" /> Completos
            </Badge>
          )}
        </div>

        <CollapsibleContent className="pt-3 space-y-4">
          {signedLocked && (
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Contrato já assinado: esses dados só mudam por aditivo (admin).
            </p>
          )}

          {/* Proprietário */}
          <div className="space-y-2">
            <p className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground"><UserRound className="h-3.5 w-3.5" /> Proprietário{lead?.name ? <span className="text-foreground">· {lead.name}</span> : null}</p>
            {ownerMissing.length > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">Falta: {ownerMissing.map((m) => m.label).join(" · ")}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="CPF / CNPJ *"><Input inputMode="numeric" className={inputCls} value={f.cpf_cnpj} disabled={readOnly} placeholder="000.000.000-00" onChange={(e) => set("cpf_cnpj", maskCpfCnpj(e.target.value))} /></Field>
              <Field label="RG / IE"><Input className={inputCls} value={f.rg} disabled={readOnly} placeholder="Ex.: 12.345.678-9" onChange={(e) => set("rg", e.target.value)} /></Field>
              <Field label="CEP"><Input inputMode="numeric" className={inputCls} value={f.zip} disabled={readOnly} placeholder="00000-000" onChange={(e) => set("zip", maskCep(e.target.value))} /></Field>
              <Field label="Endereço (rua/avenida) *" className="sm:col-span-2"><Input className={inputCls} value={f.address} disabled={readOnly} placeholder="Ex.: Rua das Flores" onChange={(e) => set("address", e.target.value)} /></Field>
              <Field label="Número"><Input className={inputCls} value={f.address_number} disabled={readOnly} placeholder="Ex.: 120" onChange={(e) => set("address_number", e.target.value)} /></Field>
              <Field label="Complemento"><Input className={inputCls} value={f.complement} disabled={readOnly} placeholder="Ex.: apto 32" onChange={(e) => set("complement", e.target.value)} /></Field>
              <Field label="Bairro"><Input className={inputCls} value={f.district} disabled={readOnly} placeholder="Ex.: Alphaville" onChange={(e) => set("district", e.target.value)} /></Field>
              <div className="grid grid-cols-[1fr_72px] gap-2">
                <Field label="Cidade *"><Input className={inputCls} value={f.city} disabled={readOnly} placeholder="Ex.: Barueri" onChange={(e) => set("city", e.target.value)} /></Field>
                <Field label="UF *"><Input className={cn(inputCls, "uppercase")} value={f.state} disabled={readOnly} placeholder="SP" maxLength={2} onChange={(e) => set("state", maskUF(e.target.value))} /></Field>
              </div>
              <Field label="E-mail"><Input type="email" className={inputCls} value={f.email} disabled={readOnly} placeholder="nome@email.com" onChange={(e) => set("email", e.target.value)} /></Field>
              <Field label="Telefone / WhatsApp *"><Input inputMode="tel" className={inputCls} value={f.phone} disabled={readOnly} placeholder="(11) 99999-9999" onChange={(e) => set("phone", e.target.value)} /></Field>
            </div>
          </div>

          {/* Veículo */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground"><Car className="h-3.5 w-3.5" /> Veículo</p>
              {vehicle && !readOnly && (
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs"
                  disabled={plateLookup.isPending || f.plate.replace(/[^A-Za-z0-9]/g, "").length !== 7} onClick={consultarPlaca}>
                  {plateLookup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <><Search className="h-3.5 w-3.5 mr-1" /> Consultar placa</>}
                </Button>
              )}
            </div>
            {!vehicle && <p className="text-[11px] text-amber-700 dark:text-amber-300">Esse lead ainda não tem veículo cadastrado. Cadastre o carro no card Captação e volte aqui.</p>}
            {vehicleMissing.length > 0 && <p className="text-[11px] text-amber-700 dark:text-amber-300">Falta: {vehicleMissing.map((m) => m.label).join(" · ")}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Placa *"><Input className={cn(inputCls, "uppercase font-mono")} value={f.plate} disabled={readOnly || !vehicle} placeholder="ABC1D23" maxLength={7} onChange={(e) => set("plate", maskPlate(e.target.value))} /></Field>
              <Field label="Renavam *"><Input inputMode="numeric" className={cn(inputCls, "font-mono")} value={f.renavam} disabled={readOnly || !vehicle} placeholder="00000000000" onChange={(e) => set("renavam", maskRenavam(e.target.value))} /></Field>
              <Field label="Chassi *"><Input className={cn(inputCls, "uppercase font-mono")} value={f.chassis} disabled={readOnly || !vehicle} placeholder="17 caracteres" maxLength={17} onChange={(e) => set("chassis", maskChassis(e.target.value))} /></Field>
              <Field label="Marca"><Input className={inputCls} value={f.brand} disabled={readOnly || !vehicle} placeholder="Ex.: Toyota" onChange={(e) => set("brand", e.target.value)} /></Field>
              <Field label="Modelo *"><Input className={inputCls} value={f.model} disabled={readOnly || !vehicle} placeholder="Ex.: Corolla" onChange={(e) => set("model", e.target.value)} /></Field>
              <Field label="Versão"><Input className={inputCls} value={f.version} disabled={readOnly || !vehicle} placeholder="Ex.: XEi 2.0" onChange={(e) => set("version", e.target.value)} /></Field>
              <Field label="Ano modelo *"><Input inputMode="numeric" className={inputCls} value={f.year_model} disabled={readOnly || !vehicle} placeholder="2021" maxLength={4} onChange={(e) => set("year_model", onlyDigits(e.target.value).slice(0, 4))} /></Field>
              <Field label="Quilometragem (km) *"><Input inputMode="numeric" className={inputCls} value={f.km} disabled={readOnly || !vehicle} placeholder="Ex.: 45000" onChange={(e) => set("km", onlyDigits(e.target.value).slice(0, 7))} /></Field>
              <Field label="Cor"><Input className={inputCls} value={f.color} disabled={readOnly || !vehicle} placeholder="Ex.: Prata" onChange={(e) => set("color", e.target.value)} /></Field>
              <Field label="Combustível"><Input className={inputCls} value={f.fuel} disabled={readOnly || !vehicle} placeholder="Ex.: Flex" onChange={(e) => set("fuel", e.target.value)} /></Field>
              <Field label="Acessórios relevantes" className="sm:col-span-2"><Input className={inputCls} value={f.accessories} disabled={readOnly || !vehicle} placeholder="Ex.: teto solar, multimídia, 2 chaves" onChange={(e) => set("accessories", e.target.value)} /></Field>
            </div>
          </div>

          {!readOnly && (
            <div className="flex items-center justify-end gap-2">
              {dirty && <span className="text-[11px] text-muted-foreground">Alterações não salvas</span>}
              <Button size="sm" onClick={save} disabled={setData.isPending}>
                {setData.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
                Salvar dados
              </Button>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ─── Contrato ───────────────────────────────────────────────────────────────

/** Abre uma aba ANTES do await (bloqueador de pop-up) e navega pra URL quando ela chegar. */
async function openPdfTab(getUrl: () => Promise<string>) {
  const win = window.open("about:blank", "_blank");
  if (win) win.opener = null;
  try {
    const url = await getUrl();
    if (win) win.location.href = url;
    else window.open(url, "_blank", "noopener");
  } catch (e) {
    win?.close();
    throw e;
  }
}

function renderErrorToast(e: unknown, fallback: string) {
  if (e instanceof ContractRenderError && e.missing.length > 0) {
    toast.error(e.message, { description: `Falta: ${e.missing.map((m) => m.label).join(", ")}.` });
    return;
  }
  toast.error(e instanceof Error ? e.message : fallback);
}

const LIVE_DOC_STATUSES = ["draft", "generated", "ready", "error"];

/** Data mais relevante do signatário conforme o status (assinou > recusou > viu > convite). */
function signerWhen(s: NonNullable<ContractDocument["contract_signers"]>[number]): string | null {
  if (s.status === "signed" && s.signed_at) return `assinou em ${fmtDateTime(s.signed_at)}`;
  if (s.status === "declined" && s.refused_at) return `recusou em ${fmtDateTime(s.refused_at)}`;
  if (s.status === "viewed" && s.viewed_at) return `viu em ${fmtDateTime(s.viewed_at)}`;
  if (s.status === "sent" && s.sent_at) return `convite em ${fmtDateTime(s.sent_at)}`;
  return null;
}

function DocumentSigners({ doc, inFlight }: { doc: ContractDocument; inFlight: boolean }) {
  const signers = doc.contract_signers ?? [];
  if (signers.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{inFlight ? "Signatários" : "Signatários previstos"}</p>
      <ul className="space-y-0.5">
        {signers.map((s) => {
          const sm = CONTRACT_SIGNER_STATUS_META[s.status] ?? CONTRACT_SIGNER_STATUS_META.pending;
          const when = signerWhen(s);
          const channel = s.channel ? SIGNER_CHANNEL_LABEL[s.channel] : null;
          return (
            <li key={s.id} className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", sm.cls)}>{sm.label}</Badge>
              <span>
                {SIGNER_PARTY_LABEL[s.party_type] ?? s.party_type}: <strong className="text-foreground">{s.name}</strong>
                {s.cpf_cnpj ? <span className="text-muted-foreground"> · {s.cpf_cnpj}</span> : null}
                {inFlight && channel ? <span className="text-muted-foreground"> · via {channel}</span> : null}
                {when ? <span className="text-muted-foreground"> · {when}</span> : null}
              </span>
              {s.status === "declined" && s.refusal_reason && <span className="basis-full text-[11px] text-red-700 dark:text-red-300 pl-1">Motivo: {s.refusal_reason}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Nome do signatário a partir do `signer_ref` do evento (provider id, e-mail ou telefone). */
function eventSignerName(ev: ContractEvent, doc: ContractDocument): string | null {
  const ref = ev.signer_ref?.trim();
  if (!ref) return null;
  const digits = ref.replace(/\D/g, "");
  const s = (doc.contract_signers ?? []).find(
    (x) => x.provider_signer_id === ref || (x.email ?? "").toLowerCase() === ref.toLowerCase() || (digits.length >= 8 && (x.phone ?? "").replace(/\D/g, "") === digits),
  );
  return s ? `${SIGNER_PARTY_LABEL[s.party_type] ?? s.party_type} · ${s.name}` : ref;
}

function ContractEventsBlock({ doc }: { doc: ContractDocument }) {
  const [open, setOpen] = useState(false);
  const eventsQ = useContractEvents(open ? doc.id : null);
  const events = eventsQ.data ?? [];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Activity className="h-3.5 w-3.5" /> Eventos da assinatura
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1.5">
        {eventsQ.isLoading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Carregando…</p>
        ) : eventsQ.isError ? (
          <p className="text-[11px] text-muted-foreground">Não consegui carregar os eventos.</p>
        ) : events.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nenhum evento recebido do provedor ainda.</p>
        ) : (
          <ul className="space-y-1.5 border-l border-border/60 pl-3">
            {events.map((ev) => {
              const label = CONTRACT_EVENT_TYPE_LABEL[ev.event_type as ContractEventType] ?? ev.event_type;
              const who = eventSignerName(ev, doc);
              const p = ev.payload ?? {};
              const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason : typeof p.message === "string" && p.message.trim() ? p.message : null;
              const synthetic = (ev.provider_event_id ?? "").startsWith("reconcile:");
              return (
                <li key={ev.id} className="text-[11px] relative">
                  <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-border" />
                  <p className="font-medium text-xs">
                    {label}
                    {ev.raw_event_name && ev.raw_event_name !== ev.event_type ? <span className="text-muted-foreground font-normal"> ({ev.raw_event_name})</span> : null}
                    {synthetic ? <span className="text-muted-foreground font-normal"> · conferência</span> : null}
                  </p>
                  <p className="text-muted-foreground">
                    {fmtDateTime(ev.occurred_at ?? ev.received_at)}{who ? ` · ${who}` : ""}{reason ? ` · ${reason}` : ""}
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

/** Prazo de assinatura (`deadline_at`) em texto curto. */
function deadlineText(iso: string | null): { text: string; overdue: boolean } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (ms < 0) return { text: `Prazo venceu em ${fmtDate(iso)}`, overdue: true };
  if (days <= 1) return { text: `Prazo: até ${fmtDateTime(iso)} (hoje/amanhã)`, overdue: false };
  return { text: `Prazo: até ${fmtDate(iso)} (${days} dias)`, overdue: false };
}

function ContractBlock({ i, memberName, snapshot, snapshotLoading, docs, currentDoc, onJump }: {
  i: Intermediation;
  memberName: (id: string | null) => string | null;
  snapshot: ContractSnapshot | null;
  snapshotLoading: boolean;
  docs: ContractDocument[];
  currentDoc: ContractDocument | null;
  onJump: (source: ContractMissingSource) => void;
}) {
  const { isAdmin, isPromotora } = useAuth();
  const importContract = useImportSignedContract();
  const generate = useGenerateContract();
  const resend = useContractResend();
  const cancelSend = useContractCancel();
  const checkStatus = useContractStatus();
  const [importOpen, setImportOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenReason, setRegenReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [signedAt, setSignedAt] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const meta = CONTRACT_STATUS_META[i.contract_status] ?? CONTRACT_STATUS_META.none;
  const termsMissing = missingTerms(i);
  const hasContract = i.contract_status === "signed" || i.contract_status === "imported";
  const canImportStatus = ["lead", "contracting", "docs_pending", "paused"].includes(i.status);
  const closed = INTERMEDIATION_STATUS_META[i.status].closed;
  const missing = snapshot?.missing ?? [];
  const ready = snapshot?.ready === true;
  const nextVersion = snapshot?.next_version ?? (docs[0]?.version ?? 0) + 1;
  const canGenerate = !isPromotora && !hasContract && canImportStatus && !closed;
  const canRegenerate = canGenerate && !!currentDoc && LIVE_DOC_STATUSES.includes(currentDoc.status);
  const history = docs.filter((d) => d.id !== currentDoc?.id);

  // Fase 3: assinatura eletrônica
  const docSendable = !!currentDoc && CONTRACT_SENDABLE_STATUSES.includes(currentDoc.status);
  const docInFlight = !!currentDoc && CONTRACT_IN_FLIGHT_STATUSES.includes(currentDoc.status);
  const docFailed = !!currentDoc && CONTRACT_FAILED_STATUSES.includes(currentDoc.status);
  const canSend = canGenerate && docSendable && termsMissing.length === 0;
  const signatureBusy = resend.isPending || cancelSend.isPending || checkStatus.isPending;
  const deadline = currentDoc && docInFlight ? deadlineText(currentDoc.deadline_at) : null;

  const badgeLabel = i.contract_status === "generated" && currentDoc ? `Gerado v${currentDoc.version} · aguardando envio` : meta.label;

  const resetImport = () => { setFile(null); setSignedAt(todayISO()); setReason(""); };

  const runResend = async () => {
    if (!currentDoc) return;
    try {
      await resend.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id });
      toast.success("Convites reenviados pelos canais escolhidos.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui reenviar os convites.");
    }
  };

  const runCheck = async () => {
    if (!currentDoc) return;
    try {
      const r = await checkStatus.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id });
      if (r.finalized) toast.success(`Contrato v${currentDoc.version} assinado e conferido — ${i.code} formalizada.`);
      else if (r.applied > 0) toast.success(`Status atualizado (${r.applied} ${r.applied === 1 ? "evento novo" : "eventos novos"}).`);
      else {
        const st = r.document ? CONTRACT_DOCUMENT_STATUS_META[r.document.status]?.label ?? r.document.status : null;
        toast.info(st ? `Sem novidades — ${st.toLowerCase()}.` : "Sem novidades por enquanto.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui consultar o status da assinatura.");
    }
  };

  const confirmCancelSend = async () => {
    if (!currentDoc) return;
    if (cancelReason.trim().length < 3) { toast.error("Descreva o motivo do cancelamento."); return; }
    try {
      await cancelSend.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id, reason: cancelReason.trim() });
      toast.success(`Envio da v${currentDoc.version} cancelado. Gere uma nova versão quando quiser enviar de novo.`);
      setCancelOpen(false);
      setCancelReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui cancelar o envio.");
    }
  };

  const confirmImport = async () => {
    if (!file) { toast.error("Escolha o PDF do contrato assinado."); return; }
    if (reason.trim().length < 3) { toast.error("Descreva o motivo/origem (ex.: assinado em papel na loja)."); return; }
    try {
      const r = await importContract.mutateAsync({
        id: i.id, leadId: i.owner_lead_id, file, signedAt, reason,
        documentId: currentDoc?.id ?? i.contract_document_id ?? null,
      });
      if (r.already) toast.info(`${r.code} já estava formalizada.`);
      else toast.success(`${r.code} formalizada — prêmio de R$ 25 gerado (pendente de aprovação).`);
      setImportOpen(false);
      resetImport();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui importar o contrato.");
    }
  };

  const openPath = async (path: string, key: string) => {
    setOpening(key);
    try {
      await openPdfTab(() => getContractSignedUrl(path, 600));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui abrir o PDF.");
    } finally {
      setOpening(null);
    }
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await openContractPreview(i.id);
    } catch (e) {
      renderErrorToast(e, "Não consegui montar a pré-visualização.");
    } finally {
      setPreviewing(false);
    }
  };

  const runGenerate = async (why?: string) => {
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    try {
      const r = await generate.mutateAsync({ id: i.id, leadId: i.owner_lead_id, reason: why ?? null });
      toast.success(`Contrato v${r.document.version} gerado.`);
      let url = r.signed_url;
      if (!url && r.document.rendered_file_path) url = await getContractSignedUrl(r.document.rendered_file_path, 600).catch(() => null);
      if (url) { if (win) win.location.href = url; else window.open(url, "_blank", "noopener"); }
      else win?.close();
      setRegenOpen(false);
      setRegenReason("");
    } catch (e) {
      win?.close();
      renderErrorToast(e, "Não consegui gerar o contrato.");
    }
  };

  const confirmRegenerate = () => {
    if (regenReason.trim().length < 3) { toast.error("Descreva o motivo da nova versão."); return; }
    void runGenerate(regenReason.trim());
  };

  const docMeta = currentDoc ? CONTRACT_DOCUMENT_STATUS_META[currentDoc.status] ?? CONTRACT_DOCUMENT_STATUS_META.generated : null;
  const generatedBy = currentDoc ? memberName(currentDoc.generated_by) : null;
  const primaryHash = currentDoc?.signed_sha256 ?? currentDoc?.rendered_sha256 ?? null;

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><FileSignature className="h-4 w-4 text-emerald-600" /> Contrato</p>
        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{badgeLabel}</Badge>
      </div>

      {/* Assinado/importado: resumo (mantido da fase 1) */}
      {hasContract && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>
            Assinado em <strong className="text-foreground">{fmtDate(i.contract_signed_at)}</strong>
            {i.contract_status === "signed" ? " · assinatura eletrônica" : null}
            {i.contract_imported_by && memberName(i.contract_imported_by) ? <> · importado por <strong className="text-foreground">{memberName(i.contract_imported_by)}</strong></> : null}
          </p>
          {i.contract_sha256 && <p>Hash SHA-256: <code className="text-[11px]">{i.contract_sha256.slice(0, 12)}…</code></p>}
          {i.contract_import_reason && <p>Origem: {i.contract_import_reason}</p>}
          {i.contract_file_path && (
            <button type="button" onClick={() => openPath(i.contract_file_path!, "signed-main")} disabled={opening === "signed-main"} className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-60">
              {opening === "signed-main" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF assinado
            </button>
          )}
        </div>
      )}

      {/* Checklist do snapshot */}
      {!hasContract && !isPromotora && (
        snapshotLoading && !snapshot ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Conferindo o que falta pro contrato…</p>
        ) : snapshot && missing.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 p-2.5">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Falta pra gerar o contrato ({missing.length}):</p>
            <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
              {missing.map((m) => (
                <li key={m.key} className="text-[11px]">
                  {m.source === "legal_entity" ? (
                    <a href="/configuracoes?s=intermediacao" className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200 hover:underline">
                      <Settings2 className="h-3 w-3 shrink-0" /> {m.label} <span className="text-muted-foreground">· Configurações › Intermediação</span>
                    </a>
                  ) : (
                    <button type="button" onClick={() => onJump(m.source)} className="inline-flex items-center gap-1 text-left text-amber-900 dark:text-amber-200 hover:underline">
                      <ChevronRight className="h-3 w-3 shrink-0" /> {m.label} <span className="text-muted-foreground">· {CONTRACT_MISSING_SOURCE_LABEL[m.source] ?? m.source}</span>
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : snapshot && !snapshot.template ? (
          <p className="text-xs rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Nenhum template de contrato vigente. Peça pra publicar um em <a href="/configuracoes?s=intermediacao" className="underline">Configurações › Intermediação</a>.
          </p>
        ) : snapshot ? (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Tudo preenchido — template "{snapshot.template!.name}" v{snapshot.template!.version}{snapshot.template!.global ? " (Totex)" : ""}.
          </p>
        ) : null
      )}

      {/* Ações */}
      {!hasContract && !isPromotora && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Eye className="h-4 w-4 mr-1" />} Pré-visualizar
          </Button>
          {docInFlight ? null : !currentDoc || !LIVE_DOC_STATUSES.includes(currentDoc.status) ? (
            <Button size="sm" variant={docFailed ? "outline" : "default"} disabled={!ready || !canGenerate || generate.isPending} onClick={() => runGenerate()} title={!ready ? "Preencha o que falta antes de gerar" : undefined}>
              {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileText className="h-4 w-4 mr-1" />} Gerar contrato v{nextVersion}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!ready || !canRegenerate || generate.isPending} onClick={() => setRegenOpen(true)}>
              <RefreshCw className="h-4 w-4 mr-1" /> Regenerar
            </Button>
          )}
          {docSendable && currentDoc && (
            <Button size="sm" disabled={!canSend || generate.isPending} onClick={() => setSendOpen(true)} title={termsMissing.length > 0 ? `Preencha nas condições comerciais: ${termsMissing.join(", ")}` : undefined}>
              <Send className="h-4 w-4 mr-1" /> {currentDoc.status === "error" ? "Enviar novamente" : "Enviar para assinatura"}
            </Button>
          )}
          {docInFlight && currentDoc && (
            <>
              {currentDoc.status !== "completed" && (
                <Button size="sm" variant="outline" disabled={signatureBusy} onClick={runResend}>
                  {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />} Reenviar convites
                </Button>
              )}
              <Button size="sm" variant={currentDoc.status === "completed" ? "default" : "outline"} disabled={signatureBusy} onClick={runCheck}>
                {checkStatus.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />} Verificar agora
              </Button>
              {currentDoc.status !== "completed" && (
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={signatureBusy} onClick={() => setCancelOpen(true)}>
                  <Ban className="h-4 w-4 mr-1" /> Cancelar envio
                </Button>
              )}
            </>
          )}
          {canImportStatus && (
            isAdmin ? (
              <Button size="sm" variant="ghost" disabled={termsMissing.length > 0} onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4 mr-1" /> {currentDoc ? `Importar assinado em papel (v${currentDoc.version})` : "Importar contrato assinado (PDF)"}
              </Button>
            ) : (
              !docInFlight && <span className="text-[11px] text-muted-foreground">Se for assinado em papel, o admin importa o PDF aqui.</span>
            )
          )}
        </div>
      )}
      {!hasContract && !isPromotora && docInFlight && currentDoc && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1">
          <Info className="h-3 w-3 shrink-0 mt-0.5" />
          {currentDoc.status === "completed"
            ? "Todos assinaram. Estamos baixando e conferindo o PDF assinado — clique em \"Verificar agora\" pra concluir na hora."
            : "Enquanto o envio estiver em andamento não dá pra gerar outra versão. Pra alterar o contrato, cancele o envio primeiro."}
        </p>
      )}
      {!hasContract && !isPromotora && isAdmin && canImportStatus && termsMissing.length > 0 && (
        <p className="text-[11px] text-muted-foreground">Antes de enviar ou importar, preencha nas condições comerciais: {termsMissing.join(", ")}.</p>
      )}
      {!hasContract && isPromotora && (
        <p className="text-xs text-muted-foreground">
          {!currentDoc ? "Sem contrato assinado." : docInFlight ? `Contrato v${currentDoc.version} enviado pra assinatura.` : `Contrato v${currentDoc.version} gerado, aguardando assinatura.`}
        </p>
      )}

      {/* Documento atual */}
      {currentDoc && docMeta && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <p className="font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-sky-600" /> Contrato v{currentDoc.version}
              <span className="text-muted-foreground font-normal">· template v{currentDoc.template_version ?? "—"}</span>
            </p>
            <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", docMeta.cls)}>{docMeta.label}</Badge>
          </div>
          <p className="text-muted-foreground">
            {currentDoc.generated_at ? `Gerado em ${fmtDateTime(currentDoc.generated_at)}` : `Registrado em ${fmtDateTime(currentDoc.created_at)}`}
            {generatedBy ? ` por ${generatedBy}` : ""}
            {primaryHash ? <> · hash <code className="text-[11px]">{primaryHash.slice(0, 12)}…</code></> : null}
          </p>
          <div className="flex flex-wrap gap-3">
            {currentDoc.rendered_file_path && (
              <button type="button" onClick={() => openPath(currentDoc.rendered_file_path!, "cur-rendered")} disabled={opening === "cur-rendered"} className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline disabled:opacity-60">
                {opening === "cur-rendered" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF
              </button>
            )}
            {currentDoc.signed_file_path && currentDoc.signed_file_path !== i.contract_file_path && (
              <button type="button" onClick={() => openPath(currentDoc.signed_file_path!, "cur-signed")} disabled={opening === "cur-signed"} className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-60">
                {opening === "cur-signed" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF assinado
              </button>
            )}
          </div>
          {docInFlight && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
              {currentDoc.sent_at && <span>Enviado em {fmtDateTime(currentDoc.sent_at)}</span>}
              {deadline && <span className={cn("inline-flex items-center gap-1", deadline.overdue && "text-red-700 dark:text-red-300")}><CalendarClock className="h-3 w-3" /> {deadline.text}</span>}
              {currentDoc.last_event_at && <span>Última atualização {fmtDateTime(currentDoc.last_event_at)}</span>}
            </div>
          )}
          {docFailed && (
            <p className={cn("flex items-start gap-1", currentDoc.status === "cancelled" ? "text-muted-foreground" : "text-red-700 dark:text-red-300")}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                {currentDoc.status === "error"
                  ? `Erro no envio: ${currentDoc.error_message ?? "sem detalhes"}`
                  : `${CONTRACT_DOCUMENT_STATUS_META[currentDoc.status].label}${currentDoc.cancel_reason ? `: ${currentDoc.cancel_reason}` : ""}${currentDoc.cancelled_at ? ` · ${fmtDateTime(currentDoc.cancelled_at)}` : ""}`}
                {currentDoc.status !== "error" && !isPromotora ? " — gere uma nova versão pra enviar de novo." : null}
              </span>
            </p>
          )}
          <DocumentSigners doc={currentDoc} inFlight={docInFlight || docFailed || currentDoc.status === "validated"} />
          {(currentDoc.provider_envelope_id || docInFlight || docFailed) && !isPromotora && <ContractEventsBlock doc={currentDoc} />}
        </div>
      )}

      {/* Histórico de versões */}
      {history.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Layers className="h-3.5 w-3.5" /> Versões anteriores ({history.length})
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <ul className="space-y-1.5 border-l border-border/60 pl-3">
              {history.map((d) => {
                const dm = CONTRACT_DOCUMENT_STATUS_META[d.status] ?? CONTRACT_DOCUMENT_STATUS_META.generated;
                const path = d.signed_file_path ?? d.rendered_file_path;
                return (
                  <li key={d.id} className="text-[11px] relative">
                    <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-border" />
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">v{d.version}</span>
                      <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", dm.cls)}>{dm.label}</Badge>
                      <span className="text-muted-foreground">{fmtDateTime(d.generated_at ?? d.created_at)}{d.template_version ? ` · template v${d.template_version}` : ""}</span>
                      {path && (
                        <button type="button" onClick={() => openPath(path, `h-${d.id}`)} disabled={opening === `h-${d.id}`} className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline disabled:opacity-60">
                          {opening === `h-${d.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />} PDF
                        </button>
                      )}
                    </p>
                    {d.cancel_reason && <p className="text-muted-foreground">Motivo: {d.cancel_reason}{d.cancelled_at ? ` · ${fmtDate(d.cancelled_at)}` : ""}</p>}
                  </li>
                );
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Enviar para assinatura (Clicksign) */}
      {currentDoc && docSendable && (
        <ContractSignatureDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          doc={currentDoc}
          intermediationCode={i.code}
          leadId={i.owner_lead_id}
        />
      )}

      {/* Cancelar envio */}
      <Dialog open={cancelOpen} onOpenChange={(o) => { if (!cancelSend.isPending) { setCancelOpen(o); if (!o) setCancelReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar envio pra assinatura — {i.code}</DialogTitle>
            <DialogDescription>
              O envelope da <strong>v{currentDoc?.version ?? "—"}</strong> é cancelado na Clicksign e os links dos convites param de funcionar.
              Quem já assinou perde a assinatura — pra enviar de novo, gere uma nova versão.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Ex.: proprietário pediu pra mudar o prazo / e-mail errado" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelOpen(false); setCancelReason(""); }} disabled={cancelSend.isPending}>Voltar</Button>
            <Button variant="destructive" onClick={confirmCancelSend} disabled={cancelSend.isPending}>
              {cancelSend.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Ban className="h-4 w-4 mr-1" />} Cancelar envio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerar */}
      <Dialog open={regenOpen} onOpenChange={(o) => { if (!generate.isPending) { setRegenOpen(o); if (!o) setRegenReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Regenerar contrato — {i.code}</DialogTitle>
            <DialogDescription>
              Vai gerar a <strong>v{nextVersion}</strong> com os dados de agora. A v{currentDoc?.version ?? "—"} fica <strong>cancelada no histórico</strong> (nada é apagado) — se ela já foi impressa, descarte a cópia.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={regenReason} onChange={(e) => setRegenReason(e.target.value)} placeholder="Ex.: corrigido o CPF do proprietário / mudou o prazo" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRegenOpen(false); setRegenReason(""); }} disabled={generate.isPending}>Cancelar</Button>
            <Button onClick={confirmRegenerate} disabled={generate.isPending}>
              {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />} Gerar v{nextVersion}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Importar assinado */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!importContract.isPending) { setImportOpen(o); if (!o) resetImport(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{currentDoc ? `Importar o PDF assinado desta versão (v${currentDoc.version})` : "Importar contrato assinado"} — {i.code}</DialogTitle>
            <DialogDescription>
              Isso <strong>formaliza a intermediação</strong> (status Formalizada), move o funil pra Preparação e gera o prêmio da promotora (pendente de aprovação). O PDF fica guardado com hash pra auditoria{currentDoc ? ` e vinculado ao contrato v${currentDoc.version}` : ""}.
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
            <Button variant="outline" onClick={() => { setImportOpen(false); resetImport(); }} disabled={importContract.isPending}>Cancelar</Button>
            <Button onClick={confirmImport} disabled={importContract.isPending || !file}>
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
  // Fase 5: encerrar uma intermediação ativa sem alçada NÃO é mais bloqueado —
  // a RPC abre um pedido de aprovação (needs_approval). Só sinalizamos isso.
  const closingNeedsApproval = i.status === "active" && !isAdmin;

  const run = async (action: IntermediationStatusAction, r?: string) => {
    try {
      const res = await setStatus.mutateAsync({ id: i.id, leadId: i.owner_lead_id, status: action, reason: r ?? null });
      if (isNeedsApproval(res)) {
        toast.info(APPROVAL_TOAST, { description: "Encerrar uma intermediação formalizada precisa de alçada." });
        setPending(null);
        setReason("");
        return;
      }
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
            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={setStatus.isPending}>
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
      {closingNeedsApproval && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><ShieldAlert className="h-3 w-3" /> Encerrar uma intermediação formalizada precisa da aprovação de uma administradora — seu pedido vai pra fila de aprovações.</p>
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
      const r = await setCommission.mutateAsync({ id: i.id, leadId: i.owner_lead_id, status });
      if (isNeedsApproval(r)) toast.info(APPROVAL_TOAST, { description: "Renunciar comissão precisa de alçada." });
      else toast.success(`Comissão: ${COMMISSION_STATUS_META[status].label}.`);
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
  if (typeof p.version === "number") parts.push(`v${p.version}${typeof p.template_version === "number" ? ` (template v${p.template_version})` : ""}`);
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

// ─── Fase 4: Fechamento (comprador e venda) ──────────────────────────────────

/** Etiqueta de forma de pagamento com detalhes (entrada, parcelas). */
function paymentSummary(p: Pick<Proposal, "payment_method" | "down_payment" | "financed_amount" | "installments">): string {
  if (!p.payment_method) return "—";
  const base = PAYMENT_METHOD_LABEL[p.payment_method];
  const extra: string[] = [];
  if (p.down_payment != null) extra.push(`entrada ${fmtBRL(p.down_payment)}`);
  if (p.financed_amount != null) extra.push(`${fmtBRL(p.financed_amount)} financiados`);
  if (p.installments != null) extra.push(`${p.installments}x`);
  return extra.length ? `${base} · ${extra.join(" · ")}` : base;
}

// ── Comprador ──

interface BuyerForm {
  name: string; cpf_cnpj: string; rg: string; address: string; address_number: string; complement: string;
  district: string; zip: string; city: string; state: string; email: string; phone: string;
}

function toBuyerForm(i: Intermediation): BuyerForm {
  const b = i.buyer_data ?? {};
  const st = pick(b.state);
  return {
    name: pick(b.name),
    cpf_cnpj: maskCpfCnpj(pick(b.cpf_cnpj)),
    rg: pick(b.rg),
    address: pick(b.address),
    address_number: pick(b.address_number),
    complement: pick(b.complement),
    district: pick(b.district),
    zip: maskCep(pick(b.zip)),
    city: pick(b.city),
    state: st.length <= 2 ? st.toUpperCase() : st,
    email: pick(b.email),
    phone: pick(b.phone),
  };
}

function BuyerSubBlock({ i, locked }: { i: Intermediation; locked: boolean }) {
  const setBuyer = useSetBuyer();
  const [f, setF] = useState<BuyerForm>(() => toBuyerForm(i));
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (!dirty) setF(toBuyerForm(i)); }, [i, dirty]);

  const set = (k: keyof BuyerForm, v: string) => { setF((prev) => ({ ...prev, [k]: v })); setDirty(true); };
  const inputCls = "h-9";

  const save = async () => {
    if (f.name.trim().length < 2) { toast.error("Informe o nome do comprador."); return; }
    const buyer: BuyerData = {
      name: f.name.trim(), cpf_cnpj: f.cpf_cnpj.trim(), rg: f.rg.trim(), address: f.address.trim(),
      address_number: f.address_number.trim(), complement: f.complement.trim(), district: f.district.trim(),
      zip: f.zip.trim(), city: f.city.trim(), state: f.state.trim(), email: f.email.trim().toLowerCase(), phone: f.phone.trim(),
    };
    try {
      await setBuyer.mutateAsync({ id: i.id, leadId: i.owner_lead_id, buyer, buyerLeadId: i.buyer_lead_id });
      setDirty(false);
      toast.success("Dados do comprador salvos.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui salvar os dados do comprador.");
    }
  };

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <p className="text-sm font-semibold flex items-center gap-1.5"><UserPlus className="h-4 w-4 text-sky-600" /> Comprador</p>
      {locked && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
          <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Termo já assinado: os dados do comprador só mudam por aditivo (admin).
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label="Nome completo *" className="sm:col-span-2"><Input className={inputCls} value={f.name} disabled={locked} placeholder="Nome e sobrenome" onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="CPF / CNPJ"><Input inputMode="numeric" className={inputCls} value={f.cpf_cnpj} disabled={locked} placeholder="000.000.000-00" onChange={(e) => set("cpf_cnpj", maskCpfCnpj(e.target.value))} /></Field>
        <Field label="RG / IE"><Input className={inputCls} value={f.rg} disabled={locked} placeholder="Ex.: 12.345.678-9" onChange={(e) => set("rg", e.target.value)} /></Field>
        <Field label="CEP"><Input inputMode="numeric" className={inputCls} value={f.zip} disabled={locked} placeholder="00000-000" onChange={(e) => set("zip", maskCep(e.target.value))} /></Field>
        <Field label="Endereço (rua/avenida)"><Input className={inputCls} value={f.address} disabled={locked} placeholder="Ex.: Rua das Flores" onChange={(e) => set("address", e.target.value)} /></Field>
        <Field label="Número"><Input className={inputCls} value={f.address_number} disabled={locked} placeholder="Ex.: 120" onChange={(e) => set("address_number", e.target.value)} /></Field>
        <Field label="Complemento"><Input className={inputCls} value={f.complement} disabled={locked} placeholder="Ex.: apto 32" onChange={(e) => set("complement", e.target.value)} /></Field>
        <Field label="Bairro"><Input className={inputCls} value={f.district} disabled={locked} placeholder="Ex.: Centro" onChange={(e) => set("district", e.target.value)} /></Field>
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <Field label="Cidade"><Input className={inputCls} value={f.city} disabled={locked} placeholder="Ex.: Barueri" onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label="UF"><Input className={cn(inputCls, "uppercase")} value={f.state} disabled={locked} placeholder="SP" maxLength={2} onChange={(e) => set("state", maskUF(e.target.value))} /></Field>
        </div>
        <Field label="E-mail"><Input type="email" className={inputCls} value={f.email} disabled={locked} placeholder="nome@email.com" onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Telefone / WhatsApp"><Input inputMode="tel" className={inputCls} value={f.phone} disabled={locked} placeholder="(11) 99999-9999" onChange={(e) => set("phone", e.target.value)} /></Field>
      </div>
      {!locked && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="text-[11px] text-muted-foreground">Alterações não salvas</span>}
          <Button size="sm" onClick={save} disabled={setBuyer.isPending}>
            {setBuyer.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />} Salvar comprador
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Proposta ──

interface ProposalForm { amount: string; payment_method: PaymentMethod | ""; down_payment: string; financed_amount: string; installments: string; notes: string; }
const EMPTY_PROPOSAL: ProposalForm = { amount: "", payment_method: "", down_payment: "", financed_amount: "", installments: "", notes: "" };

function ProposalSubBlock({ i }: { i: Intermediation }) {
  const addProposal = useAddProposal();
  const decide = useDecideProposal();
  const proposalsQ = useIntermediationProposals(i.id);
  const proposals = useMemo(() => proposalsQ.data ?? [], [proposalsQ.data]);
  const [f, setF] = useState<ProposalForm>(EMPTY_PROPOSAL);
  const [rejecting, setRejecting] = useState<Proposal | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [deciding, setDeciding] = useState<string | null>(null);

  const canAdd = i.status === "active" || i.status === "docs_pending";
  const showFinancing = f.payment_method === "financing" || f.payment_method === "mixed";
  const showInstallments = f.payment_method === "financing";

  const submit = async () => {
    const amount = parseMoney(f.amount);
    if (amount == null || amount <= 0) { toast.error("Informe o valor da proposta."); return; }
    const data: ProposalInput = {
      amount,
      ...(i.buyer_data?.name?.trim() ? { buyer_name: i.buyer_data.name.trim() } : {}),
      ...(i.buyer_lead_id ? { buyer_lead_id: i.buyer_lead_id } : {}),
      ...(f.payment_method ? { payment_method: f.payment_method } : {}),
      ...(showFinancing ? { down_payment: parseMoney(f.down_payment), financed_amount: parseMoney(f.financed_amount) } : {}),
      ...(showInstallments && onlyDigits(f.installments) ? { installments: Number(onlyDigits(f.installments)) } : {}),
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    };
    try {
      await addProposal.mutateAsync({ id: i.id, leadId: i.owner_lead_id, data });
      setF(EMPTY_PROPOSAL);
      toast.success("Proposta registrada.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui registrar a proposta.");
    }
  };

  const accept = async (p: Proposal) => {
    setDeciding(p.id);
    try {
      const r = await decide.mutateAsync({ proposalId: p.id, leadId: i.owner_lead_id, decision: "accepted" });
      if (isNeedsApproval(r)) toast.info(APPROVAL_TOAST, { description: "Aceitar abaixo do preço mínimo precisa de alçada." });
      else toast.success("Proposta aceita — venda carimbada. Agora é gerar o Termo de Compra e Venda.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui aceitar a proposta.");
    } finally {
      setDeciding(null);
    }
  };

  const confirmReject = async () => {
    if (!rejecting) return;
    if (rejectReason.trim().length < 3) { toast.error("Descreva o motivo da recusa."); return; }
    setDeciding(rejecting.id);
    try {
      await decide.mutateAsync({ proposalId: rejecting.id, leadId: i.owner_lead_id, decision: "rejected", note: rejectReason.trim() });
      toast.success("Proposta recusada.");
      setRejecting(null);
      setRejectReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui recusar a proposta.");
    } finally {
      setDeciding(null);
    }
  };

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <p className="text-sm font-semibold flex items-center gap-1.5"><Handshake className="h-4 w-4 text-violet-600" /> Proposta</p>

      {canAdd ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Valor da proposta (R$) *"><Input inputMode="decimal" className="h-9" value={f.amount} placeholder="Ex.: 82000" onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
            <Field label="Forma de pagamento">
              <Select value={f.payment_method || "__none__"} onValueChange={(v) => setF({ ...f, payment_method: v === "__none__" ? "" : (v as PaymentMethod) })}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">A definir…</SelectItem>
                  {(Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[]).map((k) => <SelectItem key={k} value={k}>{PAYMENT_METHOD_LABEL[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {showFinancing && (
              <>
                <Field label="Entrada (R$)"><Input inputMode="decimal" className="h-9" value={f.down_payment} placeholder="Ex.: 20000" onChange={(e) => setF({ ...f, down_payment: e.target.value })} /></Field>
                <Field label="Valor financiado (R$)"><Input inputMode="decimal" className="h-9" value={f.financed_amount} placeholder="Ex.: 62000" onChange={(e) => setF({ ...f, financed_amount: e.target.value })} /></Field>
              </>
            )}
            {showInstallments && (
              <Field label="Parcelas"><Input inputMode="numeric" className="h-9" value={f.installments} placeholder="Ex.: 48" maxLength={3} onChange={(e) => setF({ ...f, installments: onlyDigits(e.target.value).slice(0, 3) })} /></Field>
            )}
            <Field label="Observação" className="sm:col-span-2"><Textarea rows={2} value={f.notes} placeholder="Ex.: comprador quer test drive antes de fechar" onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={addProposal.isPending}>
              {addProposal.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <DollarSign className="h-4 w-4 mr-1" />} Registrar proposta
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Propostas só entram com a intermediação ativa.</p>
      )}

      {/* Lista de propostas */}
      {proposalsQ.isLoading ? (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Carregando propostas…</p>
      ) : proposals.length > 0 ? (
        <ul className="space-y-1.5">
          {proposals.map((p) => {
            const pm = PROPOSAL_STATUS_META[p.status] ?? PROPOSAL_STATUS_META.pending;
            const busy = deciding === p.id;
            return (
              <li key={p.id} className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-medium">{fmtBRL(p.amount)} <span className="text-muted-foreground font-normal">· {paymentSummary(p)}</span></span>
                  <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", pm.cls)}>{pm.label}</Badge>
                </div>
                <p className="text-muted-foreground">{fmtDateTime(p.created_at)}{p.buyer_name ? ` · ${p.buyer_name}` : ""}</p>
                {p.notes && <p className="text-muted-foreground">Obs.: {p.notes}</p>}
                {p.decision_note && <p className="text-muted-foreground">Motivo: {p.decision_note}</p>}
                {p.status === "pending" && canAdd && (
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => accept(p)}>
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />} Aceitar
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => setRejecting(p)}>
                      <XCircle className="h-3.5 w-3.5 mr-1" /> Recusar
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">Nenhuma proposta registrada ainda.</p>
      )}

      {/* Recusar proposta */}
      <Dialog open={!!rejecting} onOpenChange={(o) => { if (!decide.isPending && !o) { setRejecting(null); setRejectReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Recusar proposta — {i.code}</DialogTitle>
            <DialogDescription>A proposta de {rejecting ? fmtBRL(rejecting.amount) : "—"} vai pra Recusada. Fica registrada no histórico com o motivo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Ex.: proprietário achou o valor baixo" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRejecting(null); setRejectReason(""); }} disabled={decide.isPending}>Voltar</Button>
            <Button variant="destructive" onClick={confirmReject} disabled={decide.isPending}>
              {decide.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <XCircle className="h-4 w-4 mr-1" />} Recusar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Termo de Compra e Venda (SALE_CONTRACT) ──

const SALE_SOURCE_HINT: Record<string, string> = {
  buyer_data: "Comprador",
  sale: "Proposta aceita",
  "contract_data.owner": "Dados do proprietário",
  "contract_data.vehicle": "Dados do veículo",
  terms: "Condições comerciais",
  legal_entity: "Entidade jurídica (Configurações)",
};

function SaleContractSubBlock({ i, memberName }: { i: Intermediation; memberName: (id: string | null) => string | null }) {
  const { isAdmin } = useAuth();
  const snapshotQ = useContractSnapshot(i.id, "SALE_CONTRACT");
  const docsQ = useContractDocuments(i.id, "SALE_CONTRACT");
  const generate = useGenerateContract();
  const resend = useContractResend();
  const cancelSend = useContractCancel();
  const checkStatus = useContractStatus();
  const importSale = useImportSaleContract();

  const snapshot = snapshotQ.data ?? null;
  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data]);
  const currentDoc = docs.find((d) => d.id === i.sale_document_id) ?? docs.find((d) => d.status !== "cancelled" && d.status !== "archived") ?? null;

  const [importOpen, setImportOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenReason, setRegenReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [signedAt, setSignedAt] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const hasSale = i.sale_contract_status === "signed" || i.sale_contract_status === "imported";
  const closed = INTERMEDIATION_STATUS_META[i.status].closed;
  const canWork = (i.status === "active" || i.status === "docs_pending") && !closed;
  const missing = snapshot?.missing ?? [];
  const ready = snapshot?.ready === true;
  const nextVersion = snapshot?.next_version ?? (docs[0]?.version ?? 0) + 1;
  const canGenerate = !hasSale && canWork;
  const canRegenerate = canGenerate && !!currentDoc && LIVE_DOC_STATUSES.includes(currentDoc.status);
  const history = docs.filter((d) => d.id !== currentDoc?.id);

  const docSendable = !!currentDoc && CONTRACT_SENDABLE_STATUSES.includes(currentDoc.status);
  const docInFlight = !!currentDoc && CONTRACT_IN_FLIGHT_STATUSES.includes(currentDoc.status);
  const docFailed = !!currentDoc && CONTRACT_FAILED_STATUSES.includes(currentDoc.status);
  const canSend = canGenerate && docSendable;
  const signatureBusy = resend.isPending || cancelSend.isPending || checkStatus.isPending;
  const deadline = currentDoc && docInFlight ? deadlineText(currentDoc.deadline_at) : null;

  const meta = SALE_CONTRACT_STATUS_META[i.sale_contract_status] ?? SALE_CONTRACT_STATUS_META.none;
  const badgeLabel = i.sale_contract_status === "generated" && currentDoc ? `Gerado v${currentDoc.version} · aguardando envio` : meta.label;

  const resetImport = () => { setFile(null); setSignedAt(todayISO()); setReason(""); };

  const openPath = async (path: string, key: string) => {
    setOpening(key);
    try {
      await openPdfTab(() => getContractSignedUrl(path, 600));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui abrir o PDF.");
    } finally {
      setOpening(null);
    }
  };

  const preview = async () => {
    setPreviewing(true);
    try {
      await openContractPreview(i.id, "SALE_CONTRACT");
    } catch (e) {
      renderErrorToast(e, "Não consegui montar a pré-visualização.");
    } finally {
      setPreviewing(false);
    }
  };

  const runGenerate = async (why?: string) => {
    const win = window.open("about:blank", "_blank");
    if (win) win.opener = null;
    try {
      const r = await generate.mutateAsync({ id: i.id, leadId: i.owner_lead_id, reason: why ?? null, documentType: "SALE_CONTRACT" });
      toast.success(`Termo de Compra e Venda v${r.document.version} gerado.`);
      let url = r.signed_url;
      if (!url && r.document.rendered_file_path) url = await getContractSignedUrl(r.document.rendered_file_path, 600).catch(() => null);
      if (url) { if (win) win.location.href = url; else window.open(url, "_blank", "noopener"); }
      else win?.close();
      setRegenOpen(false);
      setRegenReason("");
    } catch (e) {
      win?.close();
      renderErrorToast(e, "Não consegui gerar o termo.");
    }
  };

  const confirmRegenerate = () => {
    if (regenReason.trim().length < 3) { toast.error("Descreva o motivo da nova versão."); return; }
    void runGenerate(regenReason.trim());
  };

  const runResend = async () => {
    if (!currentDoc) return;
    try {
      await resend.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id });
      toast.success("Convites reenviados pelos canais escolhidos.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui reenviar os convites.");
    }
  };

  const runCheck = async () => {
    if (!currentDoc) return;
    try {
      const r = await checkStatus.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id });
      if (r.finalized) toast.success(`Termo v${currentDoc.version} assinado e conferido.`);
      else if (r.applied > 0) toast.success(`Status atualizado (${r.applied} ${r.applied === 1 ? "evento novo" : "eventos novos"}).`);
      else {
        const st = r.document ? CONTRACT_DOCUMENT_STATUS_META[r.document.status]?.label ?? r.document.status : null;
        toast.info(st ? `Sem novidades — ${st.toLowerCase()}.` : "Sem novidades por enquanto.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui consultar o status da assinatura.");
    }
  };

  const confirmCancelSend = async () => {
    if (!currentDoc) return;
    if (cancelReason.trim().length < 3) { toast.error("Descreva o motivo do cancelamento."); return; }
    try {
      await cancelSend.mutateAsync({ documentId: currentDoc.id, leadId: i.owner_lead_id, reason: cancelReason.trim() });
      toast.success(`Envio da v${currentDoc.version} cancelado. Gere uma nova versão quando quiser enviar de novo.`);
      setCancelOpen(false);
      setCancelReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui cancelar o envio.");
    }
  };

  const confirmImport = async () => {
    if (!file) { toast.error("Escolha o PDF do termo assinado."); return; }
    if (reason.trim().length < 3) { toast.error("Descreva o motivo/origem (ex.: assinado em papel na loja)."); return; }
    try {
      const r = await importSale.mutateAsync({
        id: i.id, leadId: i.owner_lead_id, file, signedAt, reason,
        documentId: currentDoc?.id ?? i.sale_document_id ?? null,
      });
      if (r.already) toast.info(`${r.code ?? i.code}: termo já estava assinado.`);
      else toast.success("Termo de Compra e Venda importado e assinado.");
      setImportOpen(false);
      resetImport();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui importar o termo.");
    }
  };

  const docMeta = currentDoc ? CONTRACT_DOCUMENT_STATUS_META[currentDoc.status] ?? CONTRACT_DOCUMENT_STATUS_META.generated : null;
  const generatedBy = currentDoc ? memberName(currentDoc.generated_by) : null;
  const primaryHash = currentDoc?.signed_sha256 ?? currentDoc?.rendered_sha256 ?? null;

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><FileSignature className="h-4 w-4 text-emerald-600" /> Termo de Compra e Venda</p>
        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{badgeLabel}</Badge>
      </div>

      {/* Assinado/importado: resumo */}
      {hasSale && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          <p>
            Assinado em <strong className="text-foreground">{fmtDate(i.sale_signed_at)}</strong>
            {i.sale_contract_status === "signed" ? " · assinatura eletrônica" : i.sale_contract_status === "imported" ? " · importado (papel)" : null}
          </p>
          {currentDoc?.signed_sha256 && <p>Hash SHA-256: <code className="text-[11px]">{currentDoc.signed_sha256.slice(0, 12)}…</code></p>}
          {currentDoc?.signed_file_path && (
            <button type="button" onClick={() => openPath(currentDoc.signed_file_path!, "sale-signed")} disabled={opening === "sale-signed"} className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-60">
              {opening === "sale-signed" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF assinado
            </button>
          )}
        </div>
      )}

      {/* Checklist do snapshot */}
      {!hasSale && (
        snapshotQ.isLoading && !snapshot ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Conferindo o que falta pro termo…</p>
        ) : snapshot && missing.length > 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 p-2.5">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> Falta pra gerar o termo ({missing.length}):</p>
            <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5">
              {missing.map((m) => (
                <li key={m.key} className="text-[11px]">
                  {m.source === "legal_entity" ? (
                    <a href="/configuracoes?s=intermediacao" className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200 hover:underline">
                      <Settings2 className="h-3 w-3 shrink-0" /> {m.label} <span className="text-muted-foreground">· Configurações › Intermediação</span>
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-900 dark:text-amber-200">
                      <ChevronRight className="h-3 w-3 shrink-0" /> {m.label} <span className="text-muted-foreground">· {SALE_SOURCE_HINT[m.source] ?? m.source}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : snapshot && !snapshot.template ? (
          <p className="text-xs rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Nenhum template de Termo de Compra e Venda vigente. Peça pra publicar um em <a href="/configuracoes?s=intermediacao" className="underline">Configurações › Intermediação</a>.
          </p>
        ) : snapshot ? (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Tudo preenchido — template "{snapshot.template!.name}" v{snapshot.template!.version}{snapshot.template!.global ? " (Totex)" : ""}.
          </p>
        ) : null
      )}

      {/* Ações */}
      {!hasSale && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={preview} disabled={previewing}>
            {previewing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Eye className="h-4 w-4 mr-1" />} Pré-visualizar
          </Button>
          {docInFlight ? null : !currentDoc || !LIVE_DOC_STATUSES.includes(currentDoc.status) ? (
            <Button size="sm" variant={docFailed ? "outline" : "default"} disabled={!ready || !canGenerate || generate.isPending} onClick={() => runGenerate()} title={!ready ? "Preencha o que falta antes de gerar" : undefined}>
              {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileText className="h-4 w-4 mr-1" />} Gerar Termo v{nextVersion}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!ready || !canRegenerate || generate.isPending} onClick={() => setRegenOpen(true)}>
              <RefreshCw className="h-4 w-4 mr-1" /> Regenerar
            </Button>
          )}
          {docSendable && currentDoc && (
            <Button size="sm" disabled={!canSend || generate.isPending} onClick={() => setSendOpen(true)}>
              <Send className="h-4 w-4 mr-1" /> {currentDoc.status === "error" ? "Enviar novamente" : "Enviar para assinatura"}
            </Button>
          )}
          {docInFlight && currentDoc && (
            <>
              {currentDoc.status !== "completed" && (
                <Button size="sm" variant="outline" disabled={signatureBusy} onClick={runResend}>
                  {resend.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />} Reenviar convites
                </Button>
              )}
              <Button size="sm" variant={currentDoc.status === "completed" ? "default" : "outline"} disabled={signatureBusy} onClick={runCheck}>
                {checkStatus.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />} Verificar agora
              </Button>
              {currentDoc.status !== "completed" && (
                <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={signatureBusy} onClick={() => setCancelOpen(true)}>
                  <Ban className="h-4 w-4 mr-1" /> Cancelar envio
                </Button>
              )}
            </>
          )}
          {canWork && (
            isAdmin ? (
              <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)}>
                <Upload className="h-4 w-4 mr-1" /> {currentDoc ? `Importar assinado em papel (v${currentDoc.version})` : "Importar termo assinado (PDF)"}
              </Button>
            ) : (
              !docInFlight && <span className="text-[11px] text-muted-foreground">Se for assinado em papel, o admin importa o PDF aqui.</span>
            )
          )}
        </div>
      )}
      {!hasSale && docInFlight && currentDoc && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1">
          <Info className="h-3 w-3 shrink-0 mt-0.5" />
          {currentDoc.status === "completed"
            ? "Todos assinaram. Estamos baixando e conferindo o PDF assinado — clique em \"Verificar agora\" pra concluir na hora."
            : "Enquanto o envio estiver em andamento não dá pra gerar outra versão. Pra alterar o termo, cancele o envio primeiro."}
        </p>
      )}

      {/* Documento atual */}
      {currentDoc && docMeta && (
        <div className="rounded-md border border-border/60 bg-muted/30 p-2.5 text-xs space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <p className="font-medium flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 text-sky-600" /> Termo v{currentDoc.version}
              <span className="text-muted-foreground font-normal">· template v{currentDoc.template_version ?? "—"}</span>
            </p>
            <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", docMeta.cls)}>{docMeta.label}</Badge>
          </div>
          <p className="text-muted-foreground">
            {currentDoc.generated_at ? `Gerado em ${fmtDateTime(currentDoc.generated_at)}` : `Registrado em ${fmtDateTime(currentDoc.created_at)}`}
            {generatedBy ? ` por ${generatedBy}` : ""}
            {primaryHash ? <> · hash <code className="text-[11px]">{primaryHash.slice(0, 12)}…</code></> : null}
          </p>
          <div className="flex flex-wrap gap-3">
            {currentDoc.rendered_file_path && (
              <button type="button" onClick={() => openPath(currentDoc.rendered_file_path!, "sale-cur-rendered")} disabled={opening === "sale-cur-rendered"} className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline disabled:opacity-60">
                {opening === "sale-cur-rendered" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF
              </button>
            )}
            {currentDoc.signed_file_path && (
              <button type="button" onClick={() => openPath(currentDoc.signed_file_path!, "sale-cur-signed")} disabled={opening === "sale-cur-signed"} className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-60">
                {opening === "sale-cur-signed" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />} Abrir PDF assinado
              </button>
            )}
          </div>
          {docInFlight && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
              {currentDoc.sent_at && <span>Enviado em {fmtDateTime(currentDoc.sent_at)}</span>}
              {deadline && <span className={cn("inline-flex items-center gap-1", deadline.overdue && "text-red-700 dark:text-red-300")}><CalendarClock className="h-3 w-3" /> {deadline.text}</span>}
              {currentDoc.last_event_at && <span>Última atualização {fmtDateTime(currentDoc.last_event_at)}</span>}
            </div>
          )}
          {docFailed && (
            <p className={cn("flex items-start gap-1", currentDoc.status === "cancelled" ? "text-muted-foreground" : "text-red-700 dark:text-red-300")}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                {currentDoc.status === "error"
                  ? `Erro no envio: ${currentDoc.error_message ?? "sem detalhes"}`
                  : `${CONTRACT_DOCUMENT_STATUS_META[currentDoc.status].label}${currentDoc.cancel_reason ? `: ${currentDoc.cancel_reason}` : ""}${currentDoc.cancelled_at ? ` · ${fmtDateTime(currentDoc.cancelled_at)}` : ""}`}
                {currentDoc.status !== "error" ? " — gere uma nova versão pra enviar de novo." : null}
              </span>
            </p>
          )}
          <DocumentSigners doc={currentDoc} inFlight={docInFlight || docFailed || currentDoc.status === "validated"} />
          {(currentDoc.provider_envelope_id || docInFlight || docFailed) && <ContractEventsBlock doc={currentDoc} />}
        </div>
      )}

      {/* Histórico de versões */}
      {history.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
              {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              <Layers className="h-3.5 w-3.5" /> Versões anteriores ({history.length})
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            <ul className="space-y-1.5 border-l border-border/60 pl-3">
              {history.map((d) => {
                const dm = CONTRACT_DOCUMENT_STATUS_META[d.status] ?? CONTRACT_DOCUMENT_STATUS_META.generated;
                const path = d.signed_file_path ?? d.rendered_file_path;
                return (
                  <li key={d.id} className="text-[11px] relative">
                    <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-border" />
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">v{d.version}</span>
                      <Badge variant="outline" className={cn("border text-[10px] px-1.5 py-0", dm.cls)}>{dm.label}</Badge>
                      <span className="text-muted-foreground">{fmtDateTime(d.generated_at ?? d.created_at)}{d.template_version ? ` · template v${d.template_version}` : ""}</span>
                      {path && (
                        <button type="button" onClick={() => openPath(path, `sale-h-${d.id}`)} disabled={opening === `sale-h-${d.id}`} className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline disabled:opacity-60">
                          {opening === `sale-h-${d.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ExternalLink className="h-3 w-3" />} PDF
                        </button>
                      )}
                    </p>
                    {d.cancel_reason && <p className="text-muted-foreground">Motivo: {d.cancel_reason}{d.cancelled_at ? ` · ${fmtDate(d.cancelled_at)}` : ""}</p>}
                  </li>
                );
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Enviar para assinatura (Clicksign) */}
      {currentDoc && docSendable && (
        <ContractSignatureDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          doc={currentDoc}
          intermediationCode={i.code}
          leadId={i.owner_lead_id}
        />
      )}

      {/* Cancelar envio */}
      <Dialog open={cancelOpen} onOpenChange={(o) => { if (!cancelSend.isPending) { setCancelOpen(o); if (!o) setCancelReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar envio pra assinatura — {i.code}</DialogTitle>
            <DialogDescription>
              O envelope da <strong>v{currentDoc?.version ?? "—"}</strong> é cancelado na Clicksign e os links dos convites param de funcionar.
              Quem já assinou perde a assinatura — pra enviar de novo, gere uma nova versão.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Ex.: comprador pediu pra mudar a forma de pagamento" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCancelOpen(false); setCancelReason(""); }} disabled={cancelSend.isPending}>Voltar</Button>
            <Button variant="destructive" onClick={confirmCancelSend} disabled={cancelSend.isPending}>
              {cancelSend.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Ban className="h-4 w-4 mr-1" />} Cancelar envio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Regenerar */}
      <Dialog open={regenOpen} onOpenChange={(o) => { if (!generate.isPending) { setRegenOpen(o); if (!o) setRegenReason(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Regenerar termo — {i.code}</DialogTitle>
            <DialogDescription>
              Vai gerar a <strong>v{nextVersion}</strong> com os dados de agora. A v{currentDoc?.version ?? "—"} fica <strong>cancelada no histórico</strong> (nada é apagado).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Motivo *</Label>
            <Textarea rows={2} value={regenReason} onChange={(e) => setRegenReason(e.target.value)} placeholder="Ex.: corrigido o CPF do comprador / mudou a forma de pagamento" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRegenOpen(false); setRegenReason(""); }} disabled={generate.isPending}>Cancelar</Button>
            <Button onClick={confirmRegenerate} disabled={generate.isPending}>
              {generate.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />} Gerar v{nextVersion}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Importar assinado */}
      <Dialog open={importOpen} onOpenChange={(o) => { if (!importSale.isPending) { setImportOpen(o); if (!o) resetImport(); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{currentDoc ? `Importar o PDF assinado desta versão (v${currentDoc.version})` : "Importar termo assinado"} — {i.code}</DialogTitle>
            <DialogDescription>
              Isso marca o <strong>Termo de Compra e Venda como assinado</strong>. O PDF fica guardado com hash pra auditoria{currentDoc ? ` e vinculado ao termo v${currentDoc.version}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">PDF do termo assinado *</Label>
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
            <Button variant="outline" onClick={() => { setImportOpen(false); resetImport(); }} disabled={importSale.isPending}>Cancelar</Button>
            <Button onClick={confirmImport} disabled={importSale.isPending || !file}>
              {importSale.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <FileSignature className="h-4 w-4 mr-1" />} Marcar assinado
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Pagamento ──

function PaymentSubBlock({ i }: { i: Intermediation }) {
  const confirmPayment = useConfirmPayment();
  const [amount, setAmount] = useState(() => moneyToInput(i.sale_price));
  const [note, setNote] = useState("");
  const [partial, setPartial] = useState(false);

  const meta = PAYMENT_STATUS_META[i.payment_status] ?? PAYMENT_STATUS_META.pending;
  const satisfied = i.payment_status === "satisfied";

  const submit = async () => {
    const amt = parseMoney(amount);
    if (amt == null || amt <= 0) { toast.error("Informe o valor recebido."); return; }
    try {
      const r = await confirmPayment.mutateAsync({ id: i.id, leadId: i.owner_lead_id, amount: amt, note: note.trim() || null, full: !partial });
      toast.success(r.payment_status === "satisfied" ? "Pagamento confirmado." : "Pagamento parcial registrado.");
      setNote("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui confirmar o pagamento.");
    }
  };

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold flex items-center gap-1.5"><Wallet className="h-4 w-4 text-emerald-600" /> Pagamento</p>
        <Badge variant="outline" className={cn("border text-[11px]", meta.cls)}>{meta.label}</Badge>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <div><p className="text-muted-foreground">Valor da venda</p><p className="font-medium">{fmtBRL(i.sale_price)}</p></div>
        <div><p className="text-muted-foreground">Recebido</p><p className="font-medium">{fmtBRL(i.paid_amount)}</p></div>
        <div><p className="text-muted-foreground">Confirmado em</p><p className="font-medium">{fmtDate(i.payment_confirmed_at)}</p></div>
      </div>
      {i.payment_note && <p className="text-[11px] text-muted-foreground">Obs.: {i.payment_note}</p>}

      {!satisfied && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Valor recebido (R$) *"><Input inputMode="decimal" className="h-9" value={amount} placeholder="Ex.: 82000" onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Observação"><Input className="h-9" value={note} placeholder="Ex.: PIX confirmado / entrada + financiamento aprovado" onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <label className="flex items-center justify-between rounded-md border border-input px-3 h-9 text-xs max-w-xs">
            Pagamento parcial (ainda falta receber)
            <Switch checked={partial} onCheckedChange={setPartial} />
          </label>
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={confirmPayment.isPending}>
              {confirmPayment.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <BadgeCheck className="h-4 w-4 mr-1" />} {partial ? "Registrar pagamento parcial" : "Confirmar pagamento"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Concluir venda ──

function ConcludeSubBlock({ i }: { i: Intermediation }) {
  const conclude = useConcludeSale();
  const saleSigned = i.sale_contract_status === "signed" || i.sale_contract_status === "imported";
  const paid = i.payment_status === "satisfied";
  const completed = i.status === "completed";

  const blockers: string[] = [];
  if (!saleSigned) blockers.push("termo assinado");
  if (!paid) blockers.push("confirmar pagamento");

  const run = async () => {
    try {
      const r = await conclude.mutateAsync({ id: i.id, leadId: i.owner_lead_id });
      toast.success(r.already ? "Venda já estava concluída." : "Venda concluída! Carro vendido e prêmio de R$ 50 gerado.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui concluir a venda.");
    }
  };

  if (completed) {
    return (
      <div className="rounded-md border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30 p-3 space-y-1">
        <p className="text-sm font-semibold flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300"><Trophy className="h-4 w-4" /> Venda concluída</p>
        <p className="text-xs text-muted-foreground">Vendido por <strong className="text-foreground">{fmtBRL(i.sale_price)}</strong>{i.delivered_at ? ` · entregue em ${fmtDate(i.delivered_at)}` : ""}.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border/60 p-3 space-y-2">
      <p className="text-sm font-semibold flex items-center gap-1.5"><Trophy className="h-4 w-4 text-emerald-600" /> Concluir venda</p>
      {blockers.length > 0 ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> Falta: {blockers.join(" · ")}.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">Termo assinado e pagamento confirmado. Ao concluir, o carro é marcado como vendido e o prêmio de R$ 50 é gerado.</p>
      )}
      <div className="flex justify-end">
        <Button size="sm" disabled={blockers.length > 0 || i.status !== "active" || conclude.isPending} onClick={run}>
          {conclude.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trophy className="h-4 w-4 mr-1" />} Concluir venda
        </Button>
      </div>
    </div>
  );
}

// ── Container ──

function ClosingBlock({ i, memberName }: { i: Intermediation; memberName: (id: string | null) => string | null }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(i.status === "active" || i.status === "docs_pending");

  const saleSigned = i.sale_contract_status === "signed" || i.sale_contract_status === "imported";
  const buyerLocked = saleSigned && !isAdmin;
  const saleMeta = SALE_CONTRACT_STATUS_META[i.sale_contract_status] ?? SALE_CONTRACT_STATUS_META.none;
  const payMeta = PAYMENT_STATUS_META[i.payment_status] ?? PAYMENT_STATUS_META.pending;

  return (
    <div className="rounded-md border border-sky-200/70 dark:border-sky-900/60 p-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="text-sm font-semibold flex items-center gap-1.5 hover:text-foreground">
              {open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
              <Handshake className="h-4 w-4 text-sky-600" /> Fechamento (comprador e venda)
            </button>
          </CollapsibleTrigger>
          <div className="flex flex-wrap items-center gap-1.5">
            {i.sale_contract_status !== "none" && <Badge variant="outline" className={cn("border text-[11px]", saleMeta.cls)}>Termo: {saleMeta.label}</Badge>}
            <Badge variant="outline" className={cn("border text-[11px]", payMeta.cls)}>Pagto: {payMeta.label}</Badge>
          </div>
        </div>
        <CollapsibleContent className="pt-3 space-y-3">
          <BuyerSubBlock i={i} locked={buyerLocked} />
          <ProposalSubBlock i={i} />
          {i.sale_price != null && <SaleContractSubBlock i={i} memberName={memberName} />}
          {saleSigned && <PaymentSubBlock i={i} />}
          <ConcludeSubBlock i={i} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ─── Fase 5: Exceções (alçadas) — alterar/renunciar comissão + concessão ─────

function ExceptionsBlock({ i }: { i: Intermediation }) {
  const changeCommission = useChangeCommission();
  const waive = useWaiveCommission();
  const concession = useRequestConcession();
  const pendingQ = useApprovalRequests("pending");
  const pending = useMemo(
    () => (pendingQ.data ?? []).filter((r) => r.intermediation_id === i.id),
    [pendingQ.data, i.id],
  );

  const [comType, setComType] = useState<CommissionType | "">(i.commission_type ?? "");
  const [comValue, setComValue] = useState(() => moneyToInput(i.commission_value));
  const [comReason, setComReason] = useState("");
  const [concAmount, setConcAmount] = useState("");
  const [concDesc, setConcDesc] = useState("");
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveAmount, setWaiveAmount] = useState(() => moneyToInput(i.commission_due));

  const alreadyWaived = i.commission_status === "waived";
  const concessions = i.financial_concessions ?? [];

  const submitChange = async () => {
    if (!comType) { toast.error("Escolha o tipo de comissão."); return; }
    const value = parseMoney(comValue);
    if (value == null || value < 0) { toast.error("Informe o valor da comissão."); return; }
    if (comType === "percent" && (value <= 0 || value > 30)) { toast.error("Comissão em % precisa ficar entre 0 e 30."); return; }
    try {
      const r = await changeCommission.mutateAsync({ id: i.id, leadId: i.owner_lead_id, type: comType, value, reason: comReason.trim() || null });
      if (isNeedsApproval(r)) toast.info(APPROVAL_TOAST, { description: "Alterar a comissão precisa de alçada." });
      else toast.success("Comissão alterada.");
      setComReason("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui alterar a comissão.");
    }
  };

  const confirmWaive = async () => {
    const amount = parseMoney(waiveAmount);
    try {
      const r = await waive.mutateAsync({ id: i.id, leadId: i.owner_lead_id, amount });
      if (isNeedsApproval(r)) toast.info(APPROVAL_TOAST, { description: "Renunciar comissão precisa de alçada." });
      else toast.success("Comissão renunciada.");
      setWaiveOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui renunciar a comissão.");
    }
  };

  const submitConcession = async () => {
    const amount = parseMoney(concAmount);
    if (amount == null || amount <= 0) { toast.error("Informe o valor da concessão."); return; }
    if (concDesc.trim().length < 3) { toast.error("Descreva a concessão."); return; }
    try {
      const r = await concession.mutateAsync({ id: i.id, leadId: i.owner_lead_id, amount, description: concDesc.trim() });
      if (isNeedsApproval(r)) toast.info(APPROVAL_TOAST, { description: "Concessão financeira precisa de alçada." });
      else toast.success("Concessão financeira registrada.");
      setConcAmount("");
      setConcDesc("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui registrar a concessão.");
    }
  };

  return (
    <div className="rounded-md border border-violet-200/70 dark:border-violet-900/60 p-3 space-y-3">
      <p className="text-sm font-semibold flex items-center gap-1.5"><ShieldAlert className="h-4 w-4 text-violet-600" /> Exceções (alçadas)</p>

      {pending.length > 0 && (
        <a href="/comercial/aprovacoes" className="flex items-center gap-1.5 text-[11px] rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 px-2.5 py-1.5 hover:underline">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {pending.length} {pending.length === 1 ? "aprovação pendente" : "aprovações pendentes"} nesta intermediação — abrir a fila
        </a>
      )}

      {/* Alterar comissão */}
      <div className="rounded-md border border-border/60 p-2.5 space-y-2">
        <p className="text-xs font-medium flex items-center gap-1.5"><Coins className="h-3.5 w-3.5 text-sky-600" /> Alterar comissão</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex gap-2">
            <Select value={comType || "__none__"} onValueChange={(v) => setComType(v === "__none__" ? "" : (v as CommissionType))}>
              <SelectTrigger className="h-9 w-[150px] shrink-0"><SelectValue placeholder="Tipo" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Tipo…</SelectItem>
                <SelectItem value="fixed">Fixa (R$)</SelectItem>
                <SelectItem value="percent">Percentual (%)</SelectItem>
              </SelectContent>
            </Select>
            <Input inputMode="decimal" className="h-9" placeholder={comType === "percent" ? "Ex.: 5" : "Ex.: 3000"} value={comValue} disabled={!comType} onChange={(e) => setComValue(e.target.value)} />
          </div>
          <Input className="h-9" placeholder="Motivo (opcional)" value={comReason} onChange={(e) => setComReason(e.target.value)} />
        </div>
        <div className="flex justify-end">
          <Button size="sm" className="h-8 text-xs" onClick={submitChange} disabled={changeCommission.isPending}>
            {changeCommission.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />} Alterar comissão
          </Button>
        </div>
      </div>

      {/* Renunciar comissão */}
      <div className="rounded-md border border-border/60 p-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs">
          <p className="font-medium flex items-center gap-1.5"><Scale className="h-3.5 w-3.5 text-violet-600" /> Renunciar comissão</p>
          <p className="text-[11px] text-muted-foreground">{alreadyWaived ? "Comissão já dispensada." : `A empresa abre mão da comissão apurada (${fmtBRL(i.commission_due)}).`}</p>
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={alreadyWaived || waive.isPending} onClick={() => { setWaiveAmount(moneyToInput(i.commission_due)); setWaiveOpen(true); }}>
          <Ban className="h-3.5 w-3.5 mr-1" /> Renunciar
        </Button>
      </div>

      {/* Concessão financeira */}
      <div className="rounded-md border border-border/60 p-2.5 space-y-2">
        <p className="text-xs font-medium flex items-center gap-1.5"><Gift className="h-3.5 w-3.5 text-emerald-600" /> Concessão financeira</p>
        <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2">
          <Input inputMode="decimal" className="h-9" placeholder="Valor (R$)" value={concAmount} onChange={(e) => setConcAmount(e.target.value)} />
          <Input className="h-9" placeholder="Descrição (ex.: desconto na transferência)" value={concDesc} onChange={(e) => setConcDesc(e.target.value)} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">{concessions.length > 0 ? `Total concedido: ${fmtBRL(i.concession_total)}` : ""}</span>
          <Button size="sm" className="h-8 text-xs" onClick={submitConcession} disabled={concession.isPending}>
            {concession.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <DollarSign className="h-3.5 w-3.5 mr-1" />} Registrar concessão
          </Button>
        </div>
        {concessions.length > 0 && (
          <ul className="space-y-1 pt-1 border-t border-border/60">
            {concessions.map((c, idx) => (
              <li key={idx} className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                <span className="font-medium text-foreground">{fmtBRL(c.amount)}</span>
                <span>{c.description}</span>
                {c.at ? <span>· {fmtDate(c.at)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Confirmar renúncia */}
      <Dialog open={waiveOpen} onOpenChange={(o) => { if (!waive.isPending) setWaiveOpen(o); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Renunciar comissão — {i.code}</DialogTitle>
            <DialogDescription>
              A empresa abre mão da comissão desta intermediação. Sem alçada, o pedido vai pra aprovação de uma administradora.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Valor renunciado (R$)</Label>
            <Input inputMode="decimal" className="h-9" value={waiveAmount} onChange={(e) => setWaiveAmount(e.target.value)} placeholder="Ex.: 3000" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWaiveOpen(false)} disabled={waive.isPending}>Cancelar</Button>
            <Button variant="destructive" onClick={confirmWaive} disabled={waive.isPending}>
              {waive.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Ban className="h-4 w-4 mr-1" />} Renunciar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

export function IntermediationCard({ leadId }: Props) {
  const { isPromotora } = useAuth();
  const q = useIntermediationByLead(leadId);
  const { data: members = [] } = useAllTeamMembers();
  const { data: legalEntities = [] } = useLegalEntities();
  const { data: powers = [] } = usePowersOfAttorney();
  const { data: leadData } = useSalesLead(leadId);
  const lead = (leadData ?? null) as LeadContractFields | null;

  const memberName = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((x) => m.set(x.id, x.name));
    return (id: string | null) => (id ? m.get(id) ?? null : null);
  }, [members]);

  // Veículo da intermediação (ou o último do lead) — pré-preenche "Dados do contrato" e
  // avisa "vai gerar tarefa pra retirar o anúncio" ao pausar/encerrar.
  const intermediationId = q.data?.id ?? null;
  const vehicleId = q.data?.vehicle_id ?? null;
  const vehicleQ = useQuery({
    queryKey: ["intermediation", "vehicle", vehicleId ?? "", leadId],
    enabled: !!intermediationId,
    queryFn: async () => {
      const cols = "id, description, brand, model, version, year_model, km, color, fuel, plate, renavam, chassis, condition_notes, listing_url, listing_missing_since";
      const { data, error } = vehicleId
        ? await supabase.from("seller_vehicles").select(cols).eq("id", vehicleId).maybeSingle()
        : await supabase.from("seller_vehicles").select(cols).eq("lead_id", leadId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return (data as VehicleContractFields | null) ?? null;
    },
    staleTime: 30_000,
  });
  const vehicle = vehicleQ.data ?? null;
  const vehicleListed = !!vehicle?.listing_url && !vehicle?.listing_missing_since;

  // Fase 2: o que falta pro contrato + versões geradas (promotora não tem acesso à RPC)
  const snapshotQ = useContractSnapshot(isPromotora ? null : intermediationId);
  const docsQ = useContractDocuments(isPromotora ? null : intermediationId, "INTERMEDIATION_CONTRACT");
  const docs = useMemo(() => docsQ.data ?? [], [docsQ.data]);
  const snapshot = snapshotQ.data ?? null;
  const contractDataMissing = useMemo(
    () => (snapshot?.missing ?? []).filter((m) => m.source === "contract_data.owner" || m.source === "contract_data.vehicle"),
    [snapshot],
  );

  // "Dados do contrato" abre sozinho enquanto faltar algo (o usuário pode fechar)
  const [dataOpen, setDataOpen] = useState(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpened.current && snapshot) {
      autoOpened.current = true;
      if (contractDataMissing.length > 0) setDataOpen(true);
    }
  }, [snapshot, contractDataMissing.length]);

  const termsRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<HTMLDivElement>(null);
  const jumpTo = (source: ContractMissingSource) => {
    if (source === "terms") {
      termsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (source === "contract_data.owner" || source === "contract_data.vehicle") {
      setDataOpen(true);
      window.setTimeout(() => dataRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    }
  };

  if (q.isLoading || q.isError || !q.data) return null;
  const i = q.data;

  const statusMeta = INTERMEDIATION_STATUS_META[i.status] ?? INTERMEDIATION_STATUS_META.lead;
  const contractMeta = CONTRACT_STATUS_META[i.contract_status] ?? CONTRACT_STATUS_META.none;
  const currentDoc =
    docs.find((d) => d.id === i.contract_document_id) ?? docs.find((d) => d.status !== "cancelled" && d.status !== "archived") ?? null;
  const contractBadgeLabel = i.contract_status === "generated" && currentDoc ? `Gerado v${currentDoc.version} · aguardando envio` : contractMeta.label;
  const promoterName = memberName(i.promoter_id);
  const entity = legalEntities.find((e) => e.id === (i.legal_entity_id ?? snapshot?.legal_entity_id)) ?? null;
  const canEdit = !isPromotora;

  // Fase 5: procuração padrão que assina por esta intermediação (autoridade).
  const leId = i.legal_entity_id ?? snapshot?.legal_entity_id ?? null;
  const activePowers = powers.filter((p) => p.status === "active");
  const authority =
    activePowers.find((p) => p.is_default && p.legal_entity_id === leId) ??
    activePowers.find((p) => p.is_default && p.legal_entity_id == null) ??
    null;

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
              {!isPromotora && authority && (
                <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Assina: <strong>{authority.signer_name}</strong> ({POA_ROLE[authority.signer_role]})</span>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={cn("border text-[11px]", statusMeta.cls)}>{statusMeta.label}</Badge>
            <Badge variant="outline" className={cn("border text-[11px]", contractMeta.cls)}>{contractBadgeLabel}</Badge>
            {deadlineBadge}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div ref={termsRef} className="scroll-mt-24">
          <TermsBlock i={i} canEdit={canEdit} />
        </div>
        {!isPromotora && (
          <ContractDataBlock
            i={i}
            lead={lead}
            vehicle={vehicle}
            open={dataOpen}
            onOpenChange={setDataOpen}
            canEdit={canEdit}
            missing={contractDataMissing}
            sectionRef={dataRef}
          />
        )}
        <ContractBlock
          i={i}
          memberName={memberName}
          snapshot={snapshot}
          snapshotLoading={snapshotQ.isLoading}
          docs={docs}
          currentDoc={currentDoc}
          onJump={jumpTo}
        />

        {!isPromotora && (i.status === "active" || i.status === "docs_pending" || i.status === "completed") && (
          <ClosingBlock i={i} memberName={memberName} />
        )}

        {!isPromotora && (i.status === "active" || i.status === "docs_pending" || i.status === "completed") && (
          <ExceptionsBlock i={i} />
        )}

        {i.status === "completed" && <CommissionBlock i={i} />}

        <StateBlock i={i} vehicleListed={vehicleListed} />

        <TimelineBlock intermediationId={i.id} memberName={memberName} />
      </CardContent>
    </Card>
  );
}
