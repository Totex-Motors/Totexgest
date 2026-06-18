# 🔍 Auditoria do Sistema — CRM AI-First

> Gerado em **2026-06-17** | branch `develop`
> Método: análise estática de todo o código (`tsc`, ESLint, varredura de padrões,
> revisão manual dos pontos críticos). Cada item abaixo foi **verificado no código**,
> com arquivo e linha.

Para **re-rodar** estas checagens a qualquer momento:

```bash
npm run validar      # roda o validador (scripts/validar-sistema.mjs)
```

O validador roda só as verificações de **alto sinal** e ignora ruído (ex.: os
1.852 erros de `any` do ESLint não dizem nada sobre o sistema quebrar).

---

## 📊 Resumo executivo

| O que foi checado | Resultado |
|---|---|
| TypeScript (`tsc --noEmit`) | ✅ **Limpo** — 0 erros de tipo |
| Bugs de runtime (ESLint, regras de bug) | ❌ **13 ocorrências**, 2 são crash garantido |
| Segredos / URL hardcoded | ⚠️ **1 real** (regra do projeto violada) |
| Cobertura de testes | 🔴 **~Zero** — 1 teste de exemplo p/ todo o sistema |
| Arquivos gigantes (>1500 linhas) | ⚠️ **15 arquivos** (1 com 8.228 linhas) |

**Veredito:** o sistema compila e tipa limpo, mas tem **2 bugs que derrubam a tela**
(hooks chamados condicionalmente), **nenhuma rede de segurança de testes**, e alguns
pontos de fragilidade/manutenção. Nada disso é visível no `npm run build` porque o
build do Vite **não roda o checador de tipos nem os lints**.

---

## ✅ Correções aplicadas (2026-06-17)

Os defeitos concretos abaixo **já foram corrigidos** nesta branch. Reverificado com
`npm run validar` (0 bugs, 0 segredos), `npm run typecheck` e `vite build` — tudo passando.

| Item | Arquivo | Correção |
|---|---|---|
| 🔴 Hooks após `return null` | CallDetailModal.tsx | `useCallback`s movidos para antes do early return |
| 🔴 Hooks após `return null` | DailyActivityBanner.tsx | hooks movidos p/ cima; guard via flag `enabled` |
| 🟠 `useQueryClient` em try/catch | DemoModeContext.tsx + App.tsx | ordem dos providers invertida; hook chamado direto |
| 🟠 URL UAZAPI hardcoded | whatsappService.ts | usa `api_url` da instância (era `webhook_url` errado); sem fallback fixo |
| 🟢 Código morto `if (false)` | useClientTimeline.ts, ai-sales-agent/index.ts | blocos removidos |
| 🟢 `{(true) && ...}` | PaymentPartCard.tsx | condicional removida |
| 🟢 `obj.hasOwnProperty` | useSalesWorkflow.ts | trocado por `Object.prototype.hasOwnProperty.call` |
| 🟢 Regex emoji enganosa | WhatsAppChat.tsx | suprimido com justificativa (intencional) |
| ⚙️ ESLint afogado em `any` | eslint.config.js | `no-explicit-any` → `warn` |
| ⚙️ Números desatualizados | CLAUDE.md | 64 functions / 47 migrations / ~81 hooks |

**Ainda em aberto (não são defeitos de código — são esforços maiores):**
- 🟠 **Cobertura de testes** (item 5): precisa escrever os testes, não há o que "corrigir".
- 🟡 **`.single()` → `.maybeSingle()`** (item 6): conversão em massa muda comportamento;
  precisa revisão caso a caso (1 caso já corrigido em whatsappService).
- 🟡 **Arquivos gigantes** (item 8) e **exhaustive-deps** (item 7): refatorar/auditar com cuidado.

> As seções abaixo descrevem cada item em detalhe (mantidas para histórico).

---

## 🔴 CRÍTICO — derruba a tela em runtime

### 1. Hooks chamados depois de `return null` — `CallDetailModal`
**Arquivo:** [src/components/calls/CallDetailModal.tsx:750](src/components/calls/CallDetailModal.tsx:750) e [:790](src/components/calls/CallDetailModal.tsx:790)

