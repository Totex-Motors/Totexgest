// ============================================================================
// ENCOMENDAS — grupo de compra/encomenda (Marco, 11/11/2026)
//
// O TotexCar (instância UAZAPI, admin do grupo) lê cada mensagem do grupo de encomenda.
// Se for um PEDIDO de carro ("procuro Onix 2020 a 2022 até 70 mil"), a IA extrai marca,
// modelo, faixa de ano e preço; o sistema busca no marketplace totexmotors.com (API pública)
// e, se achar carro que bate, RESPONDE NO GRUPO citando o pedido, com o link de cada carro.
// Sem carro: o pedido fica registrado (status sem_carro) pra fila/relatório de demanda.
//
// Regras: só posta em GRUPO (guarda uazapiTargetAllowed antes de todo /send); nunca fala
// em valor de troca/avaliação, taxa de juros nem escassez; a busca é feita no código
// (a IA só interpreta o pedido). Tabelas: encomenda_grupos (config) e encomenda_pedidos (log).
// ============================================================================

import { getIntegrationKey } from "./config.ts";
import { uazapiTargetAllowed } from "./wa-policy.ts";

// deno-lint-ignore no-explicit-any
type Sb = any;

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE = "https://totexmotors.com";
const MIN_TEXT_LEN = 8;
const MAX_RESPOSTAS_HORA = 30;

export interface EncomendaInput {
  instanceId: string;
  tenantId: string | null;
  groupJid: string;
  messageId: string;
  text: string;
  senderName?: string;
  senderPhone?: string;
}

interface GrupoConfig {
  id: string;
  tenant_id: string | null;
  instance_id: string;
  group_jid: string;
  group_name: string | null;
  active: boolean;
  ano_tolerancia: number;
  preco_folga_pct: number;
  max_carros: number;
  model: string | null;
}

interface Pedido {
  isPedido: boolean;
  marca: string | null;
  modelo: string | null;
  anoMin: number | null;
  anoMax: number | null;
  precoMax: number | null;
  cambio: string | null;
  observacao: string | null;
}

interface Carro {
  id: string;
  titulo: string;
  ano: number | null;
  preco: number | null;
  km: number | null;
  cidade: string | null;
  estado: string | null;
  link: string;
}

const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const normJid = (j: string | null | undefined) => String(j || "").trim().toLowerCase();
const brl = (n: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);

/**
 * true = a mensagem é do grupo de encomenda monitorado (o webhook para aqui, não vira ticket).
 * false = não é grupo de encomenda; o fluxo normal segue.
 */
export async function maybeHandleEncomenda(sb: Sb, input: EncomendaInput): Promise<boolean> {
  const jid = normJid(input.groupJid);
  if (!jid.endsWith("@g.us")) return false;

  const { data: grupos } = await sb.from("encomenda_grupos")
    .select("*").eq("instance_id", input.instanceId).eq("active", true);
  const cfg = (grupos as GrupoConfig[] | null)?.find((g) => normJid(g.group_jid) === jid);
  if (!cfg) return false;

  const text = (input.text || "").trim();
  if (text.length < MIN_TEXT_LEN) return true; // "bom dia", figurinha… engole

  // Idempotência (o webhook pode chegar repetido)
  const { data: existe } = await sb.from("encomenda_pedidos")
    .select("id").eq("grupo_id", cfg.id).eq("source_message_id", input.messageId).maybeSingle();
  if (existe) return true;

  try {
    await processar(sb, cfg, input, text);
  } catch (e) {
    console.error("[encomendas] falha:", (e as Error).message);
    await registrar(sb, cfg, input, text, null, { status: "erro", erro: (e as Error).message });
  }
  return true;
}

