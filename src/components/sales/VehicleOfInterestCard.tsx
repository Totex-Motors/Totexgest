import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Car, ExternalLink, Gauge, Calendar, Link2, Loader2 } from "lucide-react";
import { useUpdateLeadMetadata } from "@/hooks/useSalesLeads";
import { toast } from "sonner";

// Veículo de interesse do lead — dado vem de leads.metadata.vehicle
// (populado pelo webhook do marketplace ou vinculado manualmente pelo vendedor).
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
  // Campos do shape da Credere (financiamento) — normalizados abaixo.
  assets_value?: number;
  manufacture_year?: number;
  model_year?: number;
}

// A Credere grava o veículo com nomes diferentes do Marketplace.
// Normaliza pra um shape único antes de renderizar.
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

function extractVehicleId(input: string): string | null {
  const trimmed = input.trim();
  // URL pattern: https://totexmotors.com/veiculo/<id>
  const urlMatch = trimmed.match(/\/veiculo\/([^/?#]+)/);
  if (urlMatch) return urlMatch[1];
  // Raw ID (alphanumeric, no spaces)
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

async function fetchVehicleFromMarketplace(vehicleId: string): Promise<VehicleMeta | null> {
  try {
    const res = await fetch(`https://totexmotors.com/api/vehicles/${vehicleId}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    // Normaliza campos do marketplace para o formato interno
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

function LinkVehicleModal({
  leadId,
  open,
  onClose,
}: {
  leadId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const updateMeta = useUpdateLeadMetadata();

  async function handleLink() {
    const vehicleId = extractVehicleId(input);
    if (!vehicleId) {
      toast.error("ID ou URL inválido. Cole o link do anúncio ou apenas o ID.");
      return;
    }
    setLoading(true);
    try {
      const vehicle = await fetchVehicleFromMarketplace(vehicleId);
      if (vehicle) {
        await updateMeta.mutateAsync({ leadId, patch: { vehicle } });
        toast.success("Veículo vinculado com sucesso!");
      } else {
        // Salva com o ID mínimo para ao menos ter o link "Ver anúncio"
        await updateMeta.mutateAsync({ leadId, patch: { vehicle: { id: vehicleId } } });
        toast.success("ID vinculado. Dados completos indisponíveis — verifique o anúncio.");
      }
      setInput("");
      onClose();
    } catch {
      toast.error("Erro ao vincular veículo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Vincular veículo
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-sm">URL ou ID do anúncio</Label>
            <Input
              placeholder="https://totexmotors.com/veiculo/abc123"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleLink(); }}
            />
            <p className="text-xs text-muted-foreground">
              Cole o link do anúncio no totexmotors.com ou apenas o ID do veículo.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancelar</Button>
          <Button onClick={handleLink} disabled={loading || !input.trim()}>
            {loading && <Loader2 className="h-3 w-3 mr-2 animate-spin" />}
            Vincular
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VehicleOfInterestCard({
  vehicle: rawVehicle,
  storeName,
  leadId,
}: {
  vehicle?: VehicleMeta | null;
  storeName?: string | null;
  leadId?: string;
}) {
  const [showLink, setShowLink] = useState(false);
  const vehicle = normalizeVehicle(rawVehicle);

  if (!vehicle || (!vehicle.brand && !vehicle.model && !vehicle.description && !vehicle.id)) {
    if (!leadId) return null;
    return (
      <>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Car className="h-4 w-4 text-primary" /> Veículo de interesse
              </span>
              <Button variant="ghost" size="sm" className="h-6 text-xs gap-1 px-2" onClick={() => setShowLink(true)}>
                <Link2 className="h-3 w-3" /> Vincular
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Nenhum veículo vinculado.</p>
          </CardContent>
        </Card>
        {leadId && (
          <LinkVehicleModal leadId={leadId} open={showLink} onClose={() => setShowLink(false)} />
        )}
      </>
    );
  }

  const title =
    [vehicle.brand, vehicle.model].filter(Boolean).join(" ") ||
    vehicle.description ||
    "Veículo";
  const price = vehicle.price_formatted ?? formatCurrency(vehicle.price);
  const anuncioUrl = vehicle.id ? `https://totexmotors.com/veiculo/${vehicle.id}` : null;

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Car className="h-4 w-4 text-primary" /> Veículo de interesse
            </span>
            {leadId && (
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowLink(true)} title="Trocar veículo">
                <Link2 className="h-3 w-3" />
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div>
            <p className="font-medium text-sm leading-tight">{title}</p>
            {vehicle.version && (
              <p className="text-xs text-muted-foreground">{vehicle.version}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {vehicle.year && (
              <span className="flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                {vehicle.year}
              </span>
            )}
            {vehicle.mileage != null && (
              <span className="flex items-center gap-1">
                <Gauge className="h-3 w-3" />
                {vehicle.mileage.toLocaleString("pt-BR")} km
              </span>
            )}
          </div>

          {price && <p className="text-base font-semibold text-primary">{price}</p>}
          {storeName && (
            <p className="text-xs text-muted-foreground">Loja: {storeName}</p>
          )}

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
        </CardContent>
      </Card>

      {leadId && (
        <LinkVehicleModal leadId={leadId} open={showLink} onClose={() => setShowLink(false)} />
      )}
    </>
  );
}
