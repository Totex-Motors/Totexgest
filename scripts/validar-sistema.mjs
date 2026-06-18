#!/usr/bin/env node
/**
 * validar-sistema.mjs — Validador de saúde do CRM
 * ------------------------------------------------
 * Roda as verificações de ALTO SINAL e ignora o ruído (ex.: 1800+ erros de
 * `any` no ESLint não dizem nada sobre o sistema quebrar).
 *
 * O que ele checa:
 *   1. TypeScript           -> `tsc --noEmit` (o build do Vite NÃO faz isso)
 *   2. Bugs de runtime      -> regras de ESLint que indicam código quebrado
 *                              (hooks condicionais, condição constante, etc.)
 *   3. Segredos hardcoded   -> chaves de API e URLs UAZAPI fixas no código
 *   4. Testes               -> `vitest run`
 *   5. Manutenibilidade     -> arquivos gigantes (aviso, não falha)
 *
 * Uso:  node scripts/validar-sistema.mjs
 *       npm run validar
 *
 * Sai com código != 0 se alguma verificação CRÍTICA falhar (bom pra CI / pre-push).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

// Regras de ESLint que apontam BUGS REAIS (não estilo/tipagem).
const REGRAS_BUG = new Set([
  "react-hooks/rules-of-hooks",        // hook condicional -> crash "rendered more hooks"
  "no-constant-binary-expression",     // `true && x`, `x || true` -> lógica morta/errada
  "no-constant-condition",             // `if (false)` -> código nunca/sempre roda
  "no-prototype-builtins",             // obj.hasOwnProperty -> quebra com objetos sem proto
  "no-misleading-character-class",     // regex com char combinado -> match errado
  "no-unsafe-negation",
  "no-dupe-keys",
  "no-dupe-args",
  "no-unreachable",
  "no-self-assign",
]);

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
};
const titulo = (t) => console.log(`\n${c.bold}${c.cyan}── ${t} ──${c.reset}`);
const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const fail = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const warn = (m) => console.log(`  ${c.yellow}!${c.reset} ${m}`);
const info = (m) => console.log(`  ${c.gray}${m}${c.reset}`);

const falhas = [];
const avisos = [];

// ---------------------------------------------------------------- 1. TypeScript
titulo("1. TypeScript (tsc --noEmit)");
{
  const r = spawnSync(npx, ["tsc", "--noEmit"], { cwd: ROOT, encoding: "utf8", shell: isWin });
  if (r.status === 0) {
    ok("Sem erros de tipo.");
  } else {
    const linhas = (r.stdout || "").split("\n").filter((l) => l.includes("error TS"));
    fail(`${linhas.length} erro(s) de tipo:`);
    linhas.slice(0, 20).forEach((l) => info("  " + l.trim()));
    if (linhas.length > 20) info(`  ... +${linhas.length - 20}`);
    falhas.push("TypeScript com erros");
  }
}

// ---------------------------------------------------------------- 2. ESLint (bugs)
titulo("2. Bugs de runtime (ESLint — regras de alto sinal)");
{
  const r = spawnSync(npx, ["eslint", ".", "--format", "json"], {
    cwd: ROOT, encoding: "utf8", shell: isWin, maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = [];
  try { parsed = JSON.parse(r.stdout || "[]"); } catch { /* eslint falhou ao rodar */ }

  const bugs = [];
  for (const f of parsed) {
    for (const m of f.messages) {
      if (m.ruleId && REGRAS_BUG.has(m.ruleId)) {
        bugs.push(`${relative(ROOT, f.filePath)}:${m.line}  [${m.ruleId}] ${m.message}`);
      }
    }
  }
  if (!parsed.length && r.status !== 0 && !r.stdout) {
    warn("ESLint não conseguiu rodar (cheque a instalação).");
  } else if (bugs.length === 0) {
    ok("Nenhuma regra de bug disparada.");
  } else {
    fail(`${bugs.length} possível(is) bug(s):`);
    bugs.forEach((b) => info("  " + b));
    falhas.push(`${bugs.length} bug(s) de ESLint`);
  }
  info("(erros de `any`/estilo são ignorados de propósito)");
}

