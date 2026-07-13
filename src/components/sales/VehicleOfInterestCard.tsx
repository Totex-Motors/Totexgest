import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Car, ExternalLink, Gauge, Calendar, Link2, Loader2, Search, Check, X, MapPin } from "lucide-react";
import { useUpdateLeadMetadata } from "@/hooks/useSalesLeads";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Veículo de interesse do lead — dados em leads.metadata:
//  - metadata.vehicle  = veículo principal (compatibilidade: webhook marketplace,
//    stand-handoff, contexto do agente e views leem este campo)
//  - metadata.vehicles = lista completa quando o lead tem MAIS de um interesse
interface VehicleMeta {
  id?: string;
  description?: string;
  brand?: string;
  model?: string;
  version?: string;
  year?: number;
  mileage?: number;
  price?: number;
  price_formatted?: string;
  store_name?: string;
  // Campos do shape da Credere (financiamento) — normalizados abaixo.
  assets_value?: number;
  manufacture_year?: number;
  model_year?: number;
}

// A Credere grava o veículo com nomes diferentes do Marketplace.
function normalizeVehicle(v?: VehicleMeta | null): VehicleMeta | null {
  if (!v) return v ?? null;
  return {
    ...v,
    price: v.price ?? v.assets_value,
    year: v.year ?? v.model_year ?? v.manufacture_year,
  };
}

