import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Car } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatPercent } from './shared';

// BI de captação de veículos do cliente (card Veículo na Troca/Compra):
// quantos carros em cada modalidade, quanto vale o estoque potencial e
// quantos desses leads já converteram em venda (deal ganho).
const MODALIDADES: { key: string; label: string; dot: string }[] = [
  { key: 'troca', label: 'Troca', dot: 'bg-amber-500' },
  { key: 'compra', label: 'Compra', dot: 'bg-emerald-500' },
  { key: 'intermediacao', label: 'Intermediação', dot: 'bg-sky-500' },
  { key: 'consignacao', label: 'Consignação', dot: 'bg-violet-500' },
  { key: 'anuncio_trafego', label: 'Anúncio c/ tráfego', dot: 'bg-rose-500' },
  { key: 'express', label: 'Venda Express', dot: 'bg-cyan-500' },
  { key: 'vitrine', label: 'Venda Vitrine', dot: 'bg-fuchsia-500' },
];

interface Row {
  lead_id: string | null;
  modalidade: string | null;
  valor_avaliado: number | null;
  valor_pedido: number | null;
}

interface Props {
  dateRange: { from: Date; to: Date };
}

export function VehicleIntakeCard({ dateRange }: Props) {
  const navigate = useNavigate();
  const fromIso = dateRange.from.toISOString();
  const toIso = dateRange.to.toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['trade-in', 'bi-modalidades', fromIso, toIso],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trade_in_vehicles')
        .select('lead_id, modalidade, valor_avaliado, valor_pedido')
        .gte('created_at', fromIso)
        .lte('created_at', toIso);
      if (error) throw error;
      return (data || []) as Row[];
    },
    staleTime: 60_000,
  });

  // Leads com deal ganho (pra medir conversão: carro captado -> venda fechada).
  // Query leve (1 coluna); RLS escopa por tenant.
  const { data: wonLeadIds } = useQuery({
    queryKey: ['trade-in', 'bi-won-leads'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deals')
        .select('lead_id')
        .eq('status', 'won')
        .not('lead_id', 'is', null);
      if (error) throw error;
      return new Set((data || []).map((d: { lead_id: string }) => d.lead_id));
    },
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const byMod: Record<string, { qtd: number; valor: number; vendidos: number }> = {};
    let semModalidade = 0;
    let total = 0;
    let valorTotal = 0;
    let vendidosTotal = 0;
    for (const r of data || []) {
      total++;
      const valor = r.valor_avaliado ?? r.valor_pedido ?? 0;
      valorTotal += valor;
      const vendido = !!(r.lead_id && wonLeadIds?.has(r.lead_id));
      if (vendido) vendidosTotal++;
      if (r.modalidade) {
        byMod[r.modalidade] = byMod[r.modalidade] || { qtd: 0, valor: 0, vendidos: 0 };
        byMod[r.modalidade].qtd++;
        byMod[r.modalidade].valor += valor;
        if (vendido) byMod[r.modalidade].vendidos++;
      } else {
        semModalidade++;
      }
    }
    return { byMod, semModalidade, total, valorTotal, vendidosTotal };
  }, [data, wonLeadIds]);

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Car className="h-4 w-4 text-amber-500" /> Captação de Veículos
            <span className="text-[10px] font-normal text-muted-foreground">no período</span>
          </span>
          {stats.total > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              {stats.total} carro{stats.total > 1 ? 's' : ''} · {formatCurrency(stats.valorTotal)}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : stats.total === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nenhum veículo de cliente registrado no período. Registre no card "Veículo na
            Troca/Compra" dentro do lead.
          </p>
        ) : (
          <>
            {MODALIDADES.map((m) => {
              const s = stats.byMod[m.key];
              if (!s) return null;
              const convPct = s.qtd > 0 ? (s.vendidos / s.qtd) * 100 : 0;
              return (
                <button
                  key={m.key}
                  className="w-full flex items-center justify-between text-xs rounded-md px-2 py-1.5 hover:bg-muted/60 transition-colors"
                  onClick={() => navigate(`/comercial/pipeline?modalidade=${m.key}`)}
                  title="Ver no pipeline"
                >
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${m.dot}`} />
                      {m.label}
                    </span>
                    {s.vendidos > 0 && (
                      <span className="pl-4 text-[10px] text-emerald-600 dark:text-emerald-400">
                        {s.vendidos} venda{s.vendidos > 1 ? 's' : ''} · {formatPercent(convPct)} conversão
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">{formatCurrency(s.valor)}</span>
                    <span className="font-semibold tabular-nums">{s.qtd}</span>
                  </span>
                </button>
              );
            })}
            {stats.semModalidade > 0 && (
              <div className="flex items-center justify-between text-xs px-2 py-1.5 text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-slate-300" />
                  Sem modalidade definida
                </span>
                <span className="font-semibold tabular-nums">{stats.semModalidade}</span>
              </div>
            )}
            {stats.vendidosTotal > 0 && (
              <div className="pt-1.5 mt-1 border-t flex items-center justify-between text-[11px] px-2">
                <span className="text-muted-foreground">Conversão geral (lead com carro → venda)</span>
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  {stats.vendidosTotal}/{stats.total} · {formatPercent((stats.vendidosTotal / stats.total) * 100)}
                </span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
