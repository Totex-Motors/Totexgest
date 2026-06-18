#!/usr/bin/env node
/**
 * relatorio-testes.mjs — Roda as Camadas 2 e 3 e salva TUDO num arquivo .md
 * -------------------------------------------------------------------------
 * Camada 2: `node scripts/validar-sistema.mjs` (tsc, eslint de bugs, segredos, unit)
 * Camada 3: `npx playwright test` (E2E) — saída JSON resumida.
 *
 * Gera RELATORIO-TESTES.md na raiz, com data/hora. Abra esse arquivo pra ver
 * o resultado quando quiser (não precisa ficar olhando o terminal).
 *
 * Uso:  npm run relatorio
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";
const node = process.execPath;

// Remove os códigos de cor ANSI pra o .md ficar limpo.
const semCor = (s) => (s || "").replace(/\x1b\[[0-9;]*m/g, "");

const agora = new Date().toLocaleString("pt-BR");
const linhas = [`# Relatório de testes — Totexgest`, ``, `_Gerado em ${agora}_`, ``];

// ----------------------------------------------------- Camada 2: validar
console.log("Rodando Camada 2 (validar)...");
const v = spawnSync(node, [join(ROOT, "scripts", "validar-sistema.mjs")], {
  cwd: ROOT, encoding: "utf8",
});
const validarSaida = semCor(v.stdout) + semCor(v.stderr);
linhas.push(`## Camada 2 — Validação de saúde (\`npm run validar\`)`, ``);
linhas.push(v.status === 0
  ? `**Status:** ✅ Sem falhas críticas`
  : `**Status:** ❌ Falhas críticas (código ${v.status})`);
linhas.push(``, "```", validarSaida.trim(), "```", ``);

// ----------------------------------------------------- Camada 3: E2E
console.log("Rodando Camada 3 (E2E Playwright)...");
const e = spawnSync(npx, ["playwright", "test", "--reporter=json"], {
  cwd: ROOT, encoding: "utf8", shell: isWin,
});
linhas.push(`## Camada 3 — Testes E2E (\`npm run test:e2e\`)`, ``);

let resumoE2E = "";
try {
  const json = JSON.parse(e.stdout);
  const specs = [];
  const walk = (suite) => {
    for (const s of suite.specs ?? []) {
      const r = s.tests?.[0]?.results?.[0]?.status ?? "desconhecido";
      const icone = { passed: "✅", failed: "❌", skipped: "⏭️", timedOut: "⏱️" }[r] ?? "❔";
      specs.push(`- ${icone} ${s.title}`);
    }
    for (const sub of suite.suites ?? []) walk(sub);
  };
  for (const suite of json.suites ?? []) walk(suite);
  const st = json.stats ?? {};
  linhas.push(`**Status:** ${st.unexpected ? "❌" : "✅"} ${st.expected ?? 0} passou · ${st.unexpected ?? 0} falhou · ${st.skipped ?? 0} pulado`, ``);
  linhas.push(...specs, ``);
  resumoE2E = `${st.expected ?? 0} passou, ${st.unexpected ?? 0} falhou, ${st.skipped ?? 0} pulado`;
} catch {
  // Se o JSON não parsear, despeja a saída crua.
  linhas.push(`**Status:** ⚠️ Não consegui ler o JSON do Playwright. Saída bruta abaixo.`, ``);
  linhas.push("```", semCor(e.stdout + e.stderr).trim().slice(0, 4000), "```", ``);
  resumoE2E = "ver saída bruta";
}

const destino = join(ROOT, "RELATORIO-TESTES.md");
writeFileSync(destino, linhas.join("\n"), "utf8");

console.log(`\n✓ Relatório salvo em RELATORIO-TESTES.md`);
console.log(`  Camada 2: ${v.status === 0 ? "sem falhas críticas" : "FALHAS"}`);
console.log(`  Camada 3: ${resumoE2E}`);
