#!/usr/bin/env node
/**
 * scan-seguranca.mjs — Auditoria ESTÁTICA de segurança do Totexgest
 * -----------------------------------------------------------------
 * Procura, sem rodar o app, por vazamentos e más práticas no código:
 *   - Credenciais / API keys / JWT hardcoded
 *   - service_role key referenciada no FRONTEND (vazamento gravíssimo)
 *   - console.* logando dados sensíveis (token, senha, secret, JWT...)
 *   - URL de projeto Supabase / UAZAPI hardcoded como fallback
 *   - dangerouslySetInnerHTML (risco de XSS)
 *   - .env versionado no git
 *
 * Uso direto:  npm run seguranca   (sai != 0 se houver achado CRÍTICO)
 * Também é importado pelo relatorio-testes.mjs (função runScan()).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const FRONT = ["src"];               // o que vira bundle no navegador
const BACK = ["supabase/functions"]; // edge functions (server-side)
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-ssr", ".git", "test", "__tests__"]);

// ---- helpers ----------------------------------------------------------------
function walk(dir, onFile) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, onFile);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      onFile(p);
    }
  }
}
const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

// ---- regras -----------------------------------------------------------------
// nivel: "critico" | "aviso"
const REGRAS = [
  {
    nome: "Chave Anthropic hardcoded", nivel: "critico",
    re: /sk-ant-api03-[A-Za-z0-9_-]{20,}/, alvo: "ambos",
  },
  {
    nome: "Chave Google/Gemini hardcoded", nivel: "critico",
    re: /AIzaSy[A-Za-z0-9_-]{20,}/, alvo: "ambos",
  },
  {
    nome: "Chave OpenAI hardcoded", nivel: "critico",
    re: /sk-(proj-)?[A-Za-z0-9_-]{30,}/, alvo: "ambos",
    ignorar: /sk-ant-|example|xxxx|placeholder/i,
  },
  {
    nome: "JWT hardcoded no código", nivel: "critico",
    re: /['"`]eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}['"`]/, alvo: "ambos",
  },
  {
    // O pior caso: a chave service_role (ignora RLS) referenciada no front.
    nome: "service_role referenciado no FRONTEND", nivel: "critico",
    re: /service[_-]?role|SERVICE_ROLE|serviceRoleKey/, alvo: "front",
    ignorar: /\/\/|getServiceRole|comment|never|nunca/i,
  },
  {
    nome: "console logando dado sensível", nivel: "critico",
    re: /console\.(log|info|warn|debug|error)\s*\([^)]*\b(token|senha|password|secret|apikey|api_key|authorization|bearer|service_role|access_token|refresh_token)\b/i,
    alvo: "ambos",
    ignorar: /['"`][^'"`]*\b(token|senha|password)\b[^'"`]*['"`]\s*\)/i, // string literal de label puro
  },
  {
    nome: "URL UAZAPI hardcoded", nivel: "critico",
    re: /['"]https?:\/\/[a-z0-9.-]*uazapi\.com['"]/i, alvo: "ambos",
    ignorar: /sua-instancia|meuservidor|your-|exemplo|example|docsurl|setup_url|\bdocs\b/i,
  },
  {
    nome: "URL de projeto Supabase hardcoded (fallback)", nivel: "aviso",
    re: /['"]https:\/\/[a-z0-9]{15,}\.supabase\.co['"]/i, alvo: "ambos",
    ignorar: /example|your-project|xxxx/i,
  },
  {
    nome: "dangerouslySetInnerHTML (risco XSS)", nivel: "aviso",
    re: /dangerouslySetInnerHTML/, alvo: "front",
  },
  {
    nome: "Senha literal atribuída", nivel: "aviso",
    re: /\b(password|senha|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/i, alvo: "ambos",
    ignorar: /placeholder|type|label|['"]\s*['"]|\*\*\*|example|test|••|xxxx|password['"]/i,
  },
];

// ---- execução ---------------------------------------------------------------
export function runScan() {
  const criticos = [];
  const avisos = [];

  const scanFile = (p, escopo) => {
    let txt;
    try { txt = readFileSync(p, "utf8"); } catch { return; }
    const linhas = txt.split("\n");
    for (const regra of REGRAS) {
      if (regra.alvo !== "ambos" && regra.alvo !== escopo) continue;
      linhas.forEach((line, i) => {
        if (regra.re.test(line) && !(regra.ignorar && regra.ignorar.test(line))) {
          const item = { regra: regra.nome, arquivo: `${rel(p)}:${i + 1}`, trecho: line.trim().slice(0, 110) };
          (regra.nivel === "critico" ? criticos : avisos).push(item);
        }
      });
    }
  };

  FRONT.forEach((d) => walk(join(ROOT, d), (p) => scanFile(p, "front")));
  BACK.forEach((d) => walk(join(ROOT, d), (p) => scanFile(p, "back")));

  // .env versionado?
  const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  const envTracked = (tracked.stdout || "")
    .split("\n")
    .filter((f) => /^\.env(\.|$)/.test(f) && f !== ".env.example");
  for (const f of envTracked) {
    criticos.push({ regra: ".env versionado no git", arquivo: f, trecho: "remova com: git rm --cached " + f });
  }

  return { criticos, avisos };
}

// ---- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith("scan-seguranca.mjs");
if (isMain) {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m" };
  const { criticos, avisos } = runScan();
  console.log(`\n${c.bold}${c.cyan}── Auditoria de segurança (estática) ──${c.reset}`);
  if (criticos.length === 0) console.log(`  ${c.green}✓${c.reset} Nenhum vazamento crítico encontrado.`);
  else {
    console.log(`  ${c.red}✗ ${criticos.length} achado(s) CRÍTICO(s):${c.reset}`);
    criticos.forEach((a) => console.log(`    ${c.red}•${c.reset} [${a.regra}] ${a.arquivo}\n      ${c.gray}${a.trecho}${c.reset}`));
  }
  if (avisos.length) {
    console.log(`  ${c.yellow}! ${avisos.length} aviso(s):${c.reset}`);
    avisos.forEach((a) => console.log(`    ${c.yellow}•${c.reset} [${a.regra}] ${a.arquivo}`));
  }
  process.exit(criticos.length > 0 ? 1 : 0);
}
