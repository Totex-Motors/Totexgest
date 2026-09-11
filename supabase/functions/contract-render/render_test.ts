// Teste rápido do renderer (sem banco, sem rede).
//   deno run --allow-all supabase/functions/contract-render/render_test.ts [saida.pdf]
// Gera um PDF de exemplo com o mesmo "markdown-lite" do template v1, checa
// substituição de variáveis, sanitização WinAnsi, parser e paginação.

import { PDFDocument } from "npm:pdf-lib@1.17.1";
import {
  DEFAULT_BLANK, listVariableKeys, parseInline, parseMarkdownLite, renderMarkdownLiteToPdf, sha256Hex,
  substituteVariables, toWinAnsi,
} from "./render.ts";

let failures = 0;
function check(cond: boolean, label: string) {
  console.log(`${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── 1) variáveis ──
const vars = { "seller.name": "Maria da Silva", "seller.rg": "", "vehicle.plate": null, "contract.version": 2 };
check(substituteVariables("{{seller.name}} · {{ seller.rg }} · {{vehicle.plate}} · v{{contract.version}} · {{nao.existe}}", vars)
  === `Maria da Silva · ${DEFAULT_BLANK} · ${DEFAULT_BLANK} · v2 · ${DEFAULT_BLANK}`, "substituteVariables: valor, vazio, null, número e chave desconhecida");
check(listVariableKeys("{{a.b}} {{c}} {{a.b}}").join(",") === "a.b,c", "listVariableKeys deduplica");

// ── 2) WinAnsi ──
check(toWinAnsi("“aspas” — travessão – meia • bullet … ç ã é ú Ç") === "“aspas” — travessão – meia • bullet … ç ã é ú Ç", "WinAnsi mantém acentos, aspas curvas, travessão e bullet");
check(toWinAnsi("a b\tc") === "a b    c", "WinAnsi troca nbsp e tab");
check(toWinAnsi("Ł ő → ≥ 😀 ✓") === "L o -> >=  x", "WinAnsi substitui fora do cp1252 e some com emoji");
check(toWinAnsi("a­b") === "ab", "WinAnsi remove hífen suave");
check(toWinAnsi("é") === "é", "WinAnsi normaliza NFD→NFC");
check(toWinAnsi("a\nb\r\ncd") === "a\nb\r\ncd", "WinAnsi preserva quebras de linha e some com controle");

// ── 3) parser ──
const runs = parseInline("**Razão Social:** Totex **Ltda**");
check(runs.length === 3 && runs[0].bold && runs[0].text === "Razão Social:" && !runs[1].bold && runs[1].text === " Totex " && runs[2].bold && runs[2].text === "Ltda", "parseInline: bold inline");
check(parseInline("sem **par").map((r) => r.text).join("") === "sem **par", "parseInline: marcador sem par fica literal");
const blocks = parseMarkdownLite("# T\n## S\n### C\n- item\n• outro\n\n[[signature:owner]]\ntexto");
check(blocks.map((b) => b.kind).join(",") === "h1,h2,h3,li,li,blank,signature,p", "parseMarkdownLite: tipos de bloco");
check(blocks[6].kind === "signature" && blocks[6].party === "owner", "parseMarkdownLite: assinatura com party");

// ── 4) render ──
const clause = "A INTERMEDIADORA prestará ao PROPRIETÁRIO serviços de intermediação destinados a aproximá-lo de potenciais compradores do veículo identificado nas Condições Específicas, promovendo sua apresentação, divulgação, qualificação de interessados, encaminhamento de propostas e apoio à formalização da negociação.";
const body = [
  "# CONTRATO DE INTERMEDIAÇÃO PARA VENDA DE VEÍCULO USADO",
  "## E AUTORIZAÇÃO DE DIVULGAÇÃO, APRESENTAÇÃO E NEGOCIAÇÃO DE PROPOSTAS",
  "Contrato {{contract.code}} · versão {{contract.version}}",
  "",
  "Pelo presente instrumento particular, as partes abaixo identificadas celebram o presente Contrato de Intermediação de Veículo Usado (“Contrato”).",
  "## A. CONDIÇÕES ESPECÍFICAS",
  "### 1. INTERMEDIADORA",
  "- **Razão Social:** {{legal_entity.name}}",
  "- **CNPJ:** {{legal_entity.cnpj}}",
  "- **Endereço:** {{legal_entity.address}}",
  "### 2. PROPRIETÁRIO / CONTRATANTE",
  "- **Nome/Razão Social:** {{seller.name}}",
  "- **RG/IE:** {{seller.rg}}",
  "- **Endereço:** {{seller.address}}",
  "### 3. VEÍCULO",
  "- **Placa:** {{vehicle.plate}}",
  "- **Quilometragem declarada:** {{vehicle.mileage}}",
  "- **Palavra gigante:** " + "X".repeat(140),
  "## B. CONDIÇÕES GERAIS",
  ...Array.from({ length: 18 }, (_, i) => [`### ${i + 1}. CLÁUSULA ${i + 1}`, clause, `**${i + 1}.1.** Subitem. ${clause}`, "• bullet com ponto; texto longo o bastante pra quebrar a linha e testar o recuo do marcador nas linhas seguintes do item."]).flat(),
  "",
  "## C. ASSINATURAS",
  "Local e data: {{contract.city}}, {{contract.date_long}}.",
  "",
  "[[signature:owner]]",
  "**PROPRIETÁRIO / CONTRATANTE**",
  "{{seller.name}} · CPF/CNPJ {{seller.cpf_cnpj}}",
  "",
  "[[signature:company]]",
  "**INTERMEDIADORA — {{legal_entity.name}}**",
  "CNPJ {{legal_entity.cnpj}} · Marca: {{brand.name}}",
].join("\n");

const variables = {
  "contract.code": "INT-2026-0042", "contract.version": "1", "contract.city": "Barueri", "contract.date_long": "11 de setembro de 2026",
  "legal_entity.name": "TOTEX DIGITAL MÍDIA LTDA", "legal_entity.cnpj": "12.345.678/0001-90", "legal_entity.address": "Av. Piracema, 669, Barueri/SP, CEP 06460-030",
  "seller.name": "José Ámbar Ñoño", "seller.cpf_cnpj": "123.456.789-00", "seller.rg": null, "seller.address": "",
  "vehicle.plate": "ABC1D23", "vehicle.mileage": "45.000 km", "brand.name": "TotexMotors",
};

const t0 = Date.now();
const pdf = await renderMarkdownLiteToPdf(body, variables, { contractCode: "INT-2026-0042", contractVersion: 1, templateVersion: 1 });
const ms = Date.now() - t0;
check(pdf.byteLength > 2000, `PDF gerado (${pdf.byteLength} bytes em ${ms}ms)`);
check(String.fromCharCode(...pdf.slice(0, 5)) === "%PDF-", "cabeçalho %PDF-");
const loaded = await PDFDocument.load(pdf);
const pages = loaded.getPageCount();
check(pages >= 3, `paginou (${pages} páginas)`);
const first = loaded.getPage(0);
check(Math.abs(first.getWidth() - 595.28) < 0.1 && Math.abs(first.getHeight() - 841.89) < 0.1, "A4 retrato");
check(loaded.getTitle() === "CONTRATO DE INTERMEDIAÇÃO PARA VENDA DE VEÍCULO USADO", `título do PDF vem do # (${JSON.stringify(loaded.getTitle())})`);
const hash = await sha256Hex(pdf);
check(/^[0-9a-f]{64}$/.test(hash), `sha256 ${hash.slice(0, 12)}…`);

// caractere fora do WinAnsi no body/variável não derruba a renderização
const weird = await renderMarkdownLiteToPdf("# Tïtulo 😀 → ok\n{{x}}", { x: "Łódź ✓ 中文" }, { contractCode: "X", contractVersion: 1, templateVersion: 1 });
check(weird.byteLength > 500, "caracteres fora do WinAnsi não quebram o render");

// ── 5) saída opcional ──
const g = globalThis as { Deno?: { args: string[]; writeFile: (p: string, d: Uint8Array) => Promise<void> } };
const out = g.Deno?.args?.[0];
if (out && g.Deno) { await g.Deno.writeFile(out, pdf); console.log(`PDF salvo em ${out}`); }

console.log(failures ? `\n${failures} falha(s)` : "\ntodos os testes passaram");
if (failures) throw new Error(`${failures} teste(s) falharam`);
