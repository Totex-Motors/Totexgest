import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Car, Search, Plus } from "lucide-react";
import { useVehicles, type Vehicle } from "@/hooks/useVehicles";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (vehicle: Vehicle) => void;
}

function brl(n: number | null | undefined) {
  if (!n) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(n);
}

export default function VehicleInsertDialog({ open, onOpenChange, onInsert }: Props) {
  const [search, setSearch] = useState("");
  const { data: vehicles = [], isLoading } = useVehicles({ search: search || undefined });

  const handlePick = (v: Vehicle) => {
    onInsert(v);
    onOpenChange(false);
    setSearch("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Car className="h-5 w-5" />
            Inserir veículo no email
          </DialogTitle>
          <DialogDescription>
            Escolha um veículo do estoque pra inserir um bloco com foto, título, preço e link.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por marca, modelo, placa..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <div className="flex-1 overflow-y-auto -mx-6 px-6">
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="aspect-[3/2] bg-muted rounded-lg animate-pulse" />
              ))}
            </div>
          ) : vehicles.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Car className="h-10 w-10 mx-auto mb-2 opacity-50" />
              <p>Nenhum veículo encontrado</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {vehicles.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => handlePick(v)}
                  className="text-left rounded-lg border bg-card overflow-hidden hover:shadow-md transition-shadow group"
                >
                  <div className="aspect-[3/2] bg-muted relative overflow-hidden">
                    {v.images?.[0] ? (
                      <img
                        src={v.images[0]}
                        alt={v.title}
                        loading="lazy"
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                        <Car className="h-10 w-10" />
                      </div>
                    )}
                    <Badge
                      variant={v.condition === "novo" ? "default" : "secondary"}
                      className={`absolute top-2 left-2 ${v.condition === "novo" ? "bg-emerald-600" : ""}`}
                    >
                      {v.condition === "novo" ? "0 KM" : "Seminovo"}
                    </Badge>
                  </div>
                  <div className="p-3">
                    <h3 className="font-semibold text-sm leading-tight line-clamp-2 min-h-[2.5rem]">
                      {v.title}
                    </h3>
                    <div className="flex items-center justify-between mt-2">
                      <span className="font-bold text-base">{brl(v.price)}</span>
                      <Button size="sm" variant="outline" className="gap-1">
                        <Plus className="h-3 w-3" />
                        Inserir
                      </Button>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
