# Guia de Correções Mobile (Frontend) — CRM AI-First

> **Objetivo:** documentar, em detalhe, os problemas de responsividade ("elementos
> saindo pra fora da tela", "tabela estranha", "modal estourando") encontrados no
> CRM e **como cada um foi resolvido**, para que o mesmo conjunto de correções
> possa ser aplicado em outro projeto que compartilha a mesma estrutura
> (React + TypeScript + Vite + Tailwind + shadcn/ui + Radix).

> **Importante:** quase todos os bugs vinham de **3 ou 4 padrões repetidos**. Se
> você entender esses padrões (seção "Causas-raiz"), consegue varrer o outro
> projeto e corrigir tudo, mesmo que os arquivos tenham nomes diferentes.

---

## Stack assumida

- React 18 + TypeScript + Vite
- Tailwind CSS 3 (breakpoints padrão: `sm:640px`, `md:768px`, `lg:1024px`, `xl:1280px`)
- shadcn/ui (componentes `Dialog`, `Table`, `Tabs`, `ScrollArea`, `Select`, etc., baseados em Radix)
- Layout mobile-first (a base sem prefixo = celular; prefixos `sm:`/`md:` = telas maiores)

---

## Como diagnosticar (faça isso no outro projeto)

Rode o app, abra o DevTools em **375px de largura** (preset "mobile") e, no console,
cole este detector de overflow horizontal. Ele mostra a página e os elementos que
"vazam" pra fora:

```js
(() => {
  const docW = document.documentElement.clientWidth;
  const pageOverflow = document.documentElement.scrollWidth - docW;
  const offenders = [];
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    // elemento cujo conteúdo NÃO rola (overflow visible) e ultrapassa a tela
    if (r.right > docW + 1 && r.width > 0 && getComputedStyle(el).overflowX === 'visible') {
      offenders.push({ tag: el.tagName.toLowerCase(), cls: (el.className||'').toString().slice(0,50), right: Math.round(r.right) });
    }
  });
  offenders.sort((a,b)=>b.right-a.right);
  return { pageOverflow, offenders: offenders.slice(0,10) };
})()
```

- **`pageOverflow > 0`** → a página inteira rola de lado (ruim). Use a lista de
  `offenders` pra achar o elemento mais à direita que está empurrando tudo.
- Para um modal/form específico, troque o seletor por
  `form.scrollWidth - form.clientWidth` e caia descendo pelo elemento de maior
  `scrollWidth` até achar o "vilão".

---

## Causas-raiz (os 4 padrões que explicam ~tudo)

### 1. Radix `ScrollArea` + tabela larga = a página inteira vaza
**O bug mais importante e menos óbvio.** O `ScrollArea` do Radix embrulha o
conteúdo num elemento interno com `display: table; min-width: 100%`. Esse
elemento **se estica até a largura do filho mais largo** (ex.: uma tabela de 9
colunas). Resultado: a coluna de conteúdo inteira (cabeçalhos, descrições, tudo)
é empurrada pra direita e "sai da tela" — mesmo que você já tenha deixado os
cabeçalhos centralizados.

> Sintoma típico: você arruma o cabeçalho com `flex-col`, mas no celular **tudo
> continua deslocado pra direita**. A culpa não é do cabeçalho — é do container.

**Correção:** não use `ScrollArea` do Radix para envolver áreas que contêm
tabelas largas. Troque por um `div` com scroll nativo e **trave o eixo X**:

```diff
- <ScrollArea className="h-full">
-   <div className="max-w-4xl p-4 sm:p-6 lg:p-8">
+ <div className="h-full overflow-y-auto overflow-x-hidden">
+   <div className="max-w-4xl min-w-0 p-4 sm:p-6 lg:p-8">
      {conteúdo...}
-   </div>
- </ScrollArea>
+   </div>
+ </div>
```

E no container flex pai (ex.: a `<main>` que segura o conteúdo), garanta `min-w-0`
para o item flex poder encolher (ver padrão 4):

```diff
- <main className="flex-1 overflow-hidden">
+ <main className="flex-1 min-w-0 overflow-hidden">
```

Com isso: a página fica contida e **cada tabela passa a rolar dentro do próprio
card** (porque o `<Table>` do shadcn já vem com um wrapper
`relative w-full overflow-auto`).

---

### 2. `grid grid-cols-2` (ou 3) que **não colapsa** no celular
Layouts de formulário/modal feitos em 2 colunas fixas. No desktop ficam ótimos;
no celular as duas colunas espremem e o conteúdo estoura.

**Correção:** sempre torne o grid responsivo — 1 coluna no celular, 2+ a partir
de um breakpoint:

```diff
- <div className="grid grid-cols-2 gap-4">
+ <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
```

```diff
- <div className="grid grid-cols-3 gap-3">
+ <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
```

> Regra prática: **nenhum `grid-cols-2`/`grid-cols-3` deve existir sem um
> `grid-cols-1` antes dele** (a não ser que sejam itens minúsculos, tipo dois
> botões pequenos que cabem lado a lado em 320px).

Se um item precisa ocupar a linha toda quando vira 2 colunas, use `sm:col-span-2`
em vez de `col-span-2` (senão ele ocupa 2 de 1 no mobile e quebra o cálculo).

---

### 3. Larguras fixas em `px` maiores que a tela
Qualquer `w-[450px]`, `w-[600px]`, `min-w-[400px]` sem proteção responsiva vai
estourar num celular de ~360–375px. Clássico em **chats/painéis flutuantes**
(`position: fixed`) e em popovers.

**Correção:** largura responsiva — quase tela cheia no celular, largura fixa só a
partir de `sm:`/`md:`:

```diff
- "bottom-6 right-6 w-[450px] h-[650px]"
+ "inset-x-3 bottom-3 w-auto h-[75vh] sm:inset-x-auto sm:left-auto sm:bottom-6 sm:right-6 sm:w-[450px] sm:h-[650px]"
```

⚠️ **Cuidado com `tailwind-merge` / variant-leak:** se um estado (ex.: "minimizado")
sobrescreve a altura com `h-14`, mas a base agora tem `sm:h-[650px]`, em telas
`sm+` o `sm:h-[650px]` ganha do `h-14` (são variantes diferentes, ambas
permanecem). Sobrescreva **em todos os breakpoints**:

```diff
- isMinimized && "h-14"
+ isMinimized && "h-14 sm:h-14"
```

---

### 4. Pitfall do Flexbox/Grid: filhos que não encolhem (`min-width: auto`)
Por padrão, um item flex/grid tem `min-width: auto`, ou seja, **não encolhe abaixo
do tamanho do seu conteúdo (`min-content`)**. Dois casos mordem com frequência:

**(a) `<input>` dentro de um container estreito.** Um `<input>` tem largura
intrínseca (~`size=20` ≈ 180px). Mesmo com `flex-1`, ele não encolhe abaixo
disso e estoura a coluna. Foi exatamente o que fez o modal "Nova Tarefa"
vazar 91px mesmo já estando em coluna única (o culpado era um componente
`TimeInput` com `<input>` interno).

**Correção:** adicione `min-w-0` no input (e/ou no item flex que o contém):

```diff
- className="flex-1 bg-transparent outline-none ..."
+ className="flex-1 min-w-0 bg-transparent outline-none ..."
```

**(b) Item flex que contém algo largo (tabela, texto sem quebra).** Adicione
`min-w-0` no item flex (ex.: a `<main>` do padrão 1) para ele poder encolher e
deixar o filho rolar internamente em vez de empurrar a página.

> Regra prática: ao depurar "form/modal estourando em coluna única", procure
> `<input>` sem `min-w-0` e itens flex/grid sem `min-w-0`.

---

## Padrões secundários (menos críticos, mas apareceram)

### 5. Cabeçalho `flex justify-between` (título + botão) que não quebra
No celular, título grande + botão na mesma linha espremem.

```diff
- <CardHeader className="flex flex-row items-center justify-between">
+ <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div className="min-w-0"> {/* título */} </div>
-   <Button>...</Button>
+   <Button className="w-full sm:w-auto shrink-0">...</Button>
  </CardHeader>
```
(O `min-w-0` no bloco de título permite truncar; `shrink-0` impede o botão de ser esmagado.)

### 6. Grupos de botões / `RadioGroup` em linha que não cabem
```diff
- <div className="flex gap-2">           {/* 3 botões */}
+ <div className="flex flex-wrap gap-2">
```
```diff
- <RadioGroup className="flex gap-3">    {/* 3 opções: "Nenhum" cortava */}
+ <RadioGroup className="flex flex-wrap gap-2">
```

### 7. Tabelas com muitas colunas = "tabela estranha"
Mesmo com a tabela rolando dentro do card (padrão 1), uma tabela de 6–9 colunas
fica ruim de usar no celular. Esconda colunas secundárias por breakpoint,
mantendo só as essenciais no mobile. **Aplique a mesma classe no `<TableHead>` e
no `<TableCell>` correspondente:**

```tsx
{/* Mantém no celular: Nome, Status, Ações. Esconde o resto. */}
<TableHead>Nome</TableHead>
<TableHead className="hidden sm:table-cell">Cargo</TableHead>
<TableHead className="hidden md:table-cell">WhatsApp</TableHead>
<TableHead className="hidden lg:table-cell">Email</TableHead>
<TableHead className="hidden xl:table-cell">Telefone</TableHead>
<TableHead className="text-center">Status</TableHead>
<TableHead>Ações</TableHead>
...
<TableCell>{m.name}</TableCell>
<TableCell className="hidden sm:table-cell">{m.role}</TableCell>
<TableCell className="hidden md:table-cell">{m.whatsapp}</TableCell>
<TableCell className="hidden lg:table-cell">{m.email}</TableCell>
<TableCell className="hidden xl:table-cell">{m.phone}</TableCell>
<TableCell className="text-center">{status}</TableCell>
<TableCell>{actions}</TableCell>
```
Critério: deixe visível no mobile **identificação + status + ação principal**;
jogue dados detalhados (email, telefone, IDs, datas) para `md:`/`lg:`/`xl:`.

### 8. Texto longo sem quebra estourando (URLs, tokens)
```diff
- <code className="block ...">{webhookUrl}</code>
+ <code className="block ... break-all">{webhookUrl}</code>
```
Use `break-all` em URLs/tokens; `break-words` em parágrafos longos.

### 9. Altura sem scroll (conteúdo "bate" e não rola pra baixo)
Quando um conteúdo (ex.: calendário) é renderizado dentro de um container com
`overflow-hidden` e altura fixa, mas o filho não recebe altura/scroll, o conteúdo
é cortado. Garanta a cadeia de altura + scroll interno:

```diff
- <div className="flex flex-col">          {/* sem altura → estoura/corta */}
+ <div className="flex flex-col h-full min-h-0"> {/* ocupa o pai e deixa filho rolar */}
    ...
    <div className="flex-1 overflow-auto">{conteúdo rolável}</div>
  </div>
```
Regra: para `flex-1 overflow-auto` funcionar, **todos os ancestrais flex precisam
de altura definida e `min-h-0`** (o `min-h-0` é o equivalente vertical do
`min-w-0` do padrão 4).

### 10. Componente reaproveitado em contextos com/sem padding
Se um componente é usado tanto numa página (que já tem padding do layout) quanto
embutido em outro lugar sem padding (ex.: um "cockpit"), ele encosta nas bordas
no segundo caso. Adicione o padding **no wrapper do contexto que não tem**, não
no componente compartilhado (senão duplica padding na página):

```tsx
// Wrapper do contexto sem padding:
<div className="h-full min-h-0 px-3 sm:px-4 pt-2">
  <ComponenteCompartilhado />
</div>
```

---

## Checklist de varredura para o outro projeto

Rode estes greps e revise cada ocorrência:

```bash
# 1. ScrollArea envolvendo conteúdo com tabela (padrão 1)
grep -rn "ScrollArea" src/ | grep -iE "settings|config|page|content"

# 2. grids fixos não responsivos (padrão 2)
grep -rnE 'grid-cols-(2|3|4)' src/ | grep -vE 'sm:grid-cols|md:grid-cols|lg:grid-cols|grid-cols-1'

# 3. larguras fixas grandes (padrão 3)
grep -rnE 'w-\[(4|5|6|7|8|9)[0-9]{2}px\]|min-w-\[(3|4|5|6|7|8|9)[0-9]{2}px\]' src/

# 4. inputs custom dentro de flex (padrão 4a) — revisar componentes de input/time/search
grep -rnE 'flex-1' src/components/ui/

# 5. cabeçalhos título+botão (padrão 5)
grep -rnE 'flex (flex-row )?items-center justify-between' src/ | grep -iE 'header|CardHeader'

# 6. URLs/tokens em <code> sem break (padrão 8)
grep -rnE '<code' src/ | grep -iE 'url|token|webhook|secret'
```

Para cada hit, aplique a correção do padrão correspondente. Depois, **verifique a
375px** com o detector de overflow da seção "Como diagnosticar".

---

## Resumo dos arquivos alterados neste projeto (referência)

| Arquivo | Padrão(ões) aplicado(s) |
|---|---|
| `src/pages/SettingsUnified.tsx` | 1 (ScrollArea→div) + 4 (`min-w-0` na `<main>`) |
| `src/pages/SalesSettings.tsx` | 2 (grids), 5 (cabeçalhos), 7 (colunas Membros/Produtos) |
| `src/pages/TeamMeetings.tsx` | 2 (grid do modal), 6 (RadioGroup) |
| `src/components/tasks/CreateTaskModal.tsx` | 2 (grid 2-col), 6 (RadioGroup) |
| `src/components/ui/time-input.tsx` | 4a (`min-w-0` no `<input>`) — corrige todos os modais que usam |
| `src/components/sales/ai/SalesAIChat.tsx` | 3 (largura fixa do chat) + caveat twMerge |
| `src/components/settings/sections/SuperAdminTenantsSection.tsx` | 5 (cabeçalho), 7 (colunas tabela) |
| `src/components/calls/WavoipAdminPanel.tsx` | 2 (cards `grid-cols-3`), 7 (colunas tabela) |
| `src/components/cockpit/CockpitTabPipeline.tsx` | 10 (padding no wrapper) |
| `src/components/settings/NotificationRulesBuilder.tsx` | 5 (cabeçalho), 2 (grid do modal) |
| `src/components/settings/WhatsAppTaskBotConfig.tsx` | 5 (cabeçalho), 2 (grids) |
| `src/components/settings/sections/GoogleCalendarSection.tsx` | 5 (linhas status), 6 (botões) |

> Bug extra encontrado na verificação (não é de layout, mas vale conferir no outro
> projeto): label com escape unicode literal — o texto `Responsável` aparecia
> cru na tela porque, **em texto JSX, `á` NÃO é interpretado** (vira literal).
> Solução: escrever o caractere real (`Responsável`) direto no JSX.

---

## Como validar (sem chutar)

1. Suba o app e abra em **375px** (DevTools → preset mobile, ou viewport 375×812).
2. Rode o detector de overflow (seção "Como diagnosticar") em cada tela.
   Meta: **`pageOverflow === 0`** em todas.
3. Para modais/forms, abra-os e meça `form.scrollWidth - form.clientWidth` — deve
   dar **0**.
4. Tabelas: confirme que rolam **dentro do card** (o wrapper
   `relative w-full overflow-auto` tem `scrollWidth > clientWidth`), e que a
   página NÃO rola de lado.
5. `npx tsc --noEmit` para garantir que nada quebrou em tipos.

---

## TL;DR (a regra de ouro)

> No celular, **nada deve empurrar a largura da página**. Conteúdo largo (tabela,
> texto, input) deve **encolher (`min-w-0`)**, **rolar dentro do próprio card
> (`overflow-auto` + container com `overflow-x-hidden`)** ou **quebrar linha
> (`flex-wrap`, `break-all`)** — nunca vazar pra fora. Layouts de 2+ colunas
> **sempre** começam em 1 coluna no mobile.
