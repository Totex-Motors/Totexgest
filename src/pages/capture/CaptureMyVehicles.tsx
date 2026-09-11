import { useState } from "react";
import { Car, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { useMyCaptureVehicles } from "@/hooks/useCaptureRewards";
import { useCaptureHomeStats } from "@/hooks/useCaptureLeads";
import { VehicleJourneyCard } from "@/components/capture/VehicleJourneyCard";
import type { CaptureVehicleStatus } from "@/types/capture";

/**
 * "Intermediações" — jornada de cada intermediação que nasceu de um lead da
 * promotora (list_my_capture_vehicles). A captação é só a origem; o objeto
 * acompanhado é a intermediação do carro do proprietário (contrato → vitrine
 * → venda). Prêmios e status vêm do ledger; nada é calculado aqui. Folgista
 * (ou sem regra que valha pra ela) vê a jornada sem o bloco de prêmio.
 */

type Filter = "todos" | "ativos" | "vendidos";

const ACTIVE: CaptureVehicleStatus[] = ["avaliacao", "captado", "preparacao", "anunciado", "negociacao"];

export default function CaptureMyVehicles() {
  const { isFolgista } = useAuth();
  const vehicles = useMyCaptureVehicles();
  const stats = useCaptureHomeStats();
  const [filter, setFilter] = useState<Filter>("todos");
  const showRewards = !isFolgista && stats.data?.perfil !== "folgista" && stats.data?.incentivos !== false;

  const all = vehicles.data ?? [];
  const list = all.filter((v) => {
    if (filter === "vendidos") return v.status === "vendido";
    if (filter === "ativos") return ACTIVE.includes(v.status);
    return true;
  });
  const vendidos = all.filter((v) => v.status === "vendido").length;
  // captados_mes = contratos assinados no mês (desde a migration de intermediação, 'captado' = contrato assinado)
  const formalizadas = stats.data?.captados_mes ?? 0;
  const vendidasMes = stats.data?.vendidos_mes ?? 0;

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-bold flex items-center gap-2"><Car className="h-5 w-5" /> Minhas intermediações</h1>
        <p className="text-xs text-muted-foreground">
          {stats.data ? (
            <>
              <strong className="text-foreground">{formalizadas}</strong> formalizada{formalizadas === 1 ? "" : "s"} e{" "}
              <strong className="text-foreground">{vendidasMes}</strong> vendida{vendidasMes === 1 ? "" : "s"} este mês
            </>
          ) : "Acompanhe cada intermediação do contrato até a venda."}
        </p>
      </div>

      <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1">
        {([
          { v: "todos", label: `Todas (${all.length})` },
          { v: "ativos", label: "Em andamento" },
          { v: "vendidos", label: `Vendidas (${vendidos})` },
        ] as { v: Filter; label: string }[]).map((f) => (
          <button
            key={f.v}
            type="button"
            onClick={() => setFilter(f.v)}
            className={cn(
              "shrink-0 h-8 px-3 rounded-full border text-xs font-medium",
              filter === f.v ? "bg-zinc-950 text-white border-zinc-950 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100" : "bg-background border-input text-muted-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {vehicles.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-2xl" />)}</div>
      ) : vehicles.isError ? (
        <p className="text-sm text-destructive">Erro ao carregar: {(vehicles.error as Error).message}</p>
      ) : list.length === 0 ? (
        <div className="text-center py-12 px-4 space-y-2">
          <div className="mx-auto h-14 w-14 rounded-full bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
            <Sparkles className="h-7 w-7" />
          </div>
          <p className="text-sm font-semibold">
            {filter === "vendidos"
              ? "Nenhuma vendida ainda — mas tá chegando."
              : filter === "ativos"
                ? "Nenhuma intermediação em andamento agora."
                : "Sua primeira intermediação tá a uma conversa de distância."}
          </p>
          <p className="text-xs text-muted-foreground">
            Cada lead válido com autorização de contato pode virar uma intermediação. Quando o especialista abrir uma, ela aparece aqui{showRewards ? " — e o seu prêmio entra quando o contrato for assinado" : " pra você acompanhar"}.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {list.map((v) => (
            <li key={v.vehicle_id}><VehicleJourneyCard vehicle={v} showRewards={showRewards} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
