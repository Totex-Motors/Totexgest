import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calculator, Loader2, TrendingUp } from "lucide-react";

const FIELDS = [
  { key: "carro", label: "Carro" },
  { key: "seguro", label: "Seguro" },
  { key: "acessorios", label: "Acessórios" },
  { key: "documentos", label: "Documentos" },
  { key: "retorno", label: "Retorno" },
] as const;
type Key = (typeof FIELDS)[number]["key"];

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

interface Plan { id: string; name: string; tiers: { min: number; max: number | null; percent: number }[]; consignado_bonus_percent: number; }
interface Props {
  dealId: string;
  salesRepId?: string | null;
  salesRepName?: string | null;
  profitBreakdown?: Record<string, number> | null;
  isConsignado?: boolean;
}

export function ProfitCommissionCard({ dealId, salesRepId, salesRepName, profitBreakdown, isConsignado }: Props) {
  const { teamMember } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const canSee = teamMember?.role === "admin" || teamMember?.role === "comercial" || teamMember?.team === "admin";

  const [vals, setVals] = useState<Record<Key, string>>(() => {
    const b = profitBreakdown || {};
    return Object.fromEntries(FIELDS.map((f) => [f.key, b[f.key] != null ? String(b[f.key]) : ""])) as Record<Key, string>;
  });
  const [consignado, setConsignado] = useState(!!isConsignado);

  const { data: plan } = useQuery({
    queryKey: ["commission-plan", salesRepId],
    enabled: canSee && !!salesRepId,
    queryFn: async (): Promise<Plan | null> => {
      const { data } = await supabase
        .from("commission_plans")
        .select("id, name, tiers, consignado_bonus_percent, sales_rep_id")
        .or(`sales_rep_id.eq.${salesRepId},sales_rep_id.is.null`)
        .eq("is_active", true);
      if (!data || data.length === 0) return null;
      const specific = data.find((p: any) => p.sales_rep_id === salesRepId);
      return (specific || data[0]) as Plan;
    },
  });

  const lucro = useMemo(() => FIELDS.reduce((s, f) => s + (parseFloat(vals[f.key].replace(",", ".")) || 0), 0), [vals]);
  const calc = useMemo(() => {
    if (!plan) return null;
    const tier = plan.tiers.find((t) => lucro >= t.min && (t.max == null || lucro <= t.max));
    const tierPct = tier?.percent ?? 0;
    const totalPct = tierPct + (consignado ? plan.consignado_bonus_percent : 0);
    return { tierPct, totalPct, amount: Math.round((lucro * totalPct) / 100 * 100) / 100 };
  }, [plan, lucro, consignado]);

  const save = useMutation({
    mutationFn: async () => {
      const breakdown = Object.fromEntries(FIELDS.map((f) => [f.key, parseFloat(vals[f.key].replace(",", ".")) || 0]));
      const { error } = await supabase.from("deals")
        .update({ profit_breakdown: breakdown, operation_profit: lucro, is_consignado: consignado })
        .eq("id", dealId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Lucro salvo — comissão calculada", description: calc ? `${salesRepName || "Vendedor"}: ${brl(calc.amount)} (${calc.totalPct}%)` : undefined });
      qc.invalidateQueries({ queryKey: ["sales-deal", dealId] });
    },
    onError: (e: Error) => toast({ title: "Erro ao salvar", description: e.message, variant: "destructive" }),
  });

  if (!canSee) return null;

  return (
    <Card className="border-emerald-500/25">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Calculator className="h-4 w-4 text-emerald-600" /> Lucro &amp; Comissão
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`pf-${f.key}`} className="text-xs text-muted-foreground">{f.label} (R$)</Label>
              <Input id={`pf-${f.key}`} inputMode="decimal" value={vals[f.key]}
                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} placeholder="0" />
            </div>
          ))}
          <div className="flex flex-col justify-end gap-1">
            <Label className="text-xs text-muted-foreground">Venda consignada</Label>
            <div className="flex items-center gap-2 h-10">
              <Switch checked={consignado} onCheckedChange={setConsignado} />
              <span className="text-xs text-muted-foreground">{consignado ? "Sim (+bônus)" : "Não"}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
          <div>
            <p className="text-xs text-muted-foreground">Lucro da operação</p>
            <p className="text-lg font-bold">{brl(lucro)}</p>
          </div>
          {plan && calc ? (
            <div className="text-right">
              <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                <TrendingUp className="h-3 w-3" /> Comissão · {salesRepName || "vendedor"}
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{calc.totalPct}%{consignado ? " (c/ consignado)" : ""}</Badge>
              </p>
              <p className="text-lg font-bold text-emerald-600">{brl(calc.amount)}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground max-w-[220px]">
              {salesRepId ? "Sem plano de comissão configurado para este vendedor." : "Defina o vendedor responsável para calcular a comissão."}
            </p>
          )}
        </div>

        <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full bg-emerald-600 hover:bg-emerald-700">
          {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          Salvar lucro e comissão
        </Button>
        <p className="text-[11px] text-muted-foreground">
          A comissão é calculada sobre o lucro (carro + seguro + acessórios + documentos + retorno). Consignado soma o bônus.
        </p>
      </CardContent>
    </Card>
  );
}
