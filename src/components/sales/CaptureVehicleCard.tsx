import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Car, Check, AlertTriangle, Loader2, Ban, ExternalLink, Link2, X } from "lucide-react";
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
  /** Anúncio no marketplace (sync capture-listings, 2×/dia) */
  marketplace_vehicle_id: string | null;
  listing_url: string | null;
  listing_price: number | null;
  listing_last_seen_at: string | null;
  listing_missing_since: string | null;
  /** Evidência da venda (obrigatória pra marcar Vendido) */
  sold_deal_id: string | null;
  sold_note: string | null;
  sold_marked_by: string | null;
}

interface CardData {
  captured_by_member_id: string;
  captured_at: string | null;
  capture_valid: boolean;
  capture_invalid_reason: string | null;
  promotora_name: string | null;
  vehicle: VehicleRow | null;
  /** Título do negócio do comprador (quando vendido com deal vinculado) */
  sold_deal_title: string | null;
  sold_marked_by_name: string | null;
}

/** Negócio do comprador — candidatos pro vínculo da venda (busca client-side nos 100 mais recentes). */
interface DealOption {
  id: string;
  title: string;
  status: string | null;
  lead_name: string | null;
  won: boolean;
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
  const vehicle = ((vehicles ?? [])[0] as VehicleRow | undefined) ?? null;

  // 3) evidência da venda (título do negócio do comprador + quem marcou)
  let sold_deal_title: string | null = null;
  let sold_marked_by_name: string | null = null;
  if (vehicle?.sold_deal_id) {
    const { data: d } = await supabase.from("deals").select("title").eq("id", vehicle.sold_deal_id).maybeSingle();
    sold_deal_title = (d?.title as string | undefined) ?? null;
  }
  if (vehicle?.sold_marked_by) {
    const { data: m } = await supabase.from("team_members").select("name").eq("id", vehicle.sold_marked_by).maybeSingle();
    sold_marked_by_name = (m?.name as string | undefined) ?? null;
  }

  return {
    captured_by_member_id: row.captured_by_member_id,
    captured_at: row.captured_at,
    capture_valid: !!row.capture_valid,
    capture_invalid_reason: row.capture_invalid_reason,
    promotora_name: promo?.name ?? null,
    vehicle,
    sold_deal_title,
    sold_marked_by_name,
  };
}

