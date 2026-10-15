/**
 * CARD DA SIMULAÇÃO (2026-10-15, ideia do Marco): quando o cliente pede parcela, a Nina
 * "roda o simulador" e manda uma IMAGEM com o carro e a conta — prova visual, não número
 * solto. Desenhado em SVG e convertido pra PNG com resvg (wasm) na própria edge function.
 *
 * Regras: só reais (nunca taxa), nunca valor do carro do cliente na troca (trava), sempre
 * "estimativa — condição final com a Grazi e os bancos". Entrada mostrada como editável.
 */

export type CardInput = {
  titulo: string;               // "GWM Ora 03 GT Elétrico"
  subtitulo?: string | null;    // "2024 · 31.995 km · preto · Carapicuíba"
  preco: number;                // 145980
  entrada: number;              // 29196
  prazo: number;                // 48
  parcela: number;              // 3509.35
  outros?: Array<{ prazo: number; parcela: number }>;
  ultimaHoje?: number | null;   // antecipação: a última parcela paga hoje
  cupom?: { titulo: string; valor: number; economia_mes: number } | null;
  fotoDataUri?: string | null;  // data:image/jpeg;base64,...
  assinatura?: string;          // "Nina · Totex Motors"
  loja?: string | null;         // "Cardoso Veículos"
};

const W = 1080, H = 1420;
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const brl0 = (n: number) => "R$ " + Math.round(n).toLocaleString("pt-BR");

