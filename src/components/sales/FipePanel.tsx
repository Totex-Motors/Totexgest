import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Car, TrendingDown, TrendingUp, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFipeLookup, formatBRLCents, formatFipeRef, type FipeCandidato } from "@/hooks/useFipeLookup";

interface Props {
  marca?: string | null;
  modelo?: string | null;
  ano?: number | string | null;
  combustivel?: string | null;
  placa?: string | null;
  /** Passe pra gravar o snapshot da negociação (captação). Sem isso, é só consulta. */
  leadId?: string;
  sellerVehicleId?: string;
  /** Consulta automática quando tiver marca+modelo+ano. Default true. */
  auto?: boolean;
  className?: string;
}

export function FipePanel({ marca, modelo, ano, combustivel, placa, leadId, sellerVehicleId, auto = true, className }: Props) {
  const fipe = useFipeLookup();
  const [result, setResult] = useState<Awaited<ReturnType<typeof fipe.mutateAsync>> | null>(null);
  const lastKey = useRef<string>("");

  const anoNum = ano != null && String(ano).trim() !== "" ? Number(ano) : null;
  const canLookup = !!(modelo && anoNum);
  const key = `${marca ?? ""}|${modelo ?? ""}|${anoNum ?? ""}|${combustivel ?? ""}`;

  const run = async (confirmar?: FipeCandidato) => {
    try {
      const r = await fipe.mutateAsync({
        marca: marca ?? undefined,
        modelo: modelo ?? undefined,
        ano: anoNum ?? undefined,
        combustivel: combustivel ?? undefined,
        placa: placa ?? undefined,
        lead_id: leadId,
        seller_vehicle_id: sellerVehicleId,
        confirmar: confirmar
          ? { codigo_fipe: confirmar.codigo_fipe, model_slug: confirmar.model_slug, fuel_acronym: confirmar.fuel_acronym, nome_modelo: confirmar.nome_modelo }
          : undefined,
      });
      setResult(r);
    } catch {
      setResult(null);
    }
  };

  // auto-consulta quando os dados do veículo mudam
  useEffect(() => {
    if (!auto || !canLookup) return;
    if (lastKey.current === key) return;
    lastKey.current = key;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, auto, canLookup]);

  if (!canLookup) return null;

  const loading = fipe.isPending;
  const a = result?.analise;
  const dep = a?.depreciacao_anual_pct;
  const ret = a?.retencao_valor_pct;

  return (
    <Card className={cn("border-blue-200/60 bg-blue-50/40 dark:bg-blue-950/20", className)}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
            <Car className="h-3.5 w-3.5" /> Tabela FIPE
          </div>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { lastKey.current = ""; void run(); }} disabled={loading} title="Atualizar FIPE">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {loading && !result && (
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Consultando FIPE…</p>
        )}

        {/* precisa confirmar o modelo */}
        {result?.precisa_confirmar_modelo && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Confirme o modelo exato:</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {result.candidatos.map((c, i) => (
                <button
                  key={i}
                  onClick={() => run(c)}
                  className="w-full text-left text-xs rounded-md border border-border/60 bg-background px-2 py-1.5 hover:border-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/40"
                >
                  <span className="font-medium">{c.nome_modelo}</span>{" "}
                  <span className="text-muted-foreground">{c.ano_modelo}{c.valor_centavos != null ? ` · ${formatBRLCents(c.valor_centavos)}` : ""}</span>
                </button>
              ))}
              {result.candidatos.length === 0 && <p className="text-xs text-muted-foreground">Nenhum modelo encontrado. Revise marca/modelo/ano.</p>}
            </div>
          </div>
        )}

        {/* preço + análise */}
        {result?.preco?.valor_centavos != null && !result.precisa_confirmar_modelo && (
          <>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-lg font-bold text-blue-700 dark:text-blue-300 leading-tight">{formatBRLCents(result.preco.valor_centavos)}</p>
                <p className="text-[10px] text-muted-foreground">FIPE {formatFipeRef(result.preco.mes_referencia)}{result.fonte === "fipe_oficial" ? " · fonte oficial" : ""}</p>
              </div>
              {result.veiculo?.codigo_fipe && (
                <Badge variant="outline" className="text-[10px]">cód. {result.veiculo.codigo_fipe}</Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              {dep != null && (
                <div className="rounded-md bg-background/70 p-1.5">
                  <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                    {dep <= 0 ? <TrendingDown className="h-3 w-3 text-red-500" /> : <TrendingUp className="h-3 w-3 text-emerald-500" />} Depreciação/ano
                  </p>
                  <p className={cn("text-sm font-semibold", dep <= 0 ? "text-red-600" : "text-emerald-600")}>{dep > 0 ? "+" : ""}{dep}%</p>
                </div>
              )}
              {ret != null && (
                <div className="rounded-md bg-background/70 p-1.5">
                  <p className="text-[10px] text-muted-foreground">Retenção de valor</p>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{ret}%</p>
                </div>
              )}
            </div>

            {a?.anomalia && a.anomalia !== "normal" && (
              <p className="text-[11px] text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Preço fora do padrão da categoria ({a.anomalia}).</p>
            )}
          </>
        )}

        {/* sem preço */}
        {result && !result.precisa_confirmar_modelo && result.preco?.valor_centavos == null && !loading && (
          <p className="text-xs text-muted-foreground">{result.motivo ?? "Não encontrei o preço FIPE deste veículo."}</p>
        )}
      </CardContent>
    </Card>
  );
}