async function processar(sb: Sb, cfg: GrupoConfig, input: EncomendaInput, text: string): Promise<void> {
  const apiKey = await getIntegrationKey(sb, "ANTHROPIC_API_KEY", cfg.tenant_id ?? input.tenantId);
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY não configurada");

  const pedido = await interpretar(apiKey, cfg.model, text);
  if (!pedido || !pedido.isPedido || !pedido.modelo) {
    await registrar(sb, cfg, input, text, pedido, { status: "ignorado" });
    return;
  }

  const carros = await buscarMarketplace(sb, cfg, pedido);
  if (carros.length === 0) {
    await registrar(sb, cfg, input, text, pedido, { status: "sem_carro", carros: [] });
    return;
  }

  // Freio: no máximo N respostas por hora no grupo
  const umaHora = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await sb.from("encomenda_pedidos")
    .select("id", { count: "exact", head: true })
    .eq("grupo_id", cfg.id).eq("status", "respondido").gte("respondido_at", umaHora);
  if ((count ?? 0) >= MAX_RESPOSTAS_HORA) {
    await registrar(sb, cfg, input, text, pedido, { status: "sem_resposta", carros, erro: "limite de respostas por hora" });
    return;
  }

  const resposta = montarResposta(input.senderName, pedido, carros);

  const { data: inst } = await sb.from("whatsapp_instances")
    .select("id, api_url, api_key, provider, group_only").eq("id", cfg.instance_id).single();
  const apiUrl = String(inst?.api_url || "").replace(/\/$/, "");
  if (!inst || !apiUrl || !inst.api_key) throw new Error("instância sem credenciais UAZAPI");

  // Regra inviolável: UAZAPI só fala em grupo/canal
  const ok = await uazapiTargetAllowed(
    sb, { id: inst.id, provider: inst.provider, group_only: inst.group_only }, cfg.group_jid, "encomendas", resposta,
  );
  if (!ok) throw new Error("política bloqueou o alvo (não é grupo/canal)");

  const res = await fetch(`${apiUrl}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token: inst.api_key },
    body: JSON.stringify({ number: cfg.group_jid, text: resposta, replyid: input.messageId, linkPreview: true }),
  });
  if (!res.ok) throw new Error(`UAZAPI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  await registrar(sb, cfg, input, text, pedido, {
    status: "respondido", carros, resposta, respondido_at: new Date().toISOString(),
  });
  console.log(`[encomendas] respondido: ${pedido.modelo} → ${carros.length} carro(s)`);
}

// ─── IA: interpreta o pedido (só extrai; a busca e a resposta são do código) ──────────────

async function interpretar(apiKey: string, model: string | null, text: string): Promise<Pedido | null> {
  const anoAtual = new Date().getFullYear();
  const system =
    `Você lê mensagens de um grupo de WhatsApp de COMPRA/ENCOMENDA de carros. Diga se a mensagem é um ` +
    `PEDIDO (alguém procurando um carro pra comprar/encomendar) e extraia os dados.\n` +
    `- Venda/oferta de carro, saudação, conversa, foto sem pedido, resposta a outra pessoa → isPedido=false.\n` +
    `- marca e modelo como o mercado escreve (ex.: "Chevrolet", "Onix"; "Volkswagen", "T-Cross"). Sem modelo claro → modelo=null.\n` +
    `- Ano: "2020" → anoMin=2020, anoMax=2020; "2019 a 2021" → 2019/2021; "2020 pra cima" → anoMin=2020, anoMax=${anoAtual + 1}; sem ano → null.\n` +
    `- precoMax: teto em reais, só dígitos ("até 70 mil" → 70000). Sem teto → null.\n` +
    `- cambio: "automatico" | "manual" | null.\n` +
    `Responda SOMENTE com JSON: {"isPedido":true|false,"marca":string|null,"modelo":string|null,"anoMin":number|null,"anoMax":number|null,"precoMax":number|null,"cambio":string|null,"observacao":string|null}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: model || "claude-sonnet-4-6",
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: text.slice(0, 1500) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = String(data?.content?.[0]?.text ?? "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    const p = JSON.parse(raw.slice(s, e + 1));
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
    return {
      isPedido: p.isPedido === true,
      marca: typeof p.marca === "string" && p.marca.trim() ? p.marca.trim() : null,
      modelo: typeof p.modelo === "string" && p.modelo.trim() ? p.modelo.trim() : null,
      anoMin: num(p.anoMin), anoMax: num(p.anoMax), precoMax: num(p.precoMax),
      cambio: typeof p.cambio === "string" ? p.cambio : null,
      observacao: typeof p.observacao === "string" ? p.observacao : null,
    };
  } catch { return null; }
}

// ─── Busca no marketplace (API pública /api/vehicles) ───────────────────────────────────

async function buscarMarketplace(sb: Sb, cfg: GrupoConfig, p: Pedido): Promise<Carro[]> {
  const base = String((await getIntegrationKey(sb, "TOTEX_MARKETPLACE_API_URL")) || DEFAULT_BASE).replace(/\/$/, "");
  const tol = Math.max(0, Number(cfg.ano_tolerancia ?? 1));
  const folga = 1 + Math.max(0, Number(cfg.preco_folga_pct ?? 10)) / 100;

  const qs = new URLSearchParams();
  qs.set("search", p.modelo!);
  if (p.anoMin) qs.set("minYear", String(p.anoMin - tol));
  if (p.anoMax) qs.set("maxYear", String(p.anoMax + tol));
  if (p.precoMax) qs.set("maxPrice", String(Math.round(p.precoMax * folga)));
  qs.set("limit", "24");
  qs.set("sort", "price_asc");

  const res = await fetch(`${base}/api/vehicles?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`marketplace ${res.status}`);
  const data = await res.json();
  const lista: any[] = Array.isArray(data?.data) ? data.data : [];

  // A API casa por substring ("gol" traz "Golf"): exige cada palavra do modelo como palavra inteira.
  const palavras = norm(p.modelo!).split(/[\s/]+/).filter((t) => /^[a-z0-9-]{2,}$/.test(t) && !/^\d{4}$/.test(t));
  const querAuto = p.cambio ? /auto/i.test(p.cambio) : null; // null = tanto faz
  const alvoAno = p.anoMin && p.anoMax ? (p.anoMin + p.anoMax) / 2 : (p.anoMin ?? p.anoMax ?? null);

  const carros = lista
    .filter((v) => !v.status || String(v.status).toUpperCase() === "ACTIVE")
    .filter((v) => {
      // câmbio: automático aceita AUTOMATIC/CVT; manual só MANUAL; sem câmbio informado no carro, passa
      const t = String(v.transmission || "").toUpperCase();
      if (querAuto === true && t === "MANUAL") return false;
      if (querAuto === false && (t === "AUTOMATIC" || t === "CVT")) return false;
      const titulo = norm([v.brand, v.model, v.version].filter(Boolean).join(" "));
      return palavras.length > 0 && palavras.every((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(titulo));
    })
    .map((v) => ({
      id: String(v.id),
      titulo: [v.brand, v.model, v.version].filter(Boolean).map((x: string) => tituloBonito(String(x))).join(" "),
      ano: Number(v.year) || null,
      preco: Number.isFinite(Number(v.price)) ? Number(v.price) : null,
      km: Number.isFinite(Number(v.mileage)) ? Number(v.mileage) : null,
      cidade: v.city ?? null,
      estado: v.state ?? null,
      link: `${base}/veiculo/${v.id}`,
    }) as Carro);

  // Mais perto do ano pedido primeiro; empate → mais barato
  carros.sort((a, b) => {
    const da = alvoAno && a.ano ? Math.abs(a.ano - alvoAno) : 0;
    const db = alvoAno && b.ano ? Math.abs(b.ano - alvoAno) : 0;
    return da - db || (a.preco ?? 9e9) - (b.preco ?? 9e9);
  });
  return carros.slice(0, Math.max(1, Number(cfg.max_carros ?? 3)));
}

function tituloBonito(s: string): string {
  // "CHEVROLET ONIX 1.0 TURBO" → "Chevrolet Onix 1.0 Turbo" (siglas curtas ficam: LTZ, GTS, TSI)
  return s.split(/\s+/).map((w) => (/^[A-ZÀ-Ú]{4,}$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(" ");
}

function montarResposta(nome: string | undefined, p: Pedido, carros: Carro[]): string {
  const primeiro = String(nome || "").trim().split(/\s+/)[0];
  const quem = primeiro && !/^\d+$/.test(primeiro) ? `${primeiro}, ` : "";
  const linhas = carros.map((c) => {
    const det = [
      c.ano ? String(c.ano) : null,
      c.km != null ? `${c.km.toLocaleString("pt-BR")} km` : null,
      c.preco != null ? brl(c.preco) : null,
      c.cidade ? `${c.cidade}${c.estado ? "/" + c.estado : ""}` : null,
    ].filter(Boolean).join(" · ");
    return `🚗 *${c.titulo}*\n${det}\n👉 ${c.link}`;
  });
  const um = carros.length === 1;
  return (
    `🔎 ${quem}${um ? "encontrei no" : `encontrei ${carros.length} opções no`} *totexmotors.com* pro seu pedido de *${p.modelo}*:\n\n` +
    linhas.join("\n\n") +
    `\n\nQuer ver de perto ou fazer uma simulação? É só responder aqui.`
  );
}

async function registrar(
  sb: Sb, cfg: GrupoConfig, input: EncomendaInput, text: string, p: Pedido | null, extra: Record<string, unknown>,
): Promise<void> {
  try {
    await sb.from("encomenda_pedidos").upsert({
      tenant_id: cfg.tenant_id ?? input.tenantId ?? null,
      grupo_id: cfg.id,
      source_message_id: input.messageId,
      member_phone: input.senderPhone ?? null,
      member_name: input.senderName ?? null,
      raw_text: text.slice(0, 2000),
      marca: p?.marca ?? null,
      modelo: p?.modelo ?? null,
      ano_min: p?.anoMin ?? null,
      ano_max: p?.anoMax ?? null,
      preco_max: p?.precoMax ?? null,
      cambio: p?.cambio ?? null,
      observacao: p?.observacao ?? null,
      ...extra,
    }, { onConflict: "grupo_id,source_message_id" });
  } catch (e) {
    console.warn("[encomendas] log falhou:", (e as Error).message);
  }
}