// ---------------------------------------------------------------- 3. Segredos
titulo("3. Segredos / URLs hardcoded");
{
  const alvos = ["src", "supabase/functions"];
  const PADROES = [
    { nome: "Chave Anthropic", re: /sk-ant-api03-[A-Za-z0-9_-]{30,}/ },
    { nome: "Chave Google/Gemini", re: /AIzaSy[A-Za-z0-9_-]{25,}/ },
    { nome: "Chave OpenAI", re: /sk-proj-[A-Za-z0-9_-]{30,}/ },
    // URL UAZAPI fixa (exceto placeholders óbvios de UI)
    {
      nome: "URL UAZAPI hardcoded",
      re: /['"]https?:\/\/[a-z0-9.-]*uazapi\.com['"]/i,
      // ignora placeholders de UI e links de documentação (não são endpoints)
      ignorar: /sua-instancia|meuservidor|your-|exemplo|example|docsurl|setup_url|\bdocs\b/i,
    },
  ];
  const achados = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", ".git"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
        const txt = readFileSync(p, "utf8");
        txt.split("\n").forEach((line, i) => {
          for (const pat of PADROES) {
            if (pat.re.test(line) && !(pat.ignorar && pat.ignorar.test(line))) {
              achados.push(`${relative(ROOT, p)}:${i + 1}  [${pat.nome}] ${line.trim().slice(0, 100)}`);
            }
          }
        });
      }
    }
  };
  alvos.forEach((a) => walk(join(ROOT, a)));
  if (achados.length === 0) {
    ok("Nenhum segredo/URL hardcoded encontrado.");
  } else {
    fail(`${achados.length} ocorrência(s) — use getIntegrationKey() / config:`);
    achados.forEach((a) => info("  " + a));
    falhas.push(`${achados.length} segredo(s)/URL hardcoded`);
  }
}

// ---------------------------------------------------------------- 4. Testes
titulo("4. Testes (vitest run)");
{
  const r = spawnSync(npx, ["vitest", "run"], { cwd: ROOT, encoding: "utf8", shell: isWin });
  // remove códigos de cor ANSI antes de fazer o parse
  const out = ((r.stdout || "") + (r.stderr || "")).replace(/\x1b\[[0-9;]*m/g, "");
  const m = out.match(/Tests\s+(\d+) passed/);
  const total = m ? Number(m[1]) : 0;
  if (r.status !== 0) {
    fail("Testes falharam.");
    falhas.push("Testes falhando");
  } else if (total <= 1) {
    warn(`Só ${total} teste rodou — sistema praticamente SEM cobertura.`);
    avisos.push("Cobertura de testes quase inexistente");
  } else {
    ok(`${total} testes passaram.`);
  }
}

// ---------------------------------------------------------------- 5. Arquivos gigantes
titulo("5. Manutenibilidade (arquivos > 1500 linhas)");
{
  const grandes = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "dist", ".git"].includes(e.name)) continue;
        walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith("database.types.ts")) {
        const n = readFileSync(p, "utf8").split("\n").length;
        if (n > 1500) grandes.push({ p: relative(ROOT, p), n });
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "supabase/functions"));
  grandes.sort((a, b) => b.n - a.n);
  if (grandes.length === 0) {
    ok("Nenhum arquivo monstro.");
  } else {
    warn(`${grandes.length} arquivo(s) grande(s) (difícil manter/testar):`);
    grandes.slice(0, 10).forEach((g) => info(`  ${String(g.n).padStart(5)} linhas  ${g.p}`));
    avisos.push(`${grandes.length} arquivo(s) > 1500 linhas`);
  }
}

// ---------------------------------------------------------------- Resumo
console.log(`\n${c.bold}══════════════ RESUMO ══════════════${c.reset}`);
if (falhas.length === 0) {
  console.log(`${c.green}${c.bold}Nenhuma falha crítica.${c.reset}`);
} else {
  console.log(`${c.red}${c.bold}${falhas.length} falha(s) crítica(s):${c.reset}`);
  falhas.forEach((f) => console.log(`  ${c.red}•${c.reset} ${f}`));
}
if (avisos.length) {
  console.log(`${c.yellow}${avisos.length} aviso(s):${c.reset}`);
  avisos.forEach((a) => console.log(`  ${c.yellow}•${c.reset} ${a}`));
}
process.exit(falhas.length > 0 ? 1 : 0);
