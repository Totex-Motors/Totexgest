import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Flame, Phone, Car, UserCheck, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { maskPhoneBR } from "@/lib/phone";
import { useCaptureLeads } from "@/hooks/useCaptureLeads";
import { useLeadCaptureEvents } from "@/hooks/useCaptureHandoff";
import { SellerQualificationCard } from "@/components/capture/SellerQualificationCard";
import { TEMP_META, INTENT_LABEL, HANDOFF_STATUS_LABEL, type CaptureLead, type CaptureTemperatura } from "@/types/capture";

/**
 * "Meus Leads" — só os leads que a promotora captou (RPC list_my_capture_leads +
 * RLS restritiva). Mostra nome, carro, temperatura, status e quem atende.
 * Sem dados financeiros nem leads de outras pessoas.
 */

const FILTERS: { value: CaptureTemperatura | null; label: string }[] = [
  { value: null, label: "Todos" },
  { value: "quente", label: "Quentes" },
  { value: "morno", label: "Mornos" },
  { value: "frio", label: "Frios" },
];

function vehicleLabel(l: CaptureLead) {
  const v = l.vehicle;
  const base = v?.description || [v?.brand, v?.model, v?.version].filter(Boolean).join(" ");
  return [base || "Veículo não informado", v?.year_model].filter(Boolean).join(" · ");
}

function relDate(iso?: string | null) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const dd = Math.floor(h / 24);
  return dd === 1 ? "ontem" : `${dd} dias`;
}

/** Próxima ação sugerida — regra simples, sem IA nessa fase. */
function nextAction(l: CaptureLead): { text: string; urgent: boolean } {
  const q = l.seller_qualification ?? {};
  const rep = l.sales_rep_name?.split(" ")[0];
  if (l.stage_is_won) return { text: "🏆 Carro captado", urgent: false };
  if (l.stage_is_lost) return { text: "Perdido", urgent: false };
  if (q.autoriza_contato !== true) return { text: "Pedir autorização de contato", urgent: true };
  if (l.first_contact_at) return { text: rep ? `${rep} já contatou` : "Contatado", urgent: false };
  if (l.handoff_status === "sla_breached" || l.handoff_status === "escalated") return { text: `Atrasado — ${rep ?? "especialista"} ainda não chamou`, urgent: true };
  if (l.handoff_status === "unassigned") return { text: "Sem especialista — avisar gestor", urgent: true };
  if (rep) return { text: `Aguardando ${rep} chamar`, urgent: l.temperatura === "quente" };
  if (l.vehicle?.km == null) return { text: "Completar KM", urgent: false };
  return { text: "Em nutrição", urgent: false };
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function LeadTimeline({ leadId }: { leadId: string }) {
  const events = useLeadCaptureEvents(leadId);
  if (!events.data?.length) return null;
  return (
    <div className="rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-muted-foreground mb-2">Linha do tempo</p>
      <ol className="space-y-2">
        {events.data.map((e) => (
          <li key={e.id} className="text-xs flex gap-2">
            <span className="text-muted-foreground shrink-0 tabular-nums">{fmtDateTime(e.created_at)}</span>
            <span><span className="font-medium">{e.title}</span>{e.body ? <span className="text-muted-foreground"> — {e.body}</span> : null}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function CaptureMyLeads() {
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [temp, setTemp] = useState<CaptureTemperatura | null>(null);
  const leads = useCaptureLeads({ search, temperatura: temp });
  const selectedId = params.get("lead");
  const selected = useMemo(() => leads.data?.find((l) => l.id === selectedId) ?? null, [leads.data, selectedId]);

  const open = (id: string | null) => {
    const p = new URLSearchParams(params);
    if (id) p.set("lead", id); else p.delete("lead");
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-3">
      <h1 className="text-lg font-bold">Meus leads</h1>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9 h-11" placeholder="Nome ou telefone" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setTemp(f.value)}
            className={cn(
              "shrink-0 h-8 px-3 rounded-full border text-xs font-medium",
              temp === f.value ? "bg-primary text-primary-foreground border-primary" : "bg-background border-input text-muted-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {leads.isLoading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : leads.isError ? (
        <p className="text-sm text-destructive">Erro ao carregar: {(leads.error as Error).message}</p>
      ) : (leads.data?.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-10">Nenhum lead {temp ? TEMP_META[temp].label.toLowerCase() : ""} por aqui ainda.</p>
      ) : (
        <ul className="space-y-2">
          {leads.data!.map((l) => {
            const t = TEMP_META[l.temperatura] ?? TEMP_META.frio;
            const na = nextAction(l);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => open(l.id)}
                  className="w-full text-left rounded-lg border border-border/60 bg-card px-3 py-2.5 active:bg-muted/60"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{l.name}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Car className="h-3 w-3" /> {vehicleLabel(l)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant="outline" className={cn("border text-[10px]", t.cls)}>
                        {l.temperatura === "quente" && <Flame className="h-3 w-3 mr-0.5" />}{t.label}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Clock className="h-3 w-3" /> {relDate(l.captured_at ?? l.created_at)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground truncate">
                      {l.stage_name ?? "Novo"}{l.seller_qualification?.intent ? ` · ${INTENT_LABEL[l.seller_qualification.intent]}` : ""}
                    </span>
                    <span className={cn("text-[11px] font-medium truncate", na.urgent ? "text-amber-700" : "text-muted-foreground")}>
                      {na.text}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Detalhe do lead (bottom sheet) */}
      <Sheet open={!!selected} onOpenChange={(o) => !o && open(null)}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl px-4 pb-8">
          {selected && (
            <div className="space-y-4">
              <SheetHeader className="text-left space-y-1">
                <SheetTitle className="text-lg">{selected.name}</SheetTitle>
                <p className="text-sm text-muted-foreground flex items-center gap-1"><Car className="h-3.5 w-3.5" /> {vehicleLabel(selected)}</p>
              </SheetHeader>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-md border border-border/60 p-2">
                  <p className="text-muted-foreground">Status</p>
                  <p className="font-medium">{selected.stage_name ?? "Novo"}</p>
                </div>
                <div className="rounded-md border border-border/60 p-2">
                  <p className="text-muted-foreground flex items-center gap-1"><UserCheck className="h-3 w-3" /> Especialista</p>
                  <p className="font-medium">{selected.sales_rep_name ?? "Ainda não atribuído"}</p>
                  {selected.first_contact_at ? (
                    <p className="text-emerald-700">Contatou em {fmtDateTime(selected.first_contact_at)}</p>
                  ) : selected.handoff_status ? (
                    <p className={cn(selected.handoff_status === "sla_breached" || selected.handoff_status === "escalated" ? "text-red-600" : "text-muted-foreground")}>
                      {HANDOFF_STATUS_LABEL[selected.handoff_status]}
                    </p>
                  ) : null}
                </div>
              </div>

              <LeadTimeline leadId={selected.id} />

              {selected.phone && (
                <Button asChild variant="outline" className="w-full h-11">
                  <a href={`https://wa.me/${selected.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer">
                    <Phone className="h-4 w-4 mr-2" /> {maskPhoneBR(selected.phone)}
                  </a>
                </Button>
              )}

              <SellerQualificationCard lead={selected} />
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
