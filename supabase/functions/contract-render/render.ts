// Renderer "markdown-lite" → PDF (A4 retrato) com pdf-lib.
//
// Função pura: NÃO fala com banco nem rede. Recebe o body do template
// (contract_templates.body), o mapa de variáveis do snapshot
// (intermediation_contract_snapshot().variables) e metadados pro rodapé.
//
// Sintaxe suportada (uma construção por linha):
//   # Título            → 16pt bold centralizado
//   ## Seção            → 13pt bold
//   ### Cláusula        → 11pt bold com espaço acima
//   - item / • item     → bullet "•" com recuo
//   [[signature:owner]] → bloco de assinatura (linha horizontal ~250pt)
//   linha em branco     → espaço de parágrafo
//   qualquer outra      → parágrafo 10pt, quebra por largura
// Inline: **texto** vira bold; {{chave}} vira variables[chave] (ou "________________").
//
// Fontes padrão (Helvetica) usam WinAnsi: tudo que não existe nessa
// codificação é trocado por equivalente ASCII antes de desenhar, senão o
// pdf-lib lança erro no meio da renderização.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

export type Variables = Record<string, string | number | null | undefined>;

export interface RenderMeta {
  /** Código da intermediação (ex.: INT-2026-0001) — rodapé. */
  contractCode: string;
  /** Versão do documento que está sendo gerada — rodapé. */
  contractVersion: string | number;
  /** Versão do template jurídico — rodapé. */
  templateVersion: string | number;
  /** Título do PDF (metadado). Default: primeiro "# " do body. */
  title?: string;
  /** Produtor (metadado). */
  producer?: string;
  /** Marcador de campo vazio. Default "________________". */
  blank?: string;
}

export const DEFAULT_BLANK = "________________";

// ─── 1) Variáveis ─────────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;

/** Troca {{chave}} por variables[chave]; null/vazio vira `blank`. */
export function substituteVariables(body: string, variables: Variables, blank = DEFAULT_BLANK): string {
  return body.replace(VAR_RE, (_m, key: string) => {
    const raw = variables[key];
    if (raw === null || raw === undefined) return blank;
    const s = String(raw).trim();
    return s === "" ? blank : s;
  });
}

/** Lista as chaves {{...}} referenciadas no body (útil pra diagnóstico). */
export function listVariableKeys(body: string): string[] {
  const keys = new Set<string>();
  for (const m of body.matchAll(VAR_RE)) keys.add(m[1]);
  return [...keys];
}

// ─── 2) WinAnsi ───────────────────────────────────────────────────────────────

// cp1252: 0x20–0x7E, 0xA0–0xFF e o bloco 0x80–0x9F mapeado pra estes code points.
const WINANSI_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

// Substituições diretas pra caracteres comuns fora do WinAnsi.
const REPLACEMENTS: Record<string, string> = {
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  "​": "", "‌": "", "‍": "", "﻿": "", "­": "",
  "‐": "-", "‑": "-", "‒": "-", "―": "-", "−": "-", "⁃": "-",
  "′": "'", "″": '"', "‛": "'", "‟": '"',
  "→": "->", "←": "<-", "↔": "<->", "⇒": "=>",
  "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~", "∞": "inf.",
  "✓": "x", "✔": "x", "✗": "x", "✘": "x", "☐": "[ ]", "☑": "[x]", "☒": "[x]",
  "●": "•", "◦": "•", "▪": "•", "▫": "•", "‣": "•", "∙": "•", "‧": "·",
  "№": "No.", "℃": "°C", "℠": "SM", "©": "(c)", "®": "(R)",
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "ı": "i", "İ": "I",
};

function isWinAnsi(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WINANSI_EXTRA.has(cp);
}

/** Garante que só há caracteres codificáveis em WinAnsi (Helvetica padrão do pdf-lib). */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const cp = ch.codePointAt(0) ?? 0;
    const direct = REPLACEMENTS[ch];
    if (direct !== undefined) { out += direct; continue; } // nbsp/soft-hyphen estão no Latin-1 mas ficam melhor trocados
    if (isWinAnsi(cp)) { out += ch; continue; }
    if (ch === "\n" || ch === "\r") { out += ch; continue; } // quebras de linha são estrutura, o parser cuida
    if (ch === "\t") { out += "    "; continue; }
    if (cp < 0x20) continue; // demais controles
    // letra acentuada que não existe no WinAnsi → letra base (ő → o)
    const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (base && base !== ch && [...base].every((b) => isWinAnsi(b.codePointAt(0) ?? 0))) { out += base; continue; }
    // emoji e demais símbolos: some (não vira "?" no meio de contrato)
    if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || cp === 0xfe0f) continue;
    out += "?";
  }
  return out;
}

// ─── 3) Parser ────────────────────────────────────────────────────────────────

export type Block =
  | { kind: "h1" | "h2" | "h3" | "p" | "li"; runs: Run[] }
  | { kind: "signature"; party: string }
  | { kind: "blank" };

export interface Run { text: string; bold: boolean }

