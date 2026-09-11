import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Car, Check, AlertTriangle, Loader2, Ban } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useSetSellerVehicleStatus, useInvalidateCaptureLead } from "@/hooks/useCaptureRewardEngine";
import { VEHICLE_STATUS_META, type CaptureVehicleStatus } from "@/types/capture";

/**
 * Card "Captação" no detalhe do lead (aba Comercial) — SÓ aparece quando o
 * lead foi captado por uma promotora (leads.captured_by_member_id).
 *
 * Mostra quem captou, se conta na meta (leads.capture_valid), o veículo
 * (seller_vehicles mais recente) e deixa o time comercial mover a jornada do
 * carro via RPC set_seller_vehicle_status (Captado → bônus de captação;
 * Vendido → bônus de venda — dinheiro nasce SÓ no servidor). Admin pode
 * invalidar o lead (capture_invalidate_lead). Promotora só lê.
 */

interface Props {
  leadId: string;
}

interface CaptureRow {
  captured_by_member_id: string | null;
  captured_at: string | null;
  capture_valid: boolean | null;
  capture_invalid_reason: string | null;
  promotora: { name: string } | { name: string }[] | null;
}

interface VehicleRow {
  id: string;
  description: string | null;
  brand: string | null;
  model: string | null;
  version: string | null;
  year_model: number | null;
  km: number | null;
  expected_price: number | null;
  status: CaptureVehicleStatus | null;
  sold_price: number | null;
  captured_at: string | null;
  sold_at: string | null;
}

interface CardData {
  captured_by_member_id: string;
  captured_at: string | null;
  capture_valid: boolean;
  capture_invalid_reason: string | null;
  promotora_name: string | null;
  vehicle: VehicleRow | null;
}

/** Opções do Select (sem 'lead', que é o estado inicial automático). */
const STATUS_OPTIONS: { value: CaptureVehicleStatus; label: string }[] = [
  { value: "avaliacao", label: "Avaliação" },
  { value: "captado", label: "Captado" },
  { value: "preparacao", label: "Preparação" },
  { value: "anunciado", label: "Anunciado" },
  { value: "negociacao", label: "Negociação" },
  { value: "vendido", label: "Vendido" },
  { value: "perdido", label: "Perdido" },
];

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtBRL = (v?: number | null) => (v == null ? null : BRL.format(Number(v)));
const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

function vehicleTitle(v: VehicleRow | null) {
  if (!v) return "Veículo não informado";
  const base = v.description?.trim() || [v.brand, v.model, v.version].filter(Boolean).join(" ") || "Veículo";
  return v.year_model ? `${base} ${v.year_model}` : base;
}

