import { useMemo, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Radar, Search, Send, Store, UserCheck, Flame, Clock, RefreshCw, Car, ShoppingCart, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMyBuyerLeads, type BuyerLead } from "@/hooks/useCaptureLeads";
import { formatBRL } from "@/types/capture";

/**
 * Rastreamento — torre de controle nível LEAD da operação de captação. Uma lista
 * única de todos os compradores captados no totem, com a jornada visível de ponta
 * a ponta: quem trouxe (promotora) → loja → especialista → etapa → status. Filtros
 * por promotora, loja e status pra "bater o olho e saber onde cada um está", sem
 * pular de tela em tela. Só HQ (superadmin) — o link fica escondido pras lojas.
 */

type StatusFiltro = "todos" | "sem_especialista" | "atendimento" | "vendido";

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

/** Deriva o status operacional do comprador a partir da jornada. */
function statusDo(b: BuyerLead): { key: StatusFiltro; label: string; cls: string } {
  if (b.vendido) return { key: "vendido", label: `Vendido · ${formatBRL(b.comissao_cents)}`, cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" };
  if (b.especialista) return { key: "atendimento", label: "Em atendimento", cls: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300" };
  if (b.distribuido) return { key: "sem_especialista", label: "Na loja · sem especialista", cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300" };
  return { key: "atendimento", label: "Enviando…", cls: "border-border bg-muted text-muted-foreground" };
}

const STATUS_TABS: { value: StatusFiltro; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "sem_especialista", label: "Sem especialista" },
  { value: "atendimento", label: "Em atendimento" },
  { value: "vendido", label: "Vendidos" },
];

export default function RastreamentoLeads() {
  const buyers = useMyBuyerLeads();
  const [search, setSearch] = useState("");
  const [promotora, setPromotora] = useState<string>("todas");
  const [loja, setLoja] = useState<string>("todas");
  const [status, setStatus] = useState<StatusFiltro>("todos");

  const all = buyers.data ?? [];

  const promotoras = useMemo(
    () => Array.from(new Set(all.map((b) => b.promoter_name).filter(Boolean) as string[])).sort(),
    [all],
  );
  const lojas = useMemo(
    () => Array.from(new Set(all.map((b) => b.loja).filter(Boolean) as string[])).sort(),
    [all],
  );

  const filtrados = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((b) => {
      if (promotora !== "todas" && b.promoter_name !== promotora) return false;
      if (loja !== "todas" && b.loja !== loja) return false;
      if (status !== "todos" && statusDo(b).key !== status) return false;
      if (q && !(`${b.name} ${b.phone ?? ""} ${b.veiculo ?? ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [all, search, promotora, loja, status]);

  const semEspecialista = all.filter((b) => b.distribuido && !b.especialista && !b.vendido).length;
  const vendidos = all.filter((b) => b.vendido).length;

  return (
    <AppLayout>
      <div className="space-y-4 p-4 md:p-6 max-w-5xl mx-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Radar className="h-5 w-5 text-emerald-600" /> Rastreamento
            </h1>
            <p className="text-sm text-muted-foreground">
              Todo comprador captado no totem, com a jornada de ponta a ponta: quem trouxe → loja → especialista → etapa.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => buyers.refetch()} disabled={buyers.isRefetching}>
            <RefreshCw className={cn("h-4 w-4", buyers.isRefetching && "animate-spin")} />
          </Button>
        </div>

        {/* Resumo */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-border/60 bg-card p-3">
            <p className="text-2xl font-bold">{all.length}</p>
            <p className="text-xs text-muted-foreground">Compradores</p>
          </div>
          <div className={cn("rounded-lg border p-3", semEspecialista > 0 ? "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30" : "border-border/60 bg-card")}>
            <p className={cn("text-2xl font-bold", semEspecialista > 0 && "text-amber-700 dark:text-amber-400")}>{semEspecialista}</p>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              {semEspecialista > 0 && <AlertTriangle className="h-3 w-3 text-amber-600" />} Sem especialista
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-card p-3">
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">{vendidos}</p>
            <p className="text-xs text-muted-foreground">Vendidos</p>
          </div>
        </div>

        {/* Filtros */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input className="pl-9 h-11" placeholder="Nome, telefone ou carro" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={promotora} onValueChange={setPromotora}>
              <SelectTrigger className="h-10"><SelectValue placeholder="Promotora" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas as promotoras</SelectItem>
                {promotoras.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={loja} onValueChange={setLoja}>
              <SelectTrigger className="h-10"><SelectValue placeholder="Loja" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas as lojas</SelectItem>
                {lojas.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {STATUS_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setStatus(t.value)}
                className={cn(
                  "shrink-0 h-8 px-3 rounded-full border text-xs font-medium",
                  status === t.value ? "bg-primary text-primary-foreground border-primary" : "bg-background border-input text-muted-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Lista */}
        {buyers.isLoading ? (
          <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
        ) : buyers.isError ? (
          <p className="text-sm text-destructive">Erro ao carregar: {(buyers.error as Error).message}</p>
        ) : filtrados.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10 flex flex-col items-center gap-2">
            <ShoppingCart className="h-6 w-6 opacity-40" />
            {all.length === 0 ? "Nenhum comprador captado ainda." : "Nenhum comprador com esses filtros."}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtrados.map((b) => {
              const st = statusDo(b);
              return (
                <li key={b.lead_id} className="rounded-xl border border-border/60 bg-card p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{b.name}</p>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Car className="h-3 w-3" /> {b.veiculo || "Carro não informado"}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={cn("inline-flex items-center rounded-full border px-2 py-px text-[10px] font-medium", st.cls)}>
                        {st.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                        <Clock className="h-3 w-3" /> {relDate(b.created_at)}
                      </span>
                    </div>
                  </div>

                  {/* Jornada em linha: trouxe → loja → especialista → etapa */}
                  <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
                    <JourneyCell icon={Send} label="Trouxe" value={b.promoter_name ?? "—"} />
                    <JourneyCell icon={Store} label="Loja" value={b.loja ?? "—"} pending={!b.loja} />
                    <JourneyCell icon={UserCheck} label="Especialista" value={b.especialista ?? "Sem especialista"} pending={!b.especialista} />
                    <JourneyCell icon={Flame} label="Etapa" value={b.etapa ?? (b.distribuido ? "Aguardando" : "Enviando…")} pending={!b.etapa} />
                  </div>

                  {b.observacao && <p className="mt-2 text-[11px] text-muted-foreground italic truncate">“{b.observacao}”</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppLayout>
  );
}

function JourneyCell({ icon: Icon, label, value, pending }: {
  icon: typeof Store; label: string; value: string; pending?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className={cn("text-xs font-medium truncate", pending && "text-amber-700 dark:text-amber-400")}>{value}</p>
    </div>
  );
}