function fit(s: string, max: number): string {
  const t = String(s || "").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export function buildCardSvg(c: CardInput): string {
  const titulo = fit(c.titulo, 34);
  const sub = fit(c.subtitulo || "", 60);
  const outros = (c.outros || []).filter((o) => o.prazo !== c.prazo).slice(0, 3);
  const temFoto = !!c.fotoDataUri;
  const fotoH = 520;
  const y0 = 150; // topo da foto
  let y = y0 + fotoH + 40;

  const linhasOutros = outros.map((o) => `${o.prazo}x de ${brl0(o.parcela)}`).join("   ·   ");

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Roboto">`);
  parts.push(`<defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1220"/><stop offset="1" stop-color="#111c33"/></linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.78"/></linearGradient>
    <clipPath id="foto"><rect x="40" y="${y0}" width="${W - 80}" height="${fotoH}" rx="28"/></clipPath>
  </defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#g)"/>`);
  // topo
  parts.push(`<text x="40" y="78" font-size="30" font-weight="700" fill="#5eead4">SIMULADOR CARDOSO</text>`);
  parts.push(`<text x="40" y="118" font-size="24" fill="#94a3b8">simulação feita agora pela ${esc(c.assinatura || "Nina · Totex Motors")}</text>`);
  parts.push(`<text x="${W - 40}" y="78" text-anchor="end" font-size="24" fill="#94a3b8">${esc(new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }))}</text>`);
  // foto
  if (temFoto) {
    parts.push(`<image href="${c.fotoDataUri}" x="40" y="${y0}" width="${W - 80}" height="${fotoH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#foto)"/>`);
    parts.push(`<rect x="40" y="${y0}" width="${W - 80}" height="${fotoH}" rx="28" fill="url(#shade)"/>`);
  } else {
    parts.push(`<rect x="40" y="${y0}" width="${W - 80}" height="${fotoH}" rx="28" fill="#1e293b"/>`);
  }
  parts.push(`<text x="72" y="${y0 + fotoH - 76}" font-size="46" font-weight="700" fill="#ffffff">${esc(titulo)}</text>`);
  if (sub) parts.push(`<text x="72" y="${y0 + fotoH - 32}" font-size="26" fill="#cbd5e1">${esc(sub)}</text>`);
  // preço + entrada
  parts.push(`<text x="40" y="${y + 10}" font-size="26" fill="#94a3b8">Preço</text>`);
  parts.push(`<text x="40" y="${y + 58}" font-size="44" font-weight="700" fill="#ffffff">${esc(brl0(c.preco))}</text>`);
  parts.push(`<text x="${W - 40}" y="${y + 10}" text-anchor="end" font-size="26" fill="#94a3b8">Entrada (ajustável)</text>`);
  parts.push(`<text x="${W - 40}" y="${y + 58}" text-anchor="end" font-size="44" font-weight="700" fill="#ffffff">${esc(brl0(c.entrada))}</text>`);
  y += 110;
  // parcela destaque
  parts.push(`<rect x="40" y="${y}" width="${W - 80}" height="200" rx="28" fill="#0f766e"/>`);
  parts.push(`<text x="72" y="${y + 58}" font-size="28" fill="#ccfbf1">${c.prazo}x de</text>`);
  parts.push(`<text x="72" y="${y + 150}" font-size="96" font-weight="800" fill="#ffffff">${esc(brl0(c.parcela))}</text>`);
  parts.push(`<text x="${W - 72}" y="${y + 150}" text-anchor="end" font-size="30" fill="#ccfbf1">por mês</text>`);
  y += 240;
  if (linhasOutros) {
    parts.push(`<text x="40" y="${y}" font-size="26" fill="#cbd5e1">Outros prazos:  ${esc(linhasOutros)}</text>`);
    y += 56;
  }
  // jogada do 13º
  if (c.ultimaHoje && c.ultimaHoje > 0) {
    parts.push(`<rect x="40" y="${y}" width="${W - 80}" height="156" rx="22" fill="#1e293b" stroke="#334155"/>`);
    parts.push(`<text x="72" y="${y + 50}" font-size="28" font-weight="700" fill="#fde68a">A jogada do décimo terceiro</text>`);
    parts.push(`<text x="72" y="${y + 92}" font-size="26" fill="#e2e8f0">Pagando a parcela do mês junto com a última, a última sai por ${esc(brl0(c.ultimaHoje))}</text>`);
    parts.push(`<text x="72" y="${y + 128}" font-size="26" fill="#e2e8f0">em vez de ${esc(brl0(c.parcela))}, e somem duas parcelas do fim.</text>`);
    y += 186;
  }
  if (c.cupom && c.cupom.valor > 0) {
    parts.push(`<text x="40" y="${y + 10}" font-size="26" font-weight="700" fill="#86efac">${esc(c.cupom.titulo)}: ${esc(brl0(c.cupom.valor))} de bônus = ${esc(brl0(c.cupom.economia_mes))} a menos por mês</text>`);
    y += 60;
  }
  // rodapé
  parts.push(`<text x="40" y="${H - 70}" font-size="22" fill="#94a3b8">Estimativa de pré-atendimento${c.loja ? ` · ${esc(c.loja)}` : ""}. Condição final com a Grazi e os bancos parceiros.</text>`);
  parts.push(`<text x="40" y="${H - 38}" font-size="22" fill="#64748b">O carro na troca entra como entrada; o valor dele sai na avaliação presencial.</text>`);
  parts.push(`</svg>`);
  return parts.join("\n");
}

// ---------- PNG via resvg-wasm (carregado uma vez por isolate) ----------
let resvgReady: Promise<any> | null = null;
let fontsCache: Uint8Array[] | null = null;
const FONT_URLS = [
  "https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Regular.ttf",
  "https://cdn.jsdelivr.net/gh/googlefonts/roboto@main/src/hinted/Roboto-Bold.ttf",
];
const WASM_URL = "https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@2.6.2/index_bg.wasm";

async function loadResvg(): Promise<any> {
  if (!resvgReady) {
    resvgReady = (async () => {
      const mod: any = await import("npm:@resvg/resvg-wasm@2.6.2");
      const wasm = await fetch(WASM_URL).then((r) => r.arrayBuffer());
      try { await mod.initWasm(wasm); } catch (e) { if (!String(e).includes("Already initialized")) throw e; }
      return mod;
    })();
  }
  return resvgReady;
}
async function loadFonts(): Promise<Uint8Array[]> {
  if (!fontsCache) fontsCache = await Promise.all(FONT_URLS.map((u) => fetch(u).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b))));
  return fontsCache;
}

export async function renderCardPng(c: CardInput): Promise<Uint8Array> {
  const [mod, fonts] = await Promise.all([loadResvg(), loadFonts()]);
  const svg = buildCardSvg(c);
  const resvg = new mod.Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Roboto" } });
  const png = resvg.render().asPng();
  return png as Uint8Array;
}

/** Baixa a foto e devolve data URI (jpeg/png). null se falhar. */
export async function fotoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { headers: { Accept: "image/*" } });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > 6_000_000) return null;
    let bin = ""; const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}
