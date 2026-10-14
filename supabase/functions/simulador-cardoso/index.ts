/**
 * simulador-cardoso — porta ÚNICA do Totexgest pro Simulador da Cardoso
 * (https://simulador.grupocardoso.online — PHP 7.4, sem banco, dados em JSON).
 *
 * Regras do dono do simulador (API.md, 14/10/2026), que esta função respeita:
 *  - formula.json é a configuração viva: LÊ, nunca escreve.
 *  - CPF, renda, CNH e dado bancário NUNCA passam por aqui.
 *  - Endpoints são POST com JSON; estoque.php e formula.json são GET públicos.
 *  - O token de aparelho (48 hex) só cria/corrige atendimento e muda status; nunca lê a fila.
 *    Vem da config SIMULADOR_CARDOSO_TOKEN (gerado pelo gerente no painel: aparelho-liberar).
 *
 * Ações (POST { action, ... }; JWT do CRM ou service role):
 *  - formula        → coeficientes, prazo em destaque, cupons de campanha ativos, condição, horário
 *  - simular        → { veiculo, entrada?, usado?, bonus?, prazo? } → parcela por prazo (fórmula da
 *                     planilha: (V + coef·V) / prazo), economia mensal do bônus, e a "jogada" de
 *                     antecipar (parcela do mês + a última) em R$ — nunca em % de taxa.
 *  - estoque        → pátio da Cardoso pelo feed Autoconf (id, título, preço, FIPE, url)
 *  - plano          → saída PRONTA PRA AGENTE (voz ou texto): acha o carro no pátio pelo nome se não
 *                     vier o valor, simula, e devolve "fala" + "regras" (só reais, nunca taxa).
 *                     Formato do agente V2 ({ arguments: {...} }) cai aqui por padrão.
 *  - registrar_atendimento → cria o atendimento na fila de retorno da loja (token)
 *  - mudar_atendimento     → status/obs/motivo/toque de um atendimento (token)
 *
 * Quem usa: tools dos agentes (simular_plano), reaquecimento, e a tela do lead.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { getIntegrationKey } from "../_shared/config.ts";

const BASE_DEFAULT = "https://simulador.grupocardoso.online";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

type Coef = { p: number; c: number };
type Formula = {
  coefs: Coef[]; destaque: number;
  cupons: Array<{ codigo: string; titulo: string; sub: string; valor: number; validade: string; ativo: boolean; banner: boolean }>;
  condicao: Record<string, unknown> | null; loja: { semana: string; sabado: string } | null; freio: number; atualizadoEm?: string;
};

let formulaCache: { at: number; f: Formula } | null = null;
let estoqueCache: { at: number; carros: any[]; de: string } | null = null;

async function base(sb: any): Promise<string> {
  return String((await getIntegrationKey(sb, "SIMULADOR_CARDOSO_URL")) || BASE_DEFAULT).replace(/\/$/, "");
}

/** formula.json é público e sem cache no servidor; aqui guardamos 5 min. */
async function lerFormula(sb: any): Promise<Formula> {
  if (formulaCache && Date.now() - formulaCache.at < 300_000) return formulaCache.f;
  const r = await fetch(`${await base(sb)}/formula.json?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`formula.json ${r.status}`);
  const d = await r.json();
  const hoje = new Date().toISOString().slice(0, 10);
  const f: Formula = {
    coefs: (Array.isArray(d.coefs) ? d.coefs : []).map((x: any) => ({ p: Number(x.p), c: Number(x.c) })).filter((x: Coef) => x.p > 0 && x.c >= 0).sort((a: Coef, b: Coef) => b.p - a.p),
    destaque: Number(d.destaque) || 0,
    cupons: (Array.isArray(d.cupons) ? d.cupons : []).filter((c: any) => c && c.ativo !== false && Number(c.valor) > 0 && (!c.validade || c.validade >= hoje)),
    condicao: d.condicao && d.condicao.ativa ? d.condicao : null,
    loja: d.loja || null,
    freio: Number(d.freio) || 150,
    atualizadoEm: d.atualizadoEm,
  };
  if (!f.coefs.length) throw new Error("formula.json sem coeficientes");
  formulaCache = { at: Date.now(), f };
  return f;
}

async function lerEstoque(sb: any): Promise<{ carros: any[]; de: string }> {
  if (estoqueCache && Date.now() - estoqueCache.at < 300_000) return estoqueCache;
  const r = await fetch(`${await base(sb)}/estoque.php`);
  if (!r.ok) throw new Error(`estoque.php ${r.status}`);
  const d = await r.json();
  const carros = Array.isArray(d.carros) ? d.carros : [];
  estoqueCache = { at: Date.now(), carros, de: String(d.fonte || d.de || "") };
  return estoqueCache;
}

/**
 * Acha o carro no pátio pelo nome (2026-10-14, 1ª rodada do reaquecimento): "Nissan VERSA SR
 * 1.6 16V Flex Aut." casava com o GWM Tank 300 (1º do feed) porque "16V" e "Aut." batem em
 * qualquer carro — e o cliente recebeu "Versa por 10.399 reais por mês". Agora: tokens de
 * versão/motor/câmbio/ano são ruído; a marca conta ponto mas não basta; precisa bater pelo
 * menos uma palavra de MODELO; ganha quem bate mais tokens. Sem modelo batendo = não achou.
 */
const norm = (s: unknown) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const RUIDO = /^(\d+([.,]\d+)?|\d+v|20\d\d|flex|aut\.?|automatico|automatica|manual|mec|turbo|tb|awd|4x4|4x2|hibrido|eletrico|diesel|gasolina|cvt|tiptronic|at|mt|gnv|\d+p|\dp|sedan|seda|hatch|suv|cab|dupla|simples)$/;
const MARCAS = new Set(["nissan", "gwm", "byd", "bmw", "audi", "toyota", "honda", "hyundai", "chevrolet", "fiat", "volkswagen", "vw", "jeep", "renault", "peugeot", "citroen", "ford", "kia", "mercedes", "mercedes-benz", "volvo", "land", "rover", "mitsubishi", "caoa", "chery", "jac", "mini", "porsche", "ram", "subaru", "suzuki", "lexus", "jaguar", "dodge", "troller", "omoda", "jaecoo", "haval", "neta", "seres", "zeekr", "tesla"]);
export function acharCarro(carros: any[], texto: string): { carro: any; exato: boolean } | null {
  const q = norm(texto).replace(/\btanque\b/g, "tank").replace(/\b(hora|aurora)\b/g, "ora").replace(/[()\[\],;:]/g, " ");
  const toks = [...new Set(q.split(/\s+/).map((t) => t.replace(/\.$/, "")).filter((t) => t.length >= 2 && !RUIDO.test(t)))];
  const modelo = toks.filter((t) => !MARCAS.has(t));
  if (!toks.length) return null;
  let best: { carro: any; score: number; modeloHit: boolean } | null = null;
  for (const c of carros) {
    const t = ` ${norm(`${c.titulo} ${c.marca} ${c.modelo}`)} `;
    const bate = (k: string) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t); // começo de palavra
    const hits = toks.filter(bate);
    const modeloHit = modelo.some(bate);
    if (!modeloHit) continue;
    const score = hits.length;
    if (!best || score > best.score) best = { carro: c, score, modeloHit };
  }
  if (!best) return null;
  return { carro: best.carro, exato: best.score === toks.length };
}

// ---- a fórmula da planilha (igual ao index.html) ----
const parcelaDe = (v: number, p: number, c: number) => (p > 0 ? (v + c * v) / p : 0);
/** taxa mensal equivalente (Price) — USO INTERNO pra conta da antecipação; nunca sai pro cliente */
function juroEquivalente(pv: number, pmt: number, n: number): number | null {
  if (!(pv > 0) || !(pmt > 0) || !(n > 0)) return null;
  const f = (i: number) => (i === 0 ? pmt * n - pv : pmt * (1 - Math.pow(1 + i, -n)) / i - pv);
  if (f(0) <= 0) return 0;
  let lo = 0, hi = 1;
  if (f(hi) > 0) return null;
  for (let k = 0; k < 120; k++) { const m = (lo + hi) / 2; if (f(m) > 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

function simular(f: Formula, a: { veiculo: number; entrada?: number; usado?: number; bonus?: number; prazo?: number; extra?: number }) {
  const veiculo = Math.max(0, Number(a.veiculo) || 0);
  const entrada = Math.max(0, Number(a.entrada ?? Math.round(veiculo * 0.2)) || 0);
  const usado = Math.max(0, Number(a.usado) || 0);
  const bonus = Math.max(0, Number(a.bonus) || 0);
  const financiado = Math.max(0, veiculo - entrada - usado - bonus);
  const baseSemBonus = Math.max(0, veiculo - entrada - usado);
  const prazoFoco = f.coefs.find((c) => c.p === Number(a.prazo))?.p || f.destaque || f.coefs[0].p;

  const prazos = f.coefs.map((c) => {
    const pmt = parcelaDe(financiado, c.p, c.c);
    return {
      prazo: c.p, parcela: r2(pmt), total: r2(pmt * c.p), custo: r2(pmt * c.p - financiado),
      economia_bonus_mes: bonus > 0 ? r2(parcelaDe(baseSemBonus, c.p, c.c) - pmt) : 0,
      destaque: c.p === prazoFoco,
    };
  });
  const foco = prazos.find((p) => p.destaque)!;

  // "A jogada que quase ninguém faz": parcela do mês + a última, pelo valor presente na taxa
  // equivalente do próprio contrato (Resolução CMN 5.004/2022). Só R$ — a taxa fica aqui dentro.
  let antecipacao: Record<string, unknown> | null = null;
  const i = juroEquivalente(financiado, foco.parcela, foco.prazo);
  if (i && i > 0 && foco.prazo > 1) {
    const ultimaHoje = foco.parcela / Math.pow(1 + i, foco.prazo - 1); // última parcela trazida pra hoje (1 mês após o início)
    const vpTotal = foco.parcela * (1 - Math.pow(1 + i, -foco.prazo)) / i;
    const extra = Math.max(0, Number(a.extra) || 0); // ex.: 13º, férias, PLR, FGTS
    const parcelasQueOExtraElimina = extra > 0 ? Math.min(foco.prazo - 1, Math.floor(extra / ultimaHoje)) : 0;
    antecipacao = {
      parcela_normal: r2(foco.parcela),
      ultima_parcela_hoje: r2(ultimaHoje),
      desembolso_mes_mais_ultima: r2(foco.parcela + ultimaHoje),
      prestacoes_eliminadas: r2(foco.parcela * 2),
      economia_ultima: r2(foco.parcela - ultimaHoje),
      quitacao_total_hoje: r2(vpTotal),
      juros_futuros_que_somem: r2(foco.parcela * foco.prazo - vpTotal),
      ...(extra > 0 ? { extra, parcelas_do_fim_que_o_extra_elimina: parcelasQueOExtraElimina, economia_do_extra: r2(parcelasQueOExtraElimina * foco.parcela - Math.min(extra, parcelasQueOExtraElimina * ultimaHoje)) } : {}),
      aviso: "Ordem de grandeza pelos juros remuneratórios. IOF, seguro e tarifas podem mudar o valor oficial do banco.",
    };
  }

  const cupomBanner = f.cupons.find((c) => c.banner) || f.cupons[0] || null;
  return {
    entrada: { veiculo, entrada, usado, bonus, financiado },
    prazo_destaque: prazoFoco,
    prazos,
    cupom_campanha: cupomBanner ? { codigo: cupomBanner.codigo, titulo: cupomBanner.titulo, valor: cupomBanner.valor, economia_mes_no_destaque: r2(parcelaDe(Math.max(0, baseSemBonus), foco.prazo, f.coefs.find((c) => c.p === foco.prazo)!.c) - parcelaDe(Math.max(0, baseSemBonus - cupomBanner.valor), foco.prazo, f.coefs.find((c) => c.p === foco.prazo)!.c)) } : null,
    condicao: f.condicao,
    antecipacao,
    fala: `${foco.prazo} parcelas de ${brl(foco.parcela)}${antecipacao ? `; a última, paga hoje junto com a do mês, sai por ${brl((antecipacao as any).ultima_parcela_hoje)}` : ""}`,
    aviso: "Simulação de pré-atendimento. Nenhum valor é proposta de crédito nem garante aprovação.",
  };
}

async function postSimulador(sb: any, script: string, body: Record<string, unknown>) {
  const r = await fetch(`${await base(sb)}/${script}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({ ok: false, erro: `resposta inválida (${r.status})` }));
  if (!r.ok || d?.ok === false) throw new Error(String(d?.erro || `${script} ${r.status}`));
  return d;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  // auth: JWT de usuário do CRM OU service role (chamadas internas de agentes/crons)
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (!bearer) return json({ error: "sem autenticação" }, 401);
  if (bearer !== SERVICE_KEY) {
    const uc = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await uc.auth.getUser();
    if (!user) return json({ error: "sessão inválida" }, 401);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const raw = await req.json().catch(() => ({})) as Record<string, any>;
  // agente V2 (agent-runner) manda { arguments, session_id, user_id } → vira ação "plano"
  const body: Record<string, any> = raw.arguments && typeof raw.arguments === "object" ? { action: "plano", ...raw.arguments } : raw;
  const action = String(body.action || "simular");
  try {
    switch (action) {
      case "formula": {
        const f = await lerFormula(sb);
        return json({ ok: true, ...f });
      }
      case "simular": {
        if (!(Number(body.veiculo) > 0)) return json({ error: "informe veiculo (valor do carro)" }, 400);
        const f = await lerFormula(sb);
        return json({ ok: true, ...simular(f, body as any) });
      }
      case "plano": {
        let valor = Number(body.valor || body.veiculo || body.preco) || 0;
        let carro = String(body.carro || "").trim();
        const pedido = carro;
        let exato: boolean | null = null;
        if (!valor && carro) {
          const e = await lerEstoque(sb);
          const m = acharCarro(e.carros, carro);
          if (m) { valor = Number(m.carro.preco) || 0; carro = m.carro.titulo; exato = m.exato; }
        }
        if (!(valor > 0)) return json({ success: false, message: pedido ? `Não achei "${pedido}" no pátio da Cardoso agora. Confirme marca e modelo, ou me passe o valor do carro.` : "Informe o valor do carro, ou o nome dele pra eu achar no pátio da Cardoso." });
        const f = await lerFormula(sb);
        const sim = simular(f, { veiculo: valor, entrada: body.entrada, usado: body.carro_na_troca ?? body.usado, prazo: body.prazo, extra: body.extra });
        const foco = sim.prazos.find((p) => p.destaque) || sim.prazos[0];
        const fala = (n: number) => `${Math.round(n).toLocaleString("pt-BR")} reais`;
        const ant: any = sim.antecipacao;
        return json({
          success: true, carro: carro || null, carro_pedido: pedido || null, match_exato: exato, valor_carro: valor, entrada: sim.entrada.entrada, carro_na_troca: sim.entrada.usado, financiado: sim.entrada.financiado,
          plano: { prazo: foco.prazo, parcela: foco.parcela, outros_prazos: sim.prazos.filter((p) => !p.destaque).map((p) => `${p.prazo}x de ${fala(p.parcela)}`).join("; ") },
          antecipacao: ant ? { ultima_parcela_hoje: ant.ultima_parcela_hoje, desembolso_mes_mais_ultima: ant.desembolso_mes_mais_ultima, elimina_de_prestacoes: ant.prestacoes_eliminadas, ...(ant.extra ? { extra: ant.extra, parcelas_do_fim_que_o_extra_elimina: ant.parcelas_do_fim_que_o_extra_elimina } : {}) } : null,
          cupom_campanha: sim.cupom_campanha ? { codigo: sim.cupom_campanha.codigo, titulo: sim.cupom_campanha.titulo, valor: sim.cupom_campanha.valor, economia_mes: sim.cupom_campanha.economia_mes_no_destaque } : null,
          condicao: sim.condicao ? { nome: (sim.condicao as any).nome, porque: (sim.condicao as any).porque, fim: (sim.condicao as any).fim } : null,
          fala: `Fica em ${foco.prazo} parcelas de ${fala(foco.parcela)}${ant ? `. E tem a jogada que quase ninguém faz: pagando a do mês junto com a última, a última sai por ${fala(ant.ultima_parcela_hoje)} em vez de ${fala(foco.parcela)}, e somem duas prestações` : ""}.`,
          regras: "Fale só em reais, nunca em taxa ou porcentagem. É estimativa de pré-atendimento: a Grazi fecha a condição real com os bancos. Mostre o ganho de subir de carro e a jogada de antecipar com décimo terceiro, férias ou PLR, com os números acima.",
        });
      }

      case "estoque": {
        const e = await lerEstoque(sb);
        const q = String(body.busca || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const lista = q ? e.carros.filter((c) => `${c.titulo} ${c.marca} ${c.modelo} ${c.ano}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(q)) : e.carros;
        return json({ ok: true, de: e.de, total: lista.length, carros: lista.slice(0, Number(body.limite) || 20).map((c) => ({ id: c.id, titulo: c.titulo, marca: c.marca, modelo: c.modelo, ano: c.ano, km: c.km, preco: c.preco, fipe: c.fipe, url: c.url, publicado: c.publicado })) });
      }
      case "registrar_atendimento":
      case "mudar_atendimento": {
        const token = await getIntegrationKey(sb, "SIMULADOR_CARDOSO_TOKEN");
        if (!token || token.length !== 48) return json({ error: "SIMULADOR_CARDOSO_TOKEN não configurado (gere no painel do simulador: aparelho-liberar)" }, 400);
        if (action === "registrar_atendimento") {
          const d = body.dados || {};
          // só o que a fila aceita — nunca CPF/renda/CNH/banco
          const dados = {
            nome: String(d.nome || "").slice(0, 60), fone: String(d.fone || "").replace(/\D/g, "").replace(/^55/, ""),
            vendedor: String(d.vendedor || "Agente Totex").slice(0, 40), carro: String(d.carro || "").slice(0, 90), carroUrl: String(d.carroUrl || ""),
            veiculo: Number(d.veiculo) || 0, entrada: Number(d.entrada) || 0, usado: Number(d.usado) || 0, bonus: Number(d.bonus) || 0,
            financiado: Number(d.financiado) || 0, prazo: Number(d.prazo) || 48, parcela: Number(d.parcela) || 0,
            cupom: String(d.cupom || "").toUpperCase().slice(0, 24), combinado: Number(d.combinado) || 0, combinadoEm: d.combinado ? Math.floor(Date.now() / 1000) : 0,
            status: "aguardando", obs: String(d.obs || "").slice(0, 300),
          };
          const r = await postSimulador(sb, "atendimentos.php", { acao: "registrar", token, dados });
          return json({ ok: true, id: r.id });
        }
        const { id, status, obs, motivo, resposta, toque } = body;
        const r = await postSimulador(sb, "atendimentos.php", { acao: "mudar", token, id, ...(status ? { status } : {}), ...(obs !== undefined ? { obs } : {}), ...(motivo !== undefined ? { motivo } : {}), ...(resposta !== undefined ? { resposta } : {}), ...(toque ? { toque: true } : {}) });
        return json({ ok: true, ...r });
      }
      default:
        return json({ error: `ação desconhecida: ${action}`, acoes: ["formula", "simular", "estoque", "registrar_atendimento", "mudar_atendimento"] }, 400);
    }
  } catch (e) {
    console.error("[simulador-cardoso]", action, (e as Error).message);
    return json({ ok: false, error: (e as Error).message }, 502);
  }
});
