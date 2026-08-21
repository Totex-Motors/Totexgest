import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Car } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency } from './shared';

// BI de captação de veículos do cliente (card Veículo na Troca/Compra):
// quantos carros em cada modalidade e quanto vale o estoque potencial.
const MODALIDADES: { key: string; label: string; dot: string }[] = [
  { key: 'troca', label: 'Troca', dot: 'bg-amber-500' },
  { key: 'compra', label: 'Compra', dot: 'bg-emerald-500' },
  { key: 'intermediacao', label: 'Intermediação', dot: 'bg-sky-500' },
  { key: 'consignacao', label: 'Consignação', dot: 'bg-violet-500' },
  { key: 'anuncio_trafego', label: 'Anúncio c/ tráfego', dot: 'bg-rose-500' },
];

interface Row {
  modalidade: string | null;
  valor_avaliado: number | null;
  valor_pedido: number | null;
}

export function VehicleIntakeCard() {
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ['trade-in', 'bi-modalidades'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trade_in_vehicles')
        .select('modalidade, valor_avaliado, valor_pedido');
      if (error) throw error;
      return (data || []) as Row[];
    },
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const byMod: Record<string, { qtd: number; valor: number }> = {};
    let semModalidade = 0;
    let total = 0;
    let valorTotal = 0;
    for (const r of data || []) {
      total++;
      const valor = r.valor_avaliado ?? r.valor_pedido ?? 0;
      valorTotal += valor;
      if (r.modalidade) {
        byMod[r.modalidade] = byMod[r.modalidade] || { qtd: 0, valor: 0 };
        byMod[r.modalidade].qtd++;
        byMod[r.modalidade].valor += valor;
      } else {
        semModalidade++;
      }
    }
    return { byMod, semModalidade, total, valorTotal };
  }, [data]);

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <Car className="h-4 w-4 text-amber-500" /> Captação de Veículos
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
            Nenhum veículo de cliente registrado ainda. Registre no card "Veículo na
            Troca/Compra" dentro do lead.
          </p>
        ) : (
          <>
            {MODALIDADES.map((m) => {
              const s = stats.byMod[m.key];
              if (!s) return null;
              return (
                <button
                  key={m.key}
                  className="w-full flex items-center justify-between text-xs rounded-md px-2 py-1.5 hover:bg-muted/60 transition-colors"
                  onClick={() => navigate(`/comercial/pipeline?modalidade=${m.key}`)}
                  title="Ver no pipeline"
                >
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${m.dot}`} />
                    {m.label}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