/** `**texto**` inline → runs bold/regular. Marcador sem par fica literal. */
export function parseInline(line: string): Run[] {
  const parts = line.split("**");
  if (parts.length % 2 === 0) {
    // "**" ímpar: o último pedaço não abre bold, reanexa o marcador
    const last = parts.pop() ?? "";
    parts[parts.length - 1] += "**" + last;
  }
  const runs: Run[] = [];
  parts.forEach((text, i) => { if (text.length) runs.push({ text, bold: i % 2 === 1 }); });
  return runs;
}

const SIG_RE = /^\[\[\s*signature\s*:\s*([A-Za-z0-9_\-]+)\s*\]\]$/i;

export function parseMarkdownLite(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (t === "") { blocks.push({ kind: "blank" }); continue; }
    const sig = t.match(SIG_RE);
    if (sig) { blocks.push({ kind: "signature", party: sig[1].toLowerCase() }); continue; }
    if (t.startsWith("### ")) { blocks.push({ kind: "h3", runs: parseInline(t.slice(4).trim()) }); continue; }
    if (t.startsWith("## ")) { blocks.push({ kind: "h2", runs: parseInline(t.slice(3).trim()) }); continue; }
    if (t.startsWith("# ")) { blocks.push({ kind: "h1", runs: parseInline(t.slice(2).trim()) }); continue; }
    if (/^[-*•]\s+/.test(t)) { blocks.push({ kind: "li", runs: parseInline(t.replace(/^[-*•]\s+/, "")) }); continue; }
    blocks.push({ kind: "p", runs: parseInline(t) });
  }
  return blocks;
}

// ─── 4) Layout ────────────────────────────────────────────────────────────────

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 56;
const FOOTER_H = 22; // reserva acima da margem inferior pro rodapé
const BULLET_INDENT = 14;
const SIG_LINE_W = 250;
const COLOR_TEXT = rgb(0.1, 0.1, 0.1);
const COLOR_MUTED = rgb(0.45, 0.45, 0.45);

interface Style { size: number; leading: number; bold: boolean; align: "left" | "center"; spaceBefore: number; spaceAfter: number }

const STYLES: Record<"h1" | "h2" | "h3" | "p" | "li", Style> = {
  h1: { size: 16, leading: 20, bold: true, align: "center", spaceBefore: 0, spaceAfter: 8 },
  h2: { size: 13, leading: 17, bold: true, align: "left", spaceBefore: 8, spaceAfter: 4 },
  h3: { size: 11, leading: 15, bold: true, align: "left", spaceBefore: 10, spaceAfter: 3 },
  p: { size: 10, leading: 14, bold: false, align: "left", spaceBefore: 0, spaceAfter: 3 },
  li: { size: 10, leading: 14, bold: false, align: "left", spaceBefore: 0, spaceAfter: 1.5 },
};

interface Word { text: string; bold: boolean; width: number }
interface Line { words: Word[]; width: number }

/** Quebra runs em linhas medindo cada palavra na fonte certa. */
function wrapRuns(runs: Run[], fonts: { regular: PDFFont; bold: PDFFont }, size: number, maxWidth: number, forceBold: boolean): Line[] {
  const spaceW = fonts.regular.widthOfTextAtSize(" ", size);
  const words: Word[] = [];
  for (const run of runs) {
    const font = run.bold || forceBold ? fonts.bold : fonts.regular;
    for (const w of run.text.split(/\s+/)) {
      if (!w) continue;
      words.push({ text: w, bold: run.bold || forceBold, width: font.widthOfTextAtSize(w, size) });
    }
  }
  const lines: Line[] = [];
  let cur: Word[] = [];
  let curW = 0;
  for (const w of words) {
    // palavra maior que a linha inteira: quebra por caracteres
    if (w.width > maxWidth) {
      if (cur.length) { lines.push({ words: cur, width: curW }); cur = []; curW = 0; }
      const font = w.bold ? fonts.bold : fonts.regular;
      let chunk = "";
      for (const ch of w.text) {
        const test = chunk + ch;
        if (font.widthOfTextAtSize(test, size) > maxWidth && chunk) {
          lines.push({ words: [{ text: chunk, bold: w.bold, width: font.widthOfTextAtSize(chunk, size) }], width: font.widthOfTextAtSize(chunk, size) });
          chunk = ch;
        } else chunk = test;
      }
      if (chunk) { cur = [{ text: chunk, bold: w.bold, width: font.widthOfTextAtSize(chunk, size) }]; curW = cur[0].width; }
      continue;
    }
    const add = cur.length ? spaceW + w.width : w.width;
    if (curW + add > maxWidth && cur.length) {
      lines.push({ words: cur, width: curW });
      cur = [w]; curW = w.width;
    } else { cur.push(w); curW += add; }
  }
  if (cur.length) lines.push({ words: cur, width: curW });
  return lines;
}

class Layout {
  readonly doc: PDFDocument;
  readonly fonts: { regular: PDFFont; bold: PDFFont };
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  readonly contentW = A4.width - MARGIN * 2;
  readonly bottom = MARGIN + FOOTER_H;

