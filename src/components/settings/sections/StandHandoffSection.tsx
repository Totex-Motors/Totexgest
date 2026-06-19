import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Building2, Loader2, Phone, Pencil, Trash2 } from "lucide-react";
import {
  useLeadDestinations,
  useSetLeadDestination,
  useDeleteLeadDestination,
  type TenantDestinationRow,
} from "@/hooks/useStandHandoff";

// ─── Dialog de edição do destino de uma loja ───────────────────────────────────

function EditDestinationDialog({ row, onClose }: { row: TenantDestinationRow; onClose: () => void }) {
  const setDest = useSetLeadDestination();
  const [target, setTarget] = useState(row.destination?.whatsapp_target ?? "");
  const [label, setLabel] = useState(row.destination?.label ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const digits = target.replace(/\D/g, "");
    if (digits.length < 10) return;
    await setDest.mutateAsync({
      tenant_id: row.tenant_id,
      whatsapp_target: digits,
      label: label.trim() || undefined,
      destination_type: "number",
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Destino de lead — {row.tenant_name}</DialogTitle>
          <DialogDescription>
            WhatsApp (número individual) onde a loja recebe os leads qualificados pelo
            agente do stand. Use o formato DDI+DDD+número.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="target">WhatsApp da loja *</Label>
            <Input
              id="target" value={target} onChange={(e) => setTarget(e.target.value)}
              placeholder="5511999999999" required inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="label">Identificação (opcional)</Label>
            <Input
              id="label" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex: Comercial / Gerente João"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={setDest.isPending}>
              {setDest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Seção principal ────────────────────────────────────────────────────────────

export function StandHandoffSection() {
  const { data: rows = [], isLoading } = useLeadDestinations();
  const deleteDest = useDeleteLeadDestination();
  const [editRow, setEditRow] = useState<TenantDestinationRow | null>(null);

  const configured = rows.filter((r) => r.destination).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {configured} de {rows.length} loja(s) com destino de lead configurado. O agente do
        stand usa esse número pra repassar o lead qualificado à loja dona do carro.
      </p>

      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Loja</TableHead>
              <TableHead>WhatsApp de destino</TableHead>
              <TableHead className="hidden sm:table-cell">Identificação</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">Carregando...</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">Nenhuma loja cadastrada.</TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.tenant_id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-muted-foreground/60" />
                      <span>{r.tenant_name}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {r.destination ? (
                      <div className="flex items-center gap-1.5 text-sm">
                        <Phone className="h-3.5 w-3.5 text-emerald-600" />
                        <code className="text-xs">{r.destination.whatsapp_target}</code>
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">não configurado</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                    {r.destination?.label || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost" size="sm" className="h-7 px-2 gap-1 text-xs"
                        onClick={() => setEditRow(r)}
                      >
                        <Pencil className="h-3 w-3" /> {r.destination ? "Editar" : "Definir"}
                      </Button>
                      {r.destination && (
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          disabled={deleteDest.isPending}
                          onClick={() => deleteDest.mutate({ tenant_id: r.tenant_id })}
                          title="Remover destino"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {editRow && (
        <EditDestinationDialog key={editRow.tenant_id} row={editRow} onClose={() => setEditRow(null)} />
      )}
    </div>
  );
}
