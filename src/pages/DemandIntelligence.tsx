/**
 * Inteligência de Demanda — /comercial/inteligencia
 *
 * Dashboard do comportamento do consumidor: veículos mais desejados (o que os
 * leads PEDEM na conversa x o que CLICAM no marketplace/totem), origem e
 * conversão, perfil de demanda (orçamento, financiamento, troca, urgência),
 * temperatura da base e SLA de resposta do agente.
 *
 * Fontes: vw_inteligencia_leads + vw_agent_sla_mensagens (security_invoker,
 * respeitam a RLS do tenant logado).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { BrainCircuit, Car, Flame, Timer, Users, Handshake, Banknote, Repeat } from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, LabelList, Cell,
} from "recharts";

// Paleta categórica validada (ordem fixa — não ciclar)
const CAT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];
const BLUE = "#2a78d6";

type Periodo = 7 | 30 | 90;

interface LeadIntel {
  id: string;
  created_at: string;
  origem: string | null;
  origem_marketplace: string | null;
  veiculo_clique: string | null;
  veiculo_conversa: string | null;
  faixa_preco_min: number | null;
  faixa_preco_max: number | null;
  precisa_financiar: boolean | null;
  entrada_disponivel: number | null;
  tem_veiculo_troca: boolean | null;
  forma_pagamento: string | null;
  urgencia: string | null;
  categoria: string | null;
  temperatura: string | null;
  interesse_test_drive: boolean;
  interesse_visita: boolean;
  encaminhado: boolean;
  sales_score: number | null;
  tem_perfil: boolean;
}

interface SlaRow {
  cliente_em: string;
  segundos_resposta: number | null;
  respondido: boolean;
}

// Normaliza nome de veículo: tira marca e ano, agrupa pelo modelo.
// "VolksWagen Polo" -> "Polo" | "onix 2013" -> "Onix" | "BMW X1" -> "X1"
const MARCAS = new Set([
  "volkswagen", "vw", "chevrolet", "gm", "fiat", "ford", "honda", "toyota",
  "hyundai", "renault", "nissan", "jeep", "bmw", "mercedes", "mercedes-benz",
  "audi", "citroen", "citroën", "peugeot", "kia", "mitsubishi", "suzuki",
]);
function normalizaVeiculo(raw: string | null): string | null {
  if (!raw) return null;
  const tokens = raw.trim().toLowerCase().replace(/\s+/g, " ").split(" ")
    .filter((t) => !/^(19|20)\d{2}$/.test(t));
  if (!tokens.length) return null;
  const rest = tokens.length > 1 && MARCAS.has(tokens[0]) ? tokens.slice(1) : tokens;
  const modelo = rest[0];
  if (!modelo) return null;
  return modelo.charAt(0).toUpperCase() + modelo.slice(1);
}

const URGENCIA_ORDEM = ["imediata", "ate_30_dias", "ate_90_dias", "pesquisando"];
const URGENCIA_LABEL: Record<string, string> = {
  imediata: "Imediata", ate_30_dias: "Até 30 dias",
  ate_90_dias: "Até 90 dias", pesquisando: "Pesquisando",
};
const TEMP_ORDEM = ["frio", "morno", "quente", "muito_quente"];
const TEMP_LABEL: Record<string, string> = {
  frio: "Frio", morno: "Morno", quente: "Quente", muito_quente: "Muito quente",
};
const PAGTO_LABEL: Record<string, string> = {
  a_vista: "À vista", financiamento: "Financiamento",
  consorcio: "Consórcio", misto: "Misto",
};

function contar<T>(rows: T[], chave: (r: T) => string | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = chave(r);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function KpiTile({ icon: Icon, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <div className="mt-1 text-2xl font-bold">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function GraficoBarras({ titulo, data, cor, cores, vazio }: {
  titulo: string;
  data: { nome: string; total: number }[];
  cor?: string;
  cores?: string[];
  vazio: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">{vazio}</div>
        ) : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 28, top: 4, bottom: 4 }}>
                <CartesianGrid horizontal={false} stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="nome" width={104}
                  tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                  contentStyle={{ borderRadius: 8, fontSize: 12 }}
                  formatter={(v: number) => [v, "leads"]}
                />
                <Bar dataKey="total" radius={[0, 4, 4, 0]} barSize={18}>
                  {data.map((_, i) => (
                    <Cell key={i} fill={cores ? cores[i % cores.length] : (cor || BLUE)} />
                  ))}
                  <LabelList dataKey="total" position="right" className="fill-foreground" fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function DemandIntelligence() {
  const [periodo, setPeriodo] = useState<Periodo>(30);

  const desde = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - periodo);
    return d.toISOString();
  }, [periodo]);

  const { data: leads, isLoading } = useQuery({
    queryKey: ["inteligencia-leads", periodo],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vw_inteligencia_leads")
        .select("*")
        .gte("created_at", desde)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data || []) as LeadIntel[];
    },
  });

  const { data: sla } = useQuery({
    queryKey: ["inteligencia-sla", periodo],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vw_agent_sla_mensagens")
        .select("cliente_em, segundos_resposta, respondido")
        .eq("channel", "whatsapp")
        .gte("cliente_em", desde)
        .limit(5000);
      if (error) throw error;
      return (data || []) as SlaRow[];
    },
  });

  const calc = useMemo(() => {
    const rows = leads || [];
    const total = rows.length;
    const comPerfil = rows.filter((r) => r.tem_perfil).length;
    const encaminhados = rows.filter((r) => r.encaminhado).length;
    const quentes = rows.filter((r) => r.temperatura === "quente" || r.temperatura === "muito_quente").length;
    const financia = rows.filter((r) => r.precisa_financiar === true).length;
    const financiaBase = rows.filter((r) => r.precisa_financiar !== null).length;
    const troca = rows.filter((r) => r.tem_veiculo_troca === true).length;
    const trocaBase = rows.filter((r) => r.tem_veiculo_troca !== null).length;
    const testDrive = rows.filter((r) => r.interesse_test_drive || r.interesse_visita).length;

    // Veículos desejados: conversa (o que pediu) + clique (o que olhou)
    const desejo = contar(rows, (r) => normalizaVeiculo(r.veiculo_conversa) ?? normalizaVeiculo(r.veiculo_clique));
    const topVeiculos = [...desejo.entries()]
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    const origens = [...contar(rows, (r) => r.origem).entries()]
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);

    const urgencias = URGENCIA_ORDEM
      .map((u) => ({ nome: URGENCIA_LABEL[u], total: rows.filter((r) => r.urgencia === u).length }))
      .filter((x) => x.total > 0);

    const temperaturas = TEMP_ORDEM
      .map((t) => ({ nome: TEMP_LABEL[t], total: rows.filter((r) => r.temperatura === t).length }))
      .filter((x) => x.total > 0);

    const pagamentos = [...contar(rows, (r) => r.forma_pagamento ? (PAGTO_LABEL[r.forma_pagamento] || r.forma_pagamento) : null).entries()]
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total);

    const orcs = rows.map((r) => r.faixa_preco_max).filter((v): v is number => v != null && v > 0);
    const orcMedio = orcs.length ? orcs.reduce((s, v) => s + v, 0) / orcs.length : null;

    return {
      total, comPerfil, encaminhados, quentes, financia, financiaBase,
      troca, trocaBase, testDrive, topVeiculos, origens, urgencias,
      temperaturas, pagamentos, orcMedio,
    };
  }, [leads]);

  const slaCalc = useMemo(() => {
    const rows = sla || [];
    const respondidas = rows.filter((r) => r.respondido && r.segundos_resposta != null);
    const media = respondidas.length
      ? Math.round(respondidas.reduce((s, r) => s + (r.segundos_resposta || 0), 0) / respondidas.length)
      : null;
    const semResposta = rows.filter((r) => !r.respondido).length;
    return { media, semResposta, total: rows.length };
  }, [sla]);

  const pct = (n: number, base: number) => (base > 0 ? `${Math.round((n / base) * 100)}%` : "—");
  const brl = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

  return (
    <AppLayout>
      <div className="p-4 md:p-6 space-y-4 max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-primary" />
              Inteligência de Demanda
            </h1>
            <p className="text-sm text-muted-foreground">
              Comportamento dos consumidores: o que pedem, de onde vêm e como compram
            </p>
          </div>
          <div className="flex gap-1">
            {([7, 30, 90] as Periodo[]).map((p) => (
              <Button key={p} size="sm" variant={periodo === p ? "default" : "outline"} onClick={() => setPeriodo(p)}>
                {p} dias
              </Button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiTile icon={Users} label="Leads no período" value={String(calc.total)} />
              <KpiTile icon={Car} label="Com perfil de compra" value={pct(calc.comPerfil, calc.total)} sub={`${calc.comPerfil} leads qualificados`} />
              <KpiTile icon={Handshake} label="Encaminhados às lojas" value={pct(calc.encaminhados, calc.total)} sub={`${calc.encaminhados} repassados`} />
              <KpiTile icon={Flame} label="Quentes / muito quentes" value={String(calc.quentes)} sub={`${calc.testDrive} querem test drive/visita`} />
              <KpiTile icon={Banknote} label="Precisam financiar" value={pct(calc.financia, calc.financiaBase)} sub={calc.orcMedio ? `orçamento médio ${brl(calc.orcMedio)}` : undefined} />
              <KpiTile icon={Repeat} label="Têm carro na troca" value={pct(calc.troca, calc.trocaBase)} sub={`${calc.troca} com troca`} />
              <KpiTile icon={Timer} label="Tempo médio de resposta" value={slaCalc.media != null ? `${slaCalc.media}s` : "—"} sub={`${slaCalc.total} mensagens`} />
              <KpiTile icon={Timer} label="Sem resposta" value={String(slaCalc.semResposta)} sub="mensagens de clientes" />
            </div>

            {/* Gráficos */}
            <div className="grid md:grid-cols-2 gap-4">
              <GraficoBarras titulo="🚗 Veículos mais desejados (pedido na conversa + clique)"
                data={calc.topVeiculos} cor={BLUE}
                vazio="Sem veículos identificados no período" />
              <GraficoBarras titulo="Origem dos leads"
                data={calc.origens} cores={CAT}
                vazio="Sem leads no período" />
              <GraficoBarras titulo="Urgência de compra (declarada na conversa)"
                data={calc.urgencias} cor="#eb6834"
                vazio="Nenhuma urgência capturada ainda" />
              <GraficoBarras titulo="Temperatura (qualificação do agente)"
                data={calc.temperaturas} cor="#e34948"
                vazio="Nenhum lead qualificado por temperatura ainda" />
              <GraficoBarras titulo="Forma de pagamento pretendida"
                data={calc.pagamentos} cores={CAT}
                vazio="Nenhuma forma de pagamento capturada ainda" />
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
