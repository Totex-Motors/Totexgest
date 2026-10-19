import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Calculator, Loader2, Target, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Premissa de ganhos — simulador "quanto o vendedor leva no mês".
 * Fixo (salário) + comissão por faixa do plano (commission_plans.tiers, faixa pelo
 * lucro de CADA carro, igual ao card Lucro & Comissão) + bônus de consignado.
 * As premissas (carros/mês, lucro médio, % consignado, meta) ficam salvas no plano.
 */

interface Tier { min: number; max: number | null; percent: number }
interface Premissas { carros?: number; lucro_medio?: number; pct_consignado?: number; meta?: number }
interface Plan {
  id: string;
  name: string;
  sales_rep_id: string | null;
  tiers: Tier[];
  consignado_bonus_percent: number;
  fixed_salary: number;
  premissas: Premissas | null;
  rep_name?: string;
}

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const num = (s: string) => parseFloat(String(s).replace(/\./g, "").replace(",", ".")) || 0;

export function tierPercent(tiers: Tier[], lucro: number): number {
  const t = (tiers || []).find((x) => lucro >= Number(x.min) && (x.max == null || lucro <= Number(x.max)));
  return t ? Number(t.percent) : 0;
}

export function simularGanhos(plan: Pick<Plan, "tiers" | "consignado_bonus_percent">, p: {
  carros: number; lucroMedio: number; pctConsignado: number; fixo: number;
}) {
  const pct = tierPercent(plan.tiers, p.lucroMedio);
  const bonus = Number(plan.consignado_bonus_percent) || 0;
  const porCarro = (p.lucroMedio * pct) / 100;
  const porCarroConsignado = (p.lucroMedio * (pct + bonus)) / 100;
  const consignados = Math.round((p.carros * p.pctConsignado) / 100);
  const normais = Math.max(0, p.carros - consignados);
  const comissao = normais * porCarro + consignados * porCarroConsignado;
  const mediaPorCarro = p.carros > 0 ? comissao / p.carros : porCarro;
  return { pct, bonus, porCarro, porCarroConsignado, consignados, normais, comissao, total: p.fixo + comissao, mediaPorCarro };
}

const CENARIOS = [2, 4, 6, 8, 10, 12, 15];

interface Props {
  /** Vendedor pré-selecionado (ex.: vindo do card Lucro & Comissão). */
  salesRepId?: string | null;
  /** Como o botão aparece. */
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "sm";
  className?: string;
  label?: string;
}

export function EarningsSimulatorButton({ salesRepId, variant = "outline", size = "default", className, label = "Premissa de ganhos" }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} className={cn("gap-2", className)} onClick={() => setOpen(true)}>
        <Target className="h-4 w-4" /> {label}
      </Button>
      {open && <EarningsSimulatorDialog open={open} onOpenChange={setOpen} salesRepId={salesRepId} />}
    </>
  );
}