Há um `if (!call) return null;` na linha 747, e **dois `useCallback` depois dele**
(`handleDeepAnalyze` e `handleGeneratePDF`). Isso quebra a regra dos Hooks do React:
quando `call` muda de `null` → preenchido (abrir o modal de uma chamada), o React
renderiza um número **diferente** de hooks e lança
`Rendered more hooks than during the previous render` — **a tela quebra (branco)**.

> Tem até um comentário `// Early return AFTER all hooks` na linha 746 — ou seja,
> alguém adicionou hooks abaixo dele por engano depois.

**Correção:** mover os dois `useCallback` para **antes** da linha 747.

---

### 2. Hooks chamados depois de `return null` — `DailyActivityBanner`
**Arquivo:** [src/components/layout/DailyActivityBanner.tsx:68](src/components/layout/DailyActivityBanner.tsx:68) e [:73](src/components/layout/DailyActivityBanner.tsx:73)

Mesmo problema: `if (!isComercial || !teamMember?.id) return null;` na linha 63, e
depois `useDailyActivitySummary(...)` e `useQuery(...)`. Esse banner fica no **topo do
layout comercial**, então o crash aparece para o vendedor assim que o perfil/role
termina de carregar (o valor de `teamMember` muda de vazio → preenchido).

**Correção:** mover os dois hooks para **antes** do `return null` e usar a flag
`enabled: !!teamMember?.id` no `useQuery` (e o equivalente no hook de summary) para
não disparar a query enquanto não houver membro.

---

## 🟠 ALTO

### 3. `useQueryClient()` dentro de try/catch — `DemoModeContext`
**Arquivo:** [src/contexts/DemoModeContext.tsx:52](src/contexts/DemoModeContext.tsx:52)

```ts
let queryClient: any = null;
try { queryClient = useQueryClient(); } catch {}
```

Chamar um hook dentro de `try/catch` é hook condicional. Funciona **só enquanto** a
posição do provider na árvore for estável — é uma gambiarra frágil que pode quebrar
numa refatoração de providers.

**Correção:** garantir que `DemoModeProvider` esteja **dentro** do
`QueryClientProvider` e chamar `useQueryClient()` direto, sem try/catch.

---

### 4. URL da UAZAPI hardcoded — viola regra do projeto
**Arquivo:** [src/services/whatsappService.ts:38](src/services/whatsappService.ts:38)

```ts
apiUrl: data.webhook_url || 'https://api.uazapi.com',
```

O `CLAUDE.md` lista isso como **regra inviolável** (`❌ Hardcode de URL UAZAPI`). Se
`webhook_url` vier vazio/nulo, o sistema passa a falar com o host genérico errado em
vez de falhar de forma clara.

**Correção:** ler de `config.UAZAPI_ADMIN_URL` / `instance.api_url`, ou retornar `null`
com um erro explícito em vez de cair num host fixo.

---

### 5. 🔴 Sistema praticamente SEM testes
**Único teste:** [src/test/example.test.ts](src/test/example.test.ts) (teste de exemplo, trivial).

Para **64 Edge Functions**, **81 hooks** e **28 páginas**, existe **1 teste de
exemplo**. Não há nenhuma rede de segurança automatizada — exatamente os "fluxos que
não funcionam" que você quer pegar não têm como ser detectados em regressão hoje.

**Recomendação (ordem de prioridade):** começar pelos fluxos de maior risco e dinheiro:
1. `process-automation-rules` / movimentação de estágio no pipeline (lógica de `move_deal_stage`).
2. `calculate-commission` (mexe com comissão = dinheiro).
3. `ai-sales-agent` — ao menos os guard-rails (horário, cooldown, max msgs).
4. Hooks de mutação centrais: `useSalesDeals`, `useTasks`, `useSalesLeads`.

Vitest já está configurado — falta só escrever os testes.

---

## 🟡 MÉDIO

### 6. 315 usos de `.single()` — estoura quando não acha registro
`.single()` lança erro do PostgREST (`PGRST116`) quando a query retorna **0 linhas**,
em vez de devolver `null`. Em buscas que **podem legitimamente não achar** nada
(lookup por telefone, por external id, por chave de config), o certo é `.maybeSingle()`.

São **315 ocorrências em 91 arquivos** — não dá pra afirmar que todas estão erradas,
mas é um padrão de risco a revisar (concentrado em `useSalesDeals` (25), `useTasks` (20),
`useAISalesAgent` (10), `useSalesLeads` (11)). Regra prática: **`.single()` só quando o
registro é garantido existir; senão `.maybeSingle()`.**