  constructor(doc: PDFDocument, fonts: { regular: PDFFont; bold: PDFFont }) {
    this.doc = doc; this.fonts = fonts; this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.width, A4.height]);
    this.pages.push(this.page);
    this.y = A4.height - MARGIN;
  }

  /** Garante `h` pontos livres; senão vira a página. */
  ensure(h: number) { if (this.y - h < this.bottom) this.newPage(); }

  /** Espaço vertical (não cria página só por espaço). */
  gap(h: number) { if (h <= 0) return; this.y = Math.max(this.bottom, this.y - h); }

  drawLine(line: Line, style: Style, x0: number, width: number) {
    const spaceW = this.fonts.regular.widthOfTextAtSize(" ", style.size);
    let x = style.align === "center" ? x0 + (width - line.width) / 2 : x0;
    const baseline = this.y - style.size; // y do topo da linha → baseline
    for (const w of line.words) {
      this.page.drawText(w.text, { x, y: baseline, size: style.size, font: w.bold ? this.fonts.bold : this.fonts.regular, color: COLOR_TEXT });
      x += w.width + spaceW;
    }
    this.y -= style.leading;
  }

  text(runs: Run[], style: Style, opts: { indent?: number; bullet?: boolean } = {}) {
    const indent = opts.indent ?? 0;
    const x0 = MARGIN + indent;
    const width = this.contentW - indent;
    const lines = wrapRuns(runs, this.fonts, style.size, width, style.bold);
    if (!lines.length) return;
    // título/seção não fica órfão no pé da página: precisa caber ele + 2 linhas de texto
    const keepWith = style.bold ? STYLES.p.leading * 2 : 0;
    if (this.y !== A4.height - MARGIN) this.gap(style.spaceBefore);
    this.ensure(style.leading + keepWith);
    lines.forEach((line, i) => {
      if (i > 0) this.ensure(style.leading);
      if (opts.bullet && i === 0) {
        this.page.drawText("•", { x: MARGIN + 2, y: this.y - style.size, size: style.size, font: this.fonts.regular, color: COLOR_TEXT });
      }
      this.drawLine(line, style, x0, width);
    });
    this.gap(style.spaceAfter);
  }

  signature() {
    const blockH = 34 + 10; // espaço pra assinar + linha + respiro
    this.ensure(blockH + STYLES.p.leading * 3); // mantém junto com as linhas de identificação
    this.gap(34);
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + SIG_LINE_W, y: this.y }, thickness: 0.8, color: COLOR_TEXT });
    this.gap(8);
  }

  footer(meta: RenderMeta) {
    const total = this.pages.length;
    const size = 8;
    const left = toWinAnsi(`${meta.contractCode} · v${meta.contractVersion} · template v${meta.templateVersion}`);
    this.pages.forEach((page, i) => {
      const right = `página ${i + 1} de ${total}`;
      const rightW = this.fonts.regular.widthOfTextAtSize(right, size);
      page.drawLine({ start: { x: MARGIN, y: MARGIN - 6 }, end: { x: A4.width - MARGIN, y: MARGIN - 6 }, thickness: 0.4, color: COLOR_MUTED });
      page.drawText(left, { x: MARGIN, y: MARGIN - 18, size, font: this.fonts.regular, color: COLOR_MUTED });
      page.drawText(right, { x: A4.width - MARGIN - rightW, y: MARGIN - 18, size, font: this.fonts.regular, color: COLOR_MUTED });
    });
  }
}

// ─── 5) API pública ───────────────────────────────────────────────────────────

/**
 * Renderiza o template (markdown-lite + {{variáveis}}) num PDF A4.
 * Retorna os bytes do PDF; o SHA-256 é calculado por quem chama (é do arquivo final).
 */
export async function renderMarkdownLiteToPdf(body: string, variables: Variables, meta: RenderMeta): Promise<Uint8Array> {
  const substituted = substituteVariables(body, variables, meta.blank ?? DEFAULT_BLANK);
  const blocks = parseMarkdownLite(toWinAnsi(substituted));

  const doc = await PDFDocument.create();
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const firstH1 = blocks.find((b): b is Extract<Block, { kind: "h1" }> => b.kind === "h1");
  doc.setTitle(toWinAnsi(meta.title ?? (firstH1 ? firstH1.runs.map((r) => r.text).join("") : "Contrato")));
  doc.setProducer(meta.producer ?? "TotexGest contract-render");
  doc.setCreator("TotexGest");
  doc.setSubject(toWinAnsi(`${meta.contractCode} v${meta.contractVersion}`));
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());

  const layout = new Layout(doc, fonts);
  let pendingBlank = false;
  for (const block of blocks) {
    if (block.kind === "blank") { pendingBlank = true; continue; }
    if (pendingBlank) { layout.gap(STYLES.p.leading * 0.6); pendingBlank = false; }
    if (block.kind === "signature") { layout.signature(); continue; }
    if (block.kind === "li") { layout.text(block.runs, STYLES.li, { indent: BULLET_INDENT, bullet: true }); continue; }
    layout.text(block.runs, STYLES[block.kind]);
  }
  layout.footer(meta);
  return await doc.save({ useObjectStreams: false });
}

/** SHA-256 hex dos bytes (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
