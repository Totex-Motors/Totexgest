import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { MonitorSmartphone, Search, ExternalLink, Flame } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useTotemLeads, type TotemLead } from "@/hooks/useTotemLeads";

const CATEGORIA_LABEL: Record<string, string> = {
  curioso: "Curioso",
  sonhador: "Sonhador",
  pesquisador: "Pesquisador",
  comprador_planejado: "Comprador Planejado",
  comprador_ativo: "Comprador Ativo",
  comprador_oculto: "Comprador Oculto",
};

const PRAZO_LABEL: Record<string, string> = {
  ate_30_dias: "Até 30 dias",
  ate_90_dias: "Até 90 dias",
  ate_6_meses: "Até 6 meses",
  acima_6_meses: "Acima de 6 meses",
  sem_previsao: "Sem previsão",
};

const TEMP_META: Record<string, { label: string; cls: string }> = {
  frio: { label: "Frio", cls: "bg-sky-100 text-sky-700 border-sky-200" },
  morno: { label: "Morno", cls: "bg-amber-100 text-amber-700 border-amber-200" },
  quente: { label: "Quente", cls: "bg-orange-100 text-orange-700 border-orange-200" },
  muito_quente: { label: "Muito Quente", cls: "bg-red-100 text-red-700 border-red-200" },
};

function formatDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function vehicleLabel(lead: TotemLead): string {
  const v = lead.metadata?.vehicle;
  if (v && (v.brand || v.model)) {
    return [v.brand, v.model, v.version].filter(Boolean).join(" ");
  }
  return "—";
}

/** Loja pra qual a IA encaminhou o lead. null = não encaminhado (em nutrição). */
function handoffStore(lead: TotemLead): { loja: string; encaminhado: boolean } | null {
  const h = lead.metadata?.handoff;
  const loja = h?.loja || lead.metadata?.marketplace_store_name;
  if (!loja) return null;
  return { loja, encaminhado: h?.encaminhado !== false };
}

export default function TotemLeads() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { data: leads, isLoading } = useTotemLeads(search);

  return (
    <AppLayout>
      <div className="space-y-4 p-4 md:p-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <MonitorSmartphone className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Totem Físico</h1>
            <p className="text-sm text-muted-foreground">
              Clientes que conversaram com a IA do stand, qualificados por intenção de compra.
            </p>
          </div>
        </div>

        {/* Busca */}
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome ou telefone..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Tabela */}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Veículo</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Temperatura</TableHead>
                <TableHead>Loja</TableHead>
                <TableHead className="text-center">Prob.</TableHead>
                <TableHead>Prazo</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">Carregando...</TableCell></TableRow>
              )}
              {!isLoading && (!leads || leads.length === 0) && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-10">
                    <Flame className="h-6 w-6 mx-auto mb-2 opacity-40" />
                    Nenhum cliente do totem ainda.
                  </TableCell>
                </TableRow>
              )}
              {leads?.map((lead) => {
                const q = lead.metadata?.qualificacao;
                const temp = q?.temperatura ? TEMP_META[q.temperatura] : null;
                const handoff = handoffStore(lead);
                return (
                  <TableRow
                    key={lead.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/comercial/leads/${lead.id}`)}
                  >
                    <TableCell className="font-medium">{lead.name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{lead.phone || "—"}</TableCell>
                    <TableCell>{vehicleLabel(lead)}</TableCell>
                    <TableCell>{q?.categoria ? (CATEGORIA_LABEL[q.categoria] ?? q.categoria) : "—"}</TableCell>
                    <TableCell>
                      {temp ? <Badge variant="outline" className={cn("text-[11px] font-semibold", temp.cls)}>{temp.label}</Badge> : "—"}
                    </TableCell>
                    <TableCell>
                      {handoff ? (
                        <span className="flex items-center gap-1">
                          <span className="font-medium">{handoff.loja}</span>
                          {handoff.encaminhado && <Flame className="h-3 w-3 text-orange-500 shrink-0" />}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">{q?.probabilidade != null ? `${q.probabilidade}%` : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{q?.prazo_compra ? (PRAZO_LABEL[q.prazo_compra] ?? q.prazo_compra) : "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(lead.created_at)}</TableCell>
                    <TableCell><ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