function formatCurrency(v?: number) {
  if (v == null) return null;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function vehicleTitle(v: VehicleMeta): string {
  return (
    [v.brand, v.model, v.version].filter(Boolean).join(" ") ||
    v.description ||
    "Veículo"
  );
}

function vehicleKey(v: VehicleMeta): string {
  return v.id || v.description || vehicleTitle(v);
}

function extractVehicleId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/veiculo\/([^/?#]+)/);
  if (urlMatch) return urlMatch[1];
  // ID cru (alfanumérico longo, sem espaços) — evita tratar "gol" como ID
  if (/^[a-zA-Z0-9_-]{12,}$/.test(trimmed)) return trimmed;
  return null;
}

async function fetchVehicleFromMarketplace(vehicleId: string): Promise<VehicleMeta | null> {
  try {
    const res = await fetch(`https://totexmotors.com/api/vehicles/${vehicleId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return {
      id: json.id ?? vehicleId,
      description: json.title ?? json.description ?? null,
      brand: json.brand ?? json.marca ?? null,
      model: json.model ?? json.modelo ?? null,
      version: json.version ?? json.versao ?? null,
      year: json.year ?? json.ano ?? null,
      mileage: json.mileage ?? json.km ?? null,
      price: json.price ?? json.preco ?? null,
      price_formatted: json.price_formatted ?? null,
    };
  } catch {
    return null;
  }
}

// Resultado da tool consultar-estoque (estoque conjunto do marketplace)
interface StockResult {
  vehicle_id: string;
  titulo: string;
  ano?: number;
  preco?: string;
  km?: number;
  cor?: string;
  cidade?: string;
  estado?: string;
  loja?: string;
}

function stockToVehicle(r: StockResult): VehicleMeta {
  return {
    id: r.vehicle_id,
    description: r.titulo,
    year: r.ano,
    mileage: r.km,
    price_formatted: r.preco,
    store_name: r.loja,
  };
}

function LinkVehicleModal({
  leadId,
  current,
  open,
  onClose,
}: {
  leadId: string;
  current: VehicleMeta[];
  open: boolean;
  onClose: () => void;
}) {
  const [term, setTerm] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<StockResult[]>([]);
  const [selected, setSelected] = useState<Map<string, VehicleMeta>>(new Map());
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const updateMeta = useUpdateLeadMetadata();

  const pastedId = extractVehicleId(term);

  // Busca no estoque conjunto conforme digita (debounce 400ms)
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = term.trim();
    if (q.length < 2 || pastedId) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data, error } = await supabase.functions.invoke("consultar-estoque", {
          body: { arguments: { busca: q, limite: 24 } },
        });
        if (error) throw error;
        setResults((data?.veiculos as StockResult[]) || []);
      } catch {
        setResults([]);
        toast.error("Erro ao buscar no estoque.");
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [term, open, pastedId]);

  function toggle(r: StockResult) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(r.vehicle_id)) next.delete(r.vehicle_id);
      else next.set(r.vehicle_id, stockToVehicle(r));
      return next;
    });
  }

  async function persist(list: VehicleMeta[]) {
    // O primeiro vira o principal (metadata.vehicle); a lista completa vai em
    // metadata.vehicles. Mantém compatibilidade com agente/handoff/dashboards.
    await updateMeta.mutateAsync({
      leadId,
      patch: { vehicle: list[0] ?? null, vehicles: list },
    });
  }

  async function handleSave() {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const novos = [...selected.values()];
      // Junta com os já vinculados, sem duplicar
      const existentes = current.filter(
        (c) => !novos.some((n) => vehicleKey(n) === vehicleKey(c)),
      );
      await persist([...existentes, ...novos]);
      toast.success(novos.length > 1 ? `${novos.length} veículos vinculados!` : "Veículo vinculado!");
      setSelected(new Map());
      setTerm("");
      onClose();
    } catch {
      toast.error("Erro ao vincular veículo(s).");
    } finally {
      setSaving(false);
    }
  }

  async function handleLinkById() {
    if (!pastedId) return;
    setSaving(true);
    try {
      const vehicle = (await fetchVehicleFromMarketplace(pastedId)) ?? { id: pastedId };
      const existentes = current.filter((c) => vehicleKey(c) !== vehicleKey(vehicle));
      await persist([...existentes, vehicle]);
      toast.success("Veículo vinculado pelo link/ID!");
      setTerm("");
      onClose();
    } catch {
      toast.error("Erro ao vincular veículo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Car className="h-4 w-4" /> Vincular veículo de interesse
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              placeholder="Digite o carro (ex: Onix, Polo, Hilux)…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Busca no estoque conjunto Totex. Pode selecionar mais de um. Também aceita
            o link/ID do anúncio colado.
          </p>

          {/* Vincular por link/ID colado */}
          {pastedId && (
            <button
              type="button"
              onClick={handleLinkById}
              disabled={saving}
              className="w-full flex items-center gap-2 rounded-md border p-2 text-sm hover:bg-muted/60 transition-colors"
            >
              <Link2 className="h-4 w-4 text-primary shrink-0" />
              <span className="truncate">Vincular pelo link/ID colado: <span className="font-mono text-xs">{pastedId}</span></span>
            </button>
          )}

          {/* Resultados da busca */}
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {searching && (
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Buscando no estoque…
              </div>
            )}
            {!searching && term.trim().length >= 2 && !pastedId && results.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-6">
                Nenhum veículo encontrado no estoque pra “{term.trim()}”.
              </p>
            )}
            {!searching && results.map((r) => {
              const isSel = selected.has(r.vehicle_id);
              return (
                <button
                  key={r.vehicle_id}
                  type="button"
                  onClick={() => toggle(r)}
                  className={cn(
                    "w-full text-left rounded-md border p-2.5 transition-colors",
                    isSel ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className={cn(
                      "mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center",
                      isSel ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/40",
                    )}>
                      {isSel && <Check className="h-3 w-3" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-tight truncate">{r.titulo}</p>
                      <p className="text-xs text-muted-foreground">
                        {[r.ano, r.km != null ? `${r.km.toLocaleString("pt-BR")} km` : null, r.cor]
                          .filter(Boolean).join(" · ")}
                      </p>
                      <div className="flex items-center justify-between gap-2 mt-0.5">
                        <span className="text-sm font-semibold text-primary">{r.preco}</span>
                        {(r.loja || r.cidade) && (
                          <span className="text-[11px] text-muted-foreground flex items-center gap-0.5 truncate">
                            <MapPin className="h-3 w-3 shrink-0" />
                            {[r.loja, r.cidade].filter(Boolean).join(" — ")}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || selected.size === 0}>
            {saving && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
            Vincular{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VehicleBlock({
  vehicle,
  storeName,
  onRemove,
}: {
  vehicle: VehicleMeta;
  storeName?: string | null;
  onRemove?: () => void;
}) {
  const title = vehicleTitle(vehicle);
  const price = vehicle.price_formatted ?? formatCurrency(vehicle.price);
  const anuncioUrl = vehicle.id ? `https://totexmotors.com/veiculo/${vehicle.id}` : null;
  const loja = vehicle.store_name ?? storeName;

  return (
    <div className="space-y-1.5 rounded-md border p-2.5 relative group">
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remover veículo"
          className="absolute top-1.5 right-1.5 h-5 w-5 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-destructive transition-all"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      <p className="font-medium text-sm leading-tight pr-5">{title}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {vehicle.year && (
          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{vehicle.year}</span>
        )}
        {vehicle.mileage != null && (
          <span className="flex items-center gap-1"><Gauge className="h-3 w-3" />{vehicle.mileage.toLocaleString("pt-BR")} km</span>
        )}
      </div>
      {price && <p className="text-sm font-semibold text-primary">{price}</p>}
      {loja && <p className="text-xs text-muted-foreground">Loja: {loja}</p>}
      {anuncioUrl && (
        <a
          href={anuncioUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <ExternalLink className="h-3 w-3" /> Ver anúncio
        </a>
      )}
    </div>
  );
}

export function VehicleOfInterestCard({
  vehicle: rawVehicle,
  vehicles: rawVehicles,
  storeName,
  leadId,
}: {
  vehicle?: VehicleMeta | null;
  vehicles?: VehicleMeta[] | null;
  storeName?: string | null;
  leadId?: string;
}) {
  const [showLink, setShowLink] = useState(false);
  const updateMeta = useUpdateLeadMetadata();

  // União: principal (metadata.vehicle) + lista (metadata.vehicles), sem duplicar
  const primary = normalizeVehicle(rawVehicle);
  const list: VehicleMeta[] = [];
  const seen = new Set<string>();
  for (const v of [primary, ...(rawVehicles || []).map(normalizeVehicle)]) {
    if (!v) continue;
    if (!v.brand && !v.model && !v.description && !v.id) continue;
    const k = vehicleKey(v);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(v);
  }

  async function removeVehicle(idx: number) {
    if (!leadId) return;
    const next = list.filter((_, i) => i !== idx);
    try {
      await updateMeta.mutateAsync({
        leadId,
        patch: { vehicle: next[0] ?? null, vehicles: next },
      });
      toast.success("Veículo removido.");
    } catch {
      toast.error("Erro ao remover veículo.");
    }
  }

  const titulo = list.length > 1 ? `Veículos de interesse (${list.length})` : "Veículo de interesse";

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Car className="h-4 w-4 text-primary" /> {titulo}
            </span>
            {leadId && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs gap-1 px-2"
                onClick={() => setShowLink(true)}
                title="Adicionar veículo do estoque"
              >
                <Search className="h-3 w-3" /> {list.length > 0 ? "Adicionar" : "Vincular"}
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {list.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum veículo vinculado.</p>
          ) : (
            list.map((v, i) => (
              <VehicleBlock
                key={vehicleKey(v)}
                vehicle={v}
                storeName={i === 0 ? storeName : undefined}
                onRemove={leadId ? () => removeVehicle(i) : undefined}
              />
            ))
          )}
        </CardContent>
      </Card>

      {leadId && (
        <LinkVehicleModal
          leadId={leadId}
          current={list}
          open={showLink}
          onClose={() => setShowLink(false)}
        />
      )}
    </>
  );
}