function parseMoney(raw: string): number | null {
  const clean = raw.replace(/[^\d,.]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", ".");
  const n = parseFloat(clean);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Prefixo "capture" → invalidado junto pelos hooks do reward engine (qc.invalidateQueries(["capture"])). */
const captureVehicleCardKey = (leadId: string) => ["capture", "engine", "lead-card", leadId] as const;

async function fetchCardData(leadId: string): Promise<CardData | null> {
  // 1) lead + promotora (embed pela FK; se o embed falhar, cai pra 2 queries)
  let row: CaptureRow | null = null;
  const embed = await supabase
    .from("leads")
    .select("captured_by_member_id, captured_at, capture_valid, capture_invalid_reason, promotora:team_members!leads_captured_by_member_id_fkey(name)")
    .eq("id", leadId)
    .maybeSingle();

  if (!embed.error) {
    row = (embed.data as unknown as CaptureRow | null) ?? null;
  } else {
    const plain = await supabase
      .from("leads")
      .select("captured_by_member_id, captured_at, capture_valid, capture_invalid_reason")
      .eq("id", leadId)
      .maybeSingle();
    if (plain.error) throw plain.error;
    row = plain.data ? { ...(plain.data as Omit<CaptureRow, "promotora">), promotora: null } : null;
    if (row?.captured_by_member_id) {
      const { data: tm } = await supabase.from("team_members").select("name").eq("id", row.captured_by_member_id).maybeSingle();
      row.promotora = tm ? { name: tm.name as string } : null;
    }
  }

  if (!row || !row.captured_by_member_id) return null;

  // 2) veículo mais recente
  const { data: vehicles, error: vErr } = await supabase
    .from("seller_vehicles")
    .select("*")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (vErr) throw vErr;

  const promo = Array.isArray(row.promotora) ? row.promotora[0] : row.promotora;
  return {
    captured_by_member_id: row.captured_by_member_id,
    captured_at: row.captured_at,
    capture_valid: !!row.capture_valid,
    capture_invalid_reason: row.capture_invalid_reason,
    promotora_name: promo?.name ?? null,
    vehicle: ((vehicles ?? [])[0] as VehicleRow | undefined) ?? null,
  };
}

export function CaptureVehicleCard({ leadId }: Props) {
  const { isAdmin, isPromotora } = useAuth();
  const qc = useQueryClient();
  const setStatus = useSetSellerVehicleStatus();
  const invalidateLead = useInvalidateCaptureLead();

  const [pendingStatus, setPendingStatus] = useState<CaptureVehicleStatus | null>(null);
  const [soldPrice, setSoldPrice] = useState("");
  const [invalidateOpen, setInvalidateOpen] = useState(false);
  const [invalidateReason, setInvalidateReason] = useState("");

  const q = useQuery({
    queryKey: captureVehicleCardKey(leadId),
    enabled: !!leadId,
    queryFn: () => fetchCardData(leadId),
    staleTime: 15_000,
  });

  // Só renderiza pra lead captado por promotora.
  if (q.isLoading || q.isError || !q.data) return null;

  const data = q.data;
  const vehicle = data.vehicle;
  const status = (vehicle?.status ?? "lead") as CaptureVehicleStatus;
  const statusMeta = VEHICLE_STATUS_META[status] ?? VEHICLE_STATUS_META.lead;
  const canEdit = !isPromotora;

  const refreshLead = () => {
    qc.invalidateQueries({ queryKey: captureVehicleCardKey(leadId) });
    qc.invalidateQueries({ queryKey: ["lead", leadId] });
    qc.invalidateQueries({ queryKey: ["sales-lead", leadId] });
    qc.invalidateQueries({ queryKey: ["sales-leads"] });
  };

  const applyStatus = async (next: CaptureVehicleStatus, price?: number | null) => {
    if (!vehicle) return;
    try {
      await setStatus.mutateAsync({ vehicleId: vehicle.id, status: next, soldPrice: price ?? null });
      toast.success(
        next === "captado"
          ? "Carro marcado como Captado — bônus de captação gerado pra promotora."
          : next === "vendido"
            ? "Carro marcado como Vendido — bônus de venda gerado pra promotora."
            : `Status do carro: ${STATUS_OPTIONS.find((o) => o.value === next)?.label ?? next}.`,
      );
      setPendingStatus(null);
      setSoldPrice("");
      refreshLead();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui atualizar o status do carro.");
    }
  };

  const onSelectStatus = (v: string) => {
    const next = v as CaptureVehicleStatus;
    if (next === status) return;
    if (next === "vendido") {
      setPendingStatus("vendido");
      setSoldPrice(vehicle?.sold_price != null ? String(vehicle.sold_price) : "");
      return;
    }
    void applyStatus(next);
  };

  const confirmSold = () => {
    const price = parseMoney(soldPrice);
    if (price == null) {
      toast.error("Informe o valor da venda.");
      return;
    }
    void applyStatus("vendido", price);
  };

  const confirmInvalidate = async () => {
    const reason = invalidateReason.trim();
    if (reason.length < 3) {
      toast.error("Descreva o motivo da invalidação.");
      return;
    }
    try {
      await invalidateLead.mutateAsync({ leadId, reason });
      toast.success("Lead invalidado — não conta mais na meta da promotora.");
      setInvalidateOpen(false);
      setInvalidateReason("");
      refreshLead();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Não consegui invalidar o lead.");
    }
  };

  return (
    <Card className="border-emerald-200/70 dark:border-emerald-900/60">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Car className="h-4 w-4 text-emerald-600" />
              Captação
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Captado por <strong>{data.promotora_name ?? "promotora"}</strong> em {fmtDate(data.captured_at)}
            </p>
          </div>
          {data.capture_valid ? (
            <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Check className="h-3 w-3 mr-1" /> Conta na meta
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              <AlertTriangle className="h-3 w-3 mr-1" /> Não conta: {data.capture_invalid_reason ?? "dados incompletos"}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Veículo */}
        <div className="rounded-md border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">{vehicleTitle(vehicle)}</p>
            <Badge variant="outline" className={cn("border text-[11px]", statusMeta.cls)}>{statusMeta.label}</Badge>
          </div>
          {vehicle && (
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div>
                <p className="text-muted-foreground">Ano</p>
                <p className="font-medium">{vehicle.year_model ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">KM</p>
                <p className="font-medium">{vehicle.km != null ? vehicle.km.toLocaleString("pt-BR") : "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Valor em mente</p>
                <p className="font-medium">{fmtBRL(vehicle.expected_price) ?? "—"}</p>
              </div>
              <div>
                <p className="text-muted-foreground">{status === "vendido" ? "Vendido por" : "Captado em"}</p>
                <p className="font-medium">
                  {status === "vendido" ? (fmtBRL(vehicle.sold_price) ?? "—") : fmtDate(vehicle.captured_at)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Controles — só time comercial/admin (promotora não altera) */}
        {canEdit && vehicle && (
          <div className="space-y-2">
            <Label className="text-xs">Status do carro</Label>
            <Select value={pendingStatus ?? status} onValueChange={onSelectStatus} disabled={setStatus.isPending}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {status === "lead" && <SelectItem value="lead">Em contato</SelectItem>}
                {STATUS_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {pendingStatus === "vendido" && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30 p-3 space-y-2">
                <Label htmlFor="sold-price" className="text-xs">Valor da venda (R$)</Label>
                <Input
                  id="sold-price"
                  inputMode="decimal"
                  placeholder="Ex.: 85000"
                  value={soldPrice}
                  onChange={(e) => setSoldPrice(e.target.value)}
                  className="h-9"
                  autoFocus
                />
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setPendingStatus(null); setSoldPrice(""); }} disabled={setStatus.isPending}>
                    Cancelar
                  </Button>
                  <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={confirmSold} disabled={setStatus.isPending}>
                    {setStatus.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                    Confirmar venda
                  </Button>
                </div>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              <strong>Captado</strong> gera o bônus de captação pra promotora; <strong>Vendido</strong> gera o bônus de venda.
            </p>
          </div>
        )}

        {canEdit && !vehicle && (
          <p className="text-xs text-muted-foreground">Nenhum veículo cadastrado nesse lead — o status da jornada aparece quando a promotora informar o carro.</p>
        )}

        {/* Invalidar — só admin, e só se ainda conta na meta */}
        {canEdit && isAdmin && data.capture_valid && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setInvalidateOpen(true)}
            >
              <Ban className="h-3.5 w-3.5 mr-1" /> Invalidar lead
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={invalidateOpen} onOpenChange={(o) => { if (!invalidateLead.isPending) setInvalidateOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Invalidar lead da meta?</AlertDialogTitle>
            <AlertDialogDescription>
              O lead deixa de contar na meta semanal de <strong>{data.promotora_name ?? "promotora"}</strong>. Se a meta cair abaixo do
              limiar, o voucher pendente da semana é cancelado. Fica registrado no histórico.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="invalidate-reason" className="text-xs">Motivo</Label>
            <Textarea
              id="invalidate-reason"
              rows={2}
              placeholder="Ex.: telefone inexistente / cliente não reconhece o cadastro"
              value={invalidateReason}
              onChange={(e) => setInvalidateReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={invalidateLead.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={invalidateLead.isPending}
              onClick={(e) => { e.preventDefault(); void confirmInvalidate(); }}
            >
              {invalidateLead.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Invalidar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