/** Negócios recentes do tenant, menos os do próprio dono do carro (RLS do tenant já filtra). */
async function fetchDealOptions(sellerLeadId: string): Promise<DealOption[]> {
  const { data, error } = await supabase
    .from("deals")
    .select("id, title, status, won_at, lead_id, lead:leads(name)")
    .neq("lead_id", sellerLeadId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((d) => {
    const lead = Array.isArray(d.lead) ? d.lead[0] : d.lead;
    return {
      id: d.id as string,
      title: (d.title as string) || "Negócio sem título",
      status: (d.status as string | null) ?? null,
      lead_name: (lead as { name?: string } | null)?.name ?? null,
      won: !!d.won_at || d.status === "won",
    };
  });
}

export function CaptureVehicleCard({ leadId }: Props) {
  const { isAdmin, isPromotora } = useAuth();
  const qc = useQueryClient();
  const setStatus = useSetSellerVehicleStatus();
  const invalidateLead = useInvalidateCaptureLead();

  const [pendingStatus, setPendingStatus] = useState<CaptureVehicleStatus | null>(null);
  const [soldPrice, setSoldPrice] = useState("");
  const [soldDealId, setSoldDealId] = useState<string | null>(null);
  const [soldNote, setSoldNote] = useState("");
  const [dealSearch, setDealSearch] = useState("");
  const [invalidateOpen, setInvalidateOpen] = useState(false);
  const [invalidateReason, setInvalidateReason] = useState("");

  const q = useQuery({
    queryKey: captureVehicleCardKey(leadId),
    enabled: !!leadId,
    queryFn: () => fetchCardData(leadId),
    staleTime: 15_000,
  });

  // Só carrega a lista de negócios quando o usuário abre o formulário de venda.
  const dealsQ = useQuery({
    queryKey: ["capture", "engine", "deal-options", leadId],
    enabled: pendingStatus === "vendido",
    queryFn: () => fetchDealOptions(leadId),
    staleTime: 30_000,
  });
  const dealOptions = useMemo(() => {
    const all = dealsQ.data ?? [];
    const term = dealSearch.trim().toLowerCase();
    const filtered = term
      ? all.filter((d) => d.title.toLowerCase().includes(term) || (d.lead_name ?? "").toLowerCase().includes(term))
      : all;
    return filtered.slice(0, 8);
  }, [dealsQ.data, dealSearch]);
  const selectedDeal = (dealsQ.data ?? []).find((d) => d.id === soldDealId) ?? null;

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

  const resetSoldForm = () => {
    setPendingStatus(null);
    setSoldPrice("");
    setSoldDealId(null);
    setSoldNote("");
    setDealSearch("");
  };

  const applyStatus = async (next: CaptureVehicleStatus, price?: number | null, dealId?: string | null, note?: string | null) => {
    if (!vehicle) return;
    try {
      await setStatus.mutateAsync({ vehicleId: vehicle.id, status: next, soldPrice: price ?? null, soldDealId: dealId ?? null, soldNote: note ?? null });
      toast.success(
        next === "captado"
          ? "Carro marcado como Captado — bônus de captação gerado pra promotora."
          : next === "vendido"
            ? "Venda registrada — o bônus da promotora entra como pendente pro gestor aprovar em Prêmios › Aprovações."
            : `Status do carro: ${STATUS_OPTIONS.find((o) => o.value === next)?.label ?? next}.`,
      );
      resetSoldForm();
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
      setSoldDealId(vehicle?.sold_deal_id ?? null);
      setSoldNote(vehicle?.sold_note ?? "");
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
    const note = soldNote.trim();
    if (!soldDealId && note.length < 3) {
      toast.error("Vincule o negócio do comprador ou descreva a venda (nome do comprador / nº do documento).");
      return;
    }
    void applyStatus("vendido", price, soldDealId, note || null);
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

          {/* Anúncio (fonte de verdade do "Anunciado") */}
          {vehicle?.listing_url && (
            <p className="mt-2 text-xs flex flex-wrap items-center gap-x-2 gap-y-1">
              <a href={vehicle.listing_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 hover:underline">
                <ExternalLink className="h-3.5 w-3.5" /> Ver anúncio no site
              </a>
              {vehicle.listing_price != null && <span className="text-muted-foreground">· {fmtBRL(vehicle.listing_price)}</span>}
              {vehicle.listing_missing_since ? (
                <span className="text-amber-700 dark:text-amber-400">· sumiu do estoque em {fmtDate(vehicle.listing_missing_since)}</span>
              ) : vehicle.listing_last_seen_at ? (
                <span className="text-muted-foreground">· visto no estoque em {fmtDate(vehicle.listing_last_seen_at)}</span>
              ) : null}
            </p>
          )}
          {vehicle && !vehicle.listing_url && ["captado", "preparacao"].includes(status) && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              Ainda não apareceu no estoque da loja no site. O sistema confere 2× por dia e move pra Anunciado sozinho.
            </p>
          )}

          {/* Evidência da venda */}
          {vehicle && status === "vendido" && (vehicle.sold_note || data.sold_deal_title || data.sold_marked_by_name) && (
            <p className="mt-2 text-xs text-muted-foreground">
              <Link2 className="inline h-3.5 w-3.5 mr-1 text-emerald-600" />
              {data.sold_deal_title ? <>Negócio do comprador: <strong className="text-foreground">{data.sold_deal_title}</strong>. </> : null}
              {vehicle.sold_note ? <>{vehicle.sold_note}. </> : null}
              {data.sold_marked_by_name ? <>Marcado por {data.sold_marked_by_name}.</> : <>Registrado automaticamente pelo funil.</>}
            </p>
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
              <div className="rounded-md border border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30 p-3 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sold-price" className="text-xs">Valor da venda (R$) *</Label>
                  <Input
                    id="sold-price"
                    inputMode="decimal"
                    placeholder="Ex.: 85000"
                    value={soldPrice}
                    onChange={(e) => setSoldPrice(e.target.value)}
                    className="h-9"
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Negócio do comprador (evidência)</Label>
                  {selectedDeal ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-emerald-300 bg-background px-2.5 py-1.5 text-xs">
                      <span className="min-w-0 truncate">
                        <Link2 className="inline h-3.5 w-3.5 mr-1 text-emerald-600" />
                        <strong>{selectedDeal.title}</strong>{selectedDeal.lead_name ? ` · ${selectedDeal.lead_name}` : ""}{selectedDeal.won ? " · ganho" : ""}
                      </span>
                      <button type="button" className="text-muted-foreground hover:text-foreground shrink-0" onClick={() => setSoldDealId(null)} aria-label="Remover vínculo">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      <Input
                        placeholder="Buscar pelo título do negócio ou nome do comprador…"
                        value={dealSearch}
                        onChange={(e) => setDealSearch(e.target.value)}
                        className="h-9"
                      />
                      {dealsQ.isLoading ? (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Carregando negócios…</p>
                      ) : dealOptions.length > 0 ? (
                        <ul className="max-h-40 overflow-y-auto rounded-md border border-border/60 bg-background divide-y divide-border/60">
                          {dealOptions.map((d) => (
                            <li key={d.id}>
                              <button
                                type="button"
                                className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-muted/60"
                                onClick={() => { setSoldDealId(d.id); setDealSearch(""); }}
                              >
                                <span className="font-medium">{d.title}</span>
                                {d.lead_name ? <span className="text-muted-foreground"> · {d.lead_name}</span> : null}
                                {d.won ? <span className="ml-1 text-emerald-600">· ganho</span> : null}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : dealSearch ? (
                        <p className="text-[11px] text-muted-foreground">Nenhum negócio com esse nome. Sem negócio no CRM? Descreva a venda abaixo.</p>
                      ) : null}
                    </>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="sold-note" className="text-xs">{soldDealId ? "Observação (opcional)" : "Ou descreva a venda *"}</Label>
                  <Textarea
                    id="sold-note"
                    rows={2}
                    placeholder="Ex.: comprador Maria Souza · NF 1234 · vendido na loja em 10/09"
                    value={soldNote}
                    onChange={(e) => setSoldNote(e.target.value)}
                  />
                </div>

                <p className="text-[11px] text-muted-foreground">
                  A venda fica registrada com valor, comprador e quem marcou. O bônus da promotora nasce <strong>pendente</strong> com essa evidência e só é pago depois que o gestor aprovar.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={resetSoldForm} disabled={setStatus.isPending}>
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
              <strong>Captado</strong> acende quando o negócio chega em Ganho no funil (ou aqui). <strong>Anunciado</strong> acende sozinho quando o carro aparece no estoque da loja no site (conferido 2× por dia). <strong>Negociação</strong> e <strong>Vendido</strong> acendem pelo negócio do comprador — ou aqui, com evidência.
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