export function EarningsSimulatorDialog({ open, onOpenChange, salesRepId }: { open: boolean; onOpenChange: (v: boolean) => void; salesRepId?: string | null }) {
  const { teamMember } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isGestor = teamMember?.role === "admin" || teamMember?.role === "comercial" || teamMember?.team === "admin";

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ["commission-plans-all"],
    enabled: open,
    queryFn: async (): Promise<Plan[]> => {
      const { data, error } = await supabase
        .from("commission_plans")
        .select("id, name, sales_rep_id, tiers, consignado_bonus_percent, fixed_salary, premissas, is_active")
        .eq("is_active", true)
        .not("sales_rep_id", "is", null);
      if (error) throw error;
      const ids = (data || []).map((p: any) => p.sales_rep_id).filter(Boolean);
      const { data: members } = ids.length
        ? await supabase.from("team_members").select("id, name").in("id", ids)
        : { data: [] as any[] };
      const names = new Map((members || []).map((m: any) => [m.id, (m.name || "").trim()]));
      return (data || []).map((p: any) => ({
        ...p,
        tiers: Array.isArray(p.tiers) ? p.tiers : [],
        consignado_bonus_percent: Number(p.consignado_bonus_percent) || 0,
        fixed_salary: Number(p.fixed_salary) || 0,
        rep_name: names.get(p.sales_rep_id) || p.name,
      }));
    },
  });

  // Vendedor comum só vê o próprio plano; gestor escolhe.
  const visiveis = useMemo(
    () => (isGestor ? plans : plans.filter((p) => p.sales_rep_id === teamMember?.id)),
    [plans, isGestor, teamMember?.id],
  );
  const [planId, setPlanId] = useState<string>("");
  useEffect(() => {
    if (planId || visiveis.length === 0) return;
    const pre = visiveis.find((p) => p.sales_rep_id === salesRepId) || visiveis[0];
    setPlanId(pre.id);
  }, [visiveis, salesRepId, planId]);
  const plan = visiveis.find((p) => p.id === planId) || null;

  const [carros, setCarros] = useState(6);
  const [lucroMedio, setLucroMedio] = useState("8000");
  const [pctConsignado, setPctConsignado] = useState(0);
  const [fixo, setFixo] = useState("0");
  const [meta, setMeta] = useState("");

  // Carrega as premissas salvas quando troca o plano.
  useEffect(() => {
    if (!plan) return;
    const pr = plan.premissas || {};
    setCarros(pr.carros ?? 6);
    setLucroMedio(String(pr.lucro_medio ?? 8000));
    setPctConsignado(pr.pct_consignado ?? 0);
    setFixo(String(plan.fixed_salary ?? 0));
    setMeta(pr.meta ? String(pr.meta) : "");
  }, [plan?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = useMemo(
    () => (plan ? simularGanhos(plan, { carros, lucroMedio: num(lucroMedio), pctConsignado, fixo: num(fixo) }) : null),
    [plan, carros, lucroMedio, pctConsignado, fixo],
  );
  const metaCarros = useMemo(() => {
    if (!r || !num(meta)) return null;
    const falta = num(meta) - num(fixo);
    if (falta <= 0) return 0;
    if (r.mediaPorCarro <= 0) return null;
    return Math.ceil(falta / r.mediaPorCarro);
  }, [r, meta, fixo]);

  const save = useMutation({
    mutationFn: async () => {
      if (!plan) return;
      const premissas: Premissas = { carros, lucro_medio: num(lucroMedio), pct_consignado: pctConsignado, meta: num(meta) || undefined };
      const { error } = await supabase
        .from("commission_plans")
        .update({ fixed_salary: num(fixo), premissas })
        .eq("id", plan.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Premissa salva", description: `${plan?.rep_name}: fixo ${brl(num(fixo))} + premissas do mês.` });
      qc.invalidateQueries({ queryKey: ["commission-plans-all"] });
      qc.invalidateQueries({ queryKey: ["commission-plan", plan?.sales_rep_id] });
    },
    onError: (e: Error) => toast({ title: "Erro ao salvar", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-emerald-600" /> Premissa de ganhos
          </DialogTitle>
          <DialogDescription>
            Quanto o vendedor leva no mês: fixo + comissão pelo plano. Mexa nos números e veja na hora.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" /> Carregando planos…</div>
        ) : visiveis.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">Nenhum plano de comissão ativo com vendedor vinculado.</p>
        ) : plan && r ? (
          <div className="space-y-5">
            {/* Vendedor + plano */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Vendedor</Label>
                {isGestor && visiveis.length > 1 ? (
                  <Select value={planId} onValueChange={setPlanId}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {visiveis.map((p) => <SelectItem key={p.id} value={p.id}>{p.rep_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="h-10 flex items-center font-medium">{plan.rep_name}</div>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="es-fixo" className="text-xs text-muted-foreground">Fixo mensal (R$)</Label>
                <Input id="es-fixo" inputMode="decimal" value={fixo} onChange={(e) => setFixo(e.target.value)} disabled={!isGestor} />
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground items-center">
              <span>Faixas do plano (lucro por carro):</span>
              {plan.tiers.map((t, i) => (
                <Badge key={i} variant={r.pct === Number(t.percent) ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                  {t.max == null ? `≥ ${brl(Number(t.min))}` : `${brl(Number(t.min))}–${brl(Number(t.max))}`}: {t.percent}%
                </Badge>
              ))}
              {plan.consignado_bonus_percent > 0 && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">consignado +{plan.consignado_bonus_percent}%</Badge>
              )}
            </div>

            {/* Premissas */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-xs text-muted-foreground">Carros vendidos no mês</Label>
                  <span className="text-sm font-semibold">{carros}</span>
                </div>
                <Slider min={0} max={20} step={1} value={[carros]} onValueChange={(v) => setCarros(v[0])} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="es-lucro" className="text-xs text-muted-foreground">Lucro médio por carro (R$)</Label>
                <Input id="es-lucro" inputMode="decimal" value={lucroMedio} onChange={(e) => setLucroMedio(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">Carro + seguro + acessórios + documentos + retorno. Faixa: {r.pct}%.</p>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <Label className="text-xs text-muted-foreground">Vendas consignadas</Label>
                  <span className="text-sm font-semibold">{pctConsignado}% ({r.consignados} de {carros})</span>
                </div>
                <Slider min={0} max={100} step={5} value={[pctConsignado]} onValueChange={(v) => setPctConsignado(v[0])} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="es-meta" className="text-xs text-muted-foreground">Meta de ganho no mês (R$) — opcional</Label>
                <Input id="es-meta" inputMode="decimal" value={meta} onChange={(e) => setMeta(e.target.value)} placeholder="ex.: 8000" />
                {metaCarros != null && (
                  <p className="text-[11px] text-emerald-600 font-medium">
                    {metaCarros === 0 ? "O fixo já cobre a meta." : `Precisa vender ${metaCarros} carro${metaCarros > 1 ? "s" : ""} com lucro médio de ${brl(num(lucroMedio))}.`}
                  </p>
                )}
              </div>
            </div>

            {/* Resultado */}
            <div className="rounded-lg bg-muted/50 p-4 grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Fixo</p>
                <p className="text-lg font-bold">{brl(num(fixo))}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3" /> Comissão</p>
                <p className="text-lg font-bold text-emerald-600">{brl(r.comissao)}</p>
                <p className="text-[11px] text-muted-foreground">{brl(r.porCarro)}/carro{r.consignados > 0 ? ` · ${brl(r.porCarroConsignado)} consignado` : ""}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total no mês</p>
                <p className="text-2xl font-bold">{brl(r.total)}</p>
              </div>
            </div>

            {/* Cenários */}
            <div>
              <p className="text-xs text-muted-foreground mb-1">Cenários com o mesmo lucro médio e % consignado</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-8">Carros</TableHead>
                    <TableHead className="h-8 text-right">Comissão</TableHead>
                    <TableHead className="h-8 text-right">Total (fixo + comissão)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(new Set([...CENARIOS, carros])).sort((a, b) => a - b).map((n) => {
                    const s = simularGanhos(plan, { carros: n, lucroMedio: num(lucroMedio), pctConsignado, fixo: num(fixo) });
                    const atual = n === carros;
                    return (
                      <TableRow key={n} className={cn(atual && "bg-emerald-500/10 font-semibold")}>
                        <TableCell className="py-1.5">{n}{atual ? " ◀" : ""}</TableCell>
                        <TableCell className="py-1.5 text-right">{brl(s.comissao)}</TableCell>
                        <TableCell className="py-1.5 text-right">{brl(s.total)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {isGestor && (
              <Button onClick={() => save.mutate()} disabled={save.isPending} className="w-full bg-emerald-600 hover:bg-emerald-700">
                {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Salvar fixo e premissas
              </Button>
            )}
            <p className="text-[11px] text-muted-foreground">
              Estimativa. A comissão real sai do lucro lançado em cada venda (card Lucro &amp; Comissão), faixa por carro.
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