### 7. 81 avisos de `react-hooks/exhaustive-deps`
Dependências faltando em `useEffect`/`useCallback`/`useMemo` → risco de *stale closure*
(callback usando valor "velho" de estado). Nem todo aviso é bug, mas 81 é muito para
ignorar em bloco. Vale varrer os de `useEffect` que disparam efeitos (fetch, subscribe).

### 8. Arquivos gigantes (manutenção/regressão)
| Linhas | Arquivo |
|---|---|
| 8.228 | [supabase/functions/ai-sales-agent/index.ts](supabase/functions/ai-sales-agent/index.ts) |
| 2.944 | [src/pages/SalesLeadDetail.tsx](src/pages/SalesLeadDetail.tsx) |
| 2.916 | [supabase/functions/chat-manager/index.ts](supabase/functions/chat-manager/index.ts) |
| 2.856 | [src/pages/SalesSettings.tsx](src/pages/SalesSettings.tsx) |
| 2.355 | [src/components/inbox/WhatsAppChat.tsx](src/components/inbox/WhatsAppChat.tsx) |

(+10 outros acima de 1.500). Um arquivo de **8 mil linhas** numa Edge Function é o
maior risco de regressão do projeto — quase impossível de revisar ou testar com
segurança. Candidato a quebrar em módulos (`handlers/`, `lib/`).

---

## 🟢 BAIXO — limpeza / código morto

| Item | Local | Observação |
|---|---|---|
| `if (false && organizationId)` | [useClientTimeline.ts:1328](src/hooks/useClientTimeline.ts:1328) | Bloco desativado de propósito — **remover** |
| `{(true) && (...)}` | [PaymentPartCard.tsx:450](src/components/sales/payments/PaymentPartCard.tsx:450) | Sobra de condicional antiga — simplificar |
| `while(true)`/condição constante | [ai-sales-agent/index.ts:3711](supabase/functions/ai-sales-agent/index.ts:3711) | Conferir se é loop intencional |
| Regex de emoji com char combinado | [WhatsAppChat.tsx:1801](src/components/inbox/WhatsAppChat.tsx:1801) | Ao copiar conversa, pode deixar resíduo (ZWJ/bandeiras). Cosmético |
| `obj.hasOwnProperty(...)` | [useSalesWorkflow.ts:152](src/hooks/useSalesWorkflow.ts:152) | Funciona (objeto literal), mas use `Object.prototype.hasOwnProperty.call(...)` |
| 88 `catch {}` vazios | vários | Maioria benigna (sessionStorage), mas alguns engolem erro silenciosamente |

---

## ⚙️ Observações de configuração

- **O build não valida nada.** `vite build` não roda `tsc` nem ESLint. Rode
  `npm run typecheck` e `npm run validar` antes de subir (ideal: no CI / pre-push).
- **ESLint afogado em ruído:** a config trata `@typescript-eslint/no-explicit-any`
  como **erro** (1.852 deles) e desliga `no-unused-vars`. Resultado: os ~13 bugs reais
  ficam escondidos no meio de 2.000 erros. Sugestão: baixar `no-explicit-any` para
  `warn`. O `npm run validar` já contorna isso filtrando só as regras de bug.
- **`CLAUDE.md` desatualizado:** diz "52 Edge Functions / 23 migrations / 79 hooks";
  o real hoje é **64 functions / 46 migrations / 81 hooks**. Vale atualizar para não
  confundir quem chega depois.

---

## ✅ Plano de ação sugerido (ordem)

1. **[CRÍTICO]** Mover os hooks para antes do `return null` em `CallDetailModal` e
   `DailyActivityBanner` (itens 1 e 2). São crashes reais — correção de minutos.
2. **[ALTO]** Tirar o try/catch do `useQueryClient` (item 3) e remover a URL UAZAPI
   hardcoded (item 4).
3. **[ALTO]** Escrever os primeiros testes nos fluxos de dinheiro/automação (item 5).
4. **[MÉDIO]** Auditar `.single()` → `.maybeSingle()` nos lookups que podem não achar.
5. **[BAIXO]** Limpar código morto e atualizar `CLAUDE.md`.
6. **Adotar** `npm run validar` como porta de entrada antes de cada push.
