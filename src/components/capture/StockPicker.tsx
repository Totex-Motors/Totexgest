import { useMemo, useState } from "react";
import { Check, Loader2, Search, Store, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useVehicles, type Vehicle } from "@/hooks/useVehicles";
import type { MarketplaceStore } from "@/hooks/useMarketplaceStores";

/**
 * StockPicker — a promotora escolhe a LOJA e busca o CARRO que o cliente está
 * olhando no totem, puxado ao vivo do estoque do marketplace (consultar-estoque,
 * escopado pela loja). O carro escolhido vira o "veículo de interesse" do lead
 * de compra, que é distribuído pro tenant dessa loja.
 */

function precoBRL(v: number | null): string | null {
  if (v == null || !Number.isFinite(v) || v <= 0) return null;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function kmFmt(v: number | null): string | null {
  if (v == null || !Number.isFinite(v)) return null;
  if (v === 0) return "0 km (novo)";
  return `${v.toLocaleString("pt-BR")} km`;
}

export function StockPicker({
  stores,
  storesLoading,
  storeId,
  onStoreChange,
  selected,
  onSelect,
}: {
  stores: MarketplaceStore[];
  storesLoading: boolean;
  storeId: string;
  onStoreChange: (id: string) => void;
  selected: Vehicle | null;
  onSelect: (v: Vehicle | null) => void;
}) {
  const [search, setSearch] = useState("");
  const store = useMemo(() => stores.find((s) => s.tenant_id === storeId) ?? null, [stores, storeId]);
  const { data: vehicles = [], isFetching } = useVehicles({ search, tenantId: store?.tenant_id, loja: store?.name });

  const searchLen = search.trim().length;

  return (
    <div className="space-y-4">
      {/* 1. Loja */}
      <div className="space-y-1.5">
        <Label htmlFor="buy-store">Em qual loja está o carro?</Label>
        <div className="relative">
          <Store className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <select
            id="buy-store"
            className="h-12 w-full rounded-md border border-input bg-background pl-9 pr-3 text-base disabled:opacity-60"
            value={storeId}
            disabled={storesLoading}
            onChange={(e) => { onStoreChange(e.target.value); onSelect(null); }}
          >
            <option value="">{storesLoading ? "Carregando lojas…" : "Escolha a loja"}</option>
            {stores.map((s) => <option key={s.tenant_id} value={s.tenant_id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      {/* 2. Carro selecionado OU busca no estoque da loja */}
      {selected ? (
        <div className="space-y-1.5">
          <Label>Carro que a pessoa quer</Label>
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40 p-2.5">
            {selected.images[0] ? (
              <img src={selected.images[0]} alt="" className="h-14 w-20 rounded object-cover shrink-0" loading="lazy" />
            ) : (
              <div className="h-14 w-20 rounded bg-muted shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{selected.title}{selected.year ? ` ${selected.year}` : ""}</p>
              <p className="text-xs text-muted-foreground truncate">
                {[precoBRL(selected.price), kmFmt(selected.mileage)].filter(Boolean).join(" · ") || "—"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-emerald-100 dark:hover:bg-emerald-900/60"
              aria-label="Trocar carro"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="buy-search">Qual carro a pessoa está olhando?</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            {isFetching
              ? <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
              : null}
            <Input
              id="buy-search"
              className="h-12 text-base pl-9"
              placeholder={store ? "Ex.: Onix, Creta, HB20…" : "Escolha a loja primeiro"}
              value={search}
              disabled={!store}
              onChange={(e) => setSearch(e.target.value)}
              autoComplete="off"
            />
          </div>

          {store && searchLen >= 2 && (
            <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
              {vehicles.length === 0 && !isFetching ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  Nenhum carro com esse nome no estoque da {store.name}. Tenta outro termo.
                </p>
              ) : (
                vehicles.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => onSelect(v)}
                    className="flex w-full items-center gap-3 p-2.5 text-left hover:bg-muted transition-colors active:scale-[0.99]"
                  >
                    {v.images[0] ? (
                      <img src={v.images[0]} alt="" className="h-12 w-16 rounded object-cover shrink-0" loading="lazy" />
                    ) : (
                      <div className="h-12 w-16 rounded bg-muted shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{v.title}{v.year ? ` ${v.year}` : ""}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[precoBRL(v.price), kmFmt(v.mileage)].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    <Check className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                ))
              )}
            </div>
          )}
          {store && searchLen > 0 && searchLen < 2 && (
            <p className="text-[11px] text-muted-foreground">Digite pelo menos 2 letras.</p>
          )}
        </div>
      )}
    </div>
  );
}
