# Mudanças no Pipeline — Guia de Transferência

Este documento descreve **todas as alterações** feitas nos arquivos de pipeline em relação ao commit inicial (`24abc4d`). Use-o para replicar as mudanças no sistema espelhado.

---

## Arquivos modificados

| Arquivo | Tipo de mudança |
|---|---|
| `src/pages/SalesPipeline.tsx` | Responsividade, filtros, nomes, superadmin |
| `src/components/sales/PipelineKanban.tsx` | Cards, mover etapa, badges portais, nomes |
| `src/hooks/useSalesPipeline.ts` | Query de leads, cálculo de dias na etapa |
| `src/hooks/usePipelineConfig.ts` | Etapas padrão no create, nome do tenant |

---

## 1. `src/pages/SalesPipeline.tsx`

### 1.1 Troca de nomes ("deal" → "negociação")

Todos os textos voltados ao usuário que usavam **"deal"** foram substituídos por **"negociação"**:

| Antes | Depois |
|---|---|
| `Novo Deal` (botão) | `Nova Negociação` |
| `"Deal transferido para Closer"` (toast) | `"Negociação transferida para Closer"` |
| `"Deal movido"` (toast) | `"Negociação movida"` |
| `"Erro ao mover deal"` (toast) | `"Erro ao mover negociação"` |
| `"Tem certeza que deseja excluir este deal?"` | `"...excluir esta negociação?"` |
| `"Deal excluído com sucesso"` | `"Negociação excluída com sucesso"` |
| `"Erro ao excluir deal"` | `"Erro ao excluir negociação"` |
| `"Crie seu primeiro deal para visualizá-lo aqui"` | `"Crie sua primeira negociação para visualizá-la aqui"` |
| `"Criar deal"` (botão empty state) | `"Criar negociação"` |
| `"Maior valor deal"` (sort option) | `"Maior valor negociação"` |

### 1.2 Responsividade do header

O header do pipeline passou de um layout fixo para um layout responsivo:

```tsx
// ANTES
<div className="flex items-center justify-between">
  <div className="flex items-center gap-4">
    <h1 className="text-2xl font-semibold text-slate-900">Pipeline</h1>

// DEPOIS
<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
  <div className="flex items-center gap-2 sm:gap-4 min-w-0 overflow-x-auto">
    <h1 className="text-xl sm:text-2xl font-semibold text-slate-900 shrink-0">Pipeline</h1>
```

- Botões de pipeline tabs receberam `whitespace-nowrap shrink-0`
- Botões de ação receberam `shrink-0`

### 1.3 Responsividade do popover de filtros

```tsx
// ANTES
<PopoverContent align="start" className="w-[420px] p-0">

// DEPOIS
<PopoverContent align="start" className="w-[420px] max-w-[calc(100vw-1.5rem)] p-0">
```

### 1.4 Novo filtro: Portal de origem

Adicionado `portalFilter` com estado persistido em sessão:

```tsx
const [portalFilter, setPortalFilter] = useSessionState<string>("pipeline_portalFilter", "all");
```

**Lógica de filtragem** (dentro do `useMemo` de `filteredPipeline`):

```tsx
// Filtro de portal (origem do lead: credere, marketplace, stand/totem)
if (hasPortalFilter) {
  const leadSrc = ((deal.lead as any)?.source || "").toLowerCase();
  if (portalFilter === "_sem_portal") {
    if (leadSrc === "credere" || leadSrc === "marketplace" || leadSrc === "stand") return false;
  } else if (leadSrc !== portalFilter) return false;
}
```

**UI do filtro** (dentro do `<PopoverContent>` de filtros avançados, PRIMEIRO item do grid):

```tsx
{/* Portal de origem */}
<div>
  <label className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1.5 block">Portal</label>
  <Select value={portalFilter} onValueChange={setPortalFilter}>
    <SelectTrigger className="h-9 text-sm border-slate-200">
      <Store className="h-3.5 w-3.5 mr-2 text-slate-400" />
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="all">Todos</SelectItem>
      <SelectItem value="credere">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
          Credere
        </span>
      </SelectItem>
      <SelectItem value="marketplace">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-orange-500"></span>
          Marketplace Digital
        </span>
      </SelectItem>
      <SelectItem value="stand">
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-teal-500"></span>
          IA de Qualificação
        </span>
      </SelectItem>
      <SelectItem value="_sem_portal">Sem portal</SelectItem>
    </SelectContent>
  </Select>
</div>
```

**Import necessário:** adicionar `Store` no import do `lucide-react`.

**Badge de filtro ativo** (no array `activeAdvancedFilters`):

```tsx
const PORTAL_LABELS: Record<string, string> = {
  credere: "Credere",
  marketplace: "Marketplace Digital",
  stand: "IA de Qualificação",
  _sem_portal: "Sem portal"
};

// Dentro do useMemo de activeAdvancedFilters:
if (portalFilter !== "all") filters.push({ key: "portal", label: `Portal: ${PORTAL_LABELS[portalFilter] || portalFilter}`, onRemove: () => setPortalFilter("all") });
```

**Botão "Limpar filtros":** adicionar `setPortalFilter("all")` junto com os outros resets.

**`hasActiveFilters`:** adicionar `portalFilter !== "all"` na condição.

**Dependências dos `useMemo`:** adicionar `portalFilter` nos arrays de dependência de `filteredPipeline` e `activeAdvancedFilters`.

### 1.5 Suporte a Superadmin

Importar `isSuperAdmin` do `useAuth`:

```tsx
const { teamMember, isSuperAdmin } = useAuth();
```

**Aba "Todas" (só visível para superadmin)** — dentro do bloco de tabs de pipeline:

```tsx
{isSuperAdmin && (
  <button
    onClick={() => setSelectedPipelineId("__all__" as any)}
    className={`px-3 py-1 rounded-full text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
      (selectedPipelineId as any) === "__all__"
        ? "bg-primary text-primary-foreground"
        : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
    }`}
  >
    Todas
  </button>
)}
```

**Exibir nome do tenant nas tabs** (superadmin vê nome da loja em vez do nome do pipeline):

```tsx
{isSuperAdmin ? ((p as any).tenants?.name || p.name) : p.name}
```

**`activePipelineId` — lógica de `"__all__"`:**

```tsx
// ANTES
const activePipelineId =
  selectedPipelineId ||
  pipelines?.find((p) => p.is_default)?.id ||
  pipelines?.[0]?.id;

// DEPOIS
const activePipelineId =
  (selectedPipelineId as any) === "__all__"
    ? undefined
    : selectedPipelineId ||
      pipelines?.find((p) => p.is_default)?.id ||
      pipelines?.[0]?.id;
```

---

## 2. `src/components/sales/PipelineKanban.tsx`

### 2.1 Imports alterados

```tsx
// REMOVIDO
import { Star } from "lucide-react";           // star type toggle removido
import { useUpdateLeadSales } from "@/hooks/useSalesLeads"; // não é mais usado aqui

// ADICIONADO
import { ChevronRight } from "lucide-react";    // ícone do botão "mover para"
```

### 2.2 Mover card diretamente para outra etapa (sem drag)

Adicionado botão de mover (substituiu o botão de estrela) em cada card para permitir mover negociações em mobile sem drag & drop.

**Em `PipelineKanban` (componente raiz):**

```tsx
// useMemo para calcular etapas ativas (excluindo ganho/perdido)
const activeStages = useMemo(
  () => columns.filter(c => !c.stage.is_won && !c.stage.is_lost).map(c => ({ id: c.stage.id, name: c.stage.name })),
  [columns]
);

// Passar para KanbanColumn:
<KanbanColumn
  ...
  allStages={activeStages}
  onMoveToStage={(dealId, fromStageId, toStageId) => onDealMove?.(dealId, fromStageId, toStageId)}
/>
```

**Interface `KanbanColumnProps`:**

```tsx
interface KanbanColumnProps {
  ...
  allStages: { id: string; name: string }[];
  onMoveToStage: (dealId: string, fromStageId: string, toStageId: string) => void;
}
```

**Em `KanbanColumn`:** repassar para `DealCard`:

```tsx
<DealCard
  ...
  allStages={allStages}
  onMoveToStage={(dealId, toStageId) => onMoveToStage(dealId, stage.id, toStageId)}
/>
```

**Em `DealCard`:** substituir o botão de estrela pelo botão de mover:

```tsx
// Estado
const [movePopoverOpen, setMovePopoverOpen] = useState(false);

// Props adicionais
allStages?: { id: string; name: string }[];
onMoveToStage?: (dealId: string, toStageId: string) => void;

// JSX — substituir o bloco "Star indicator + toggle" por:
{!isFinalized && allStages && allStages.length > 1 && onMoveToStage && (
  <Popover open={movePopoverOpen} onOpenChange={setMovePopoverOpen}>
    <PopoverTrigger asChild>
      <button
        onClick={(e) => { e.stopPropagation(); setMovePopoverOpen(true); }}
        className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded opacity-100 sm:opacity-0 sm:group-hover:opacity-60 hover:!opacity-100 hover:bg-slate-100 transition-all"
      >
        <ChevronRight className="h-4 w-4 text-slate-400" />
      </button>
    </PopoverTrigger>
    <PopoverContent className="w-48 p-1" align="end" side="right" onClick={(e) => e.stopPropagation()}>
      <p className="text-xs font-medium text-slate-500 px-2 py-1">Mover para</p>
      {allStages.filter(s => s.id !== stageId).map(s => (
        <button
          key={s.id}
          onClick={(e) => {
            e.stopPropagation();
            onMoveToStage(deal.id, s.id);
            setMovePopoverOpen(false);
          }}
          className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-slate-100 truncate"
        >
          {s.name}
        </button>
      ))}
    </PopoverContent>
  </Popover>
)}
```

**Visibilidade:** sempre visível em mobile (`opacity-100`), aparece no hover em desktop (`sm:opacity-0 sm:group-hover:opacity-60`).

### 2.3 Remoção do sistema de estrelas (star_type)

Todo o código de estrela foi removido de `DealCard`:

- Removidos: `useUpdateLeadSales`, `starType`, `isOrangeStar`, `hasAnyStar`, `handleStarToggle`
- Removido: bloco JSX "Star indicator + toggle" com `<Star />`

### 2.4 Remoção do sort por estrela laranja

```tsx
// REMOVIDO do sort dentro de KanbanColumn:
// Orange star always goes to top
const starA = (a.lead as any)?.star_type === 'orange' ? 0 : 1;
const starB = (b.lead as any)?.star_type === 'orange' ? 0 : 1;
if (starA !== starB) return starA - starB;
```

### 2.5 Estilos do card — remoção da borda neon da estrela laranja

Simplificação das classes condicionais do card (o `isOrangeStar` foi removido de todas as condições):

```tsx
// ANTES — múltiplas condições com isOrangeStar
isOrangeStar && "border-2 border-[#009689] shadow-[0_0_8px_#009689] bg-teal-50/30",
!isOrangeStar && isNewDeal && "border-2 border-teal-500 ring-2 ring-teal-500/30 bg-teal-50/20",
!isOrangeStar && !isNewDeal && isCritical && "bg-red-50 ...",
...

// DEPOIS — sem isOrangeStar
isNewDeal && "border-2 border-teal-500 ring-2 ring-teal-500/30 bg-teal-50/20",
!isNewDeal && isCritical && "bg-red-50 ...",
...
```

### 2.6 Badge de portal de origem no card

Adicionado mapeamento de `lead.source` para badges coloridos dentro do bloco de badges do card:

```tsx
const leadSource = ((deal.lead as any)?.source || "").toLowerCase();
const PORTAL_MAP: Record<string, { label: string; cls: string }> = {
  credere: { label: "Credere", cls: "bg-indigo-100 text-indigo-700" },
  marketplace: { label: "Marketplace Digital", cls: "bg-orange-100 text-orange-700" },
  stand: { label: "IA de Qualificação", cls: "bg-teal-100 text-teal-700" },
};
const portal = PORTAL_MAP[leadSource];
if (!enrollment?.webinar_title && !utmSource && !portal) return null;

// No JSX, antes dos outros badges:
{portal && (
  <span className={cn("inline-flex items-center text-[9px] px-1.5 py-0.5 rounded font-semibold", portal.cls)} title={`Portal: ${portal.label}`}>
    {portal.label}
  </span>
)}
```

### 2.7 Exibição de valor — fallback para "Sem valor"

```tsx
// ANTES
{formatCurrency(dv(deal.negotiated_price || deal.expected_value || 0))}

// DEPOIS
{(deal.negotiated_price || deal.original_price)
  ? formatCurrency(dv(deal.negotiated_price || deal.original_price || 0))
  : <span className="text-slate-400 font-normal text-xs">Sem valor</span>}
```

Mudança: `expected_value` → `original_price` e trata caso sem valor.

### 2.8 Troca de nomes nos textos do Kanban

| Antes | Depois |
|---|---|
| `"Nenhum deal neste estágio"` | `"Nenhuma negociação neste estágio"` |
| `"+ Adicionar deal"` | `"+ Adicionar negociação"` |
| `"Excluir deal"` (tooltip) | `"Excluir negociação"` |
| `"Deal"` (fallback no popover de contatos) | `"Negociação"` |
| `"Deals ativos"` (header summary) | `"Negociações ativas"` |

---

## 3. `src/hooks/useSalesPipeline.ts`

### 3.1 Query de campos do lead simplificada

```ts
// ANTES — campos que não existem neste schema ou não são usados
lead:leads!deals_lead_id_fkey(
  id, name, phone, sales_score, star_type, acao_de_hoje,
  utm_source, utm_campaign, status_de_resposta, etapa_funil, sales_rep_id,
  instagram_profile_id, stage_changed_at, monthly_revenue, company_name, webinar_config_id
)

// DEPOIS — apenas campos que existem e são utilizados
lead:leads!deals_lead_id_fkey(
  id, name, phone, email, sales_score,
  utm_source, utm_campaign, utm_content, sales_rep_id,
  company_name, webinar_config_id, source
)
```

Campos **adicionados:** `email`, `utm_content`, `source`
Campos **removidos:** `star_type`, `acao_de_hoje`, `status_de_resposta`, `etapa_funil`, `instagram_profile_id`, `stage_changed_at`, `monthly_revenue`

### 3.2 Cálculo de dias na etapa — usar `deal.stage_changed_at`

```ts
// ANTES — usava campo do lead (que não existe no schema)
const stageChangeRef = deal.lead?.stage_changed_at || deal.created_at;

// DEPOIS — usa campo do deal (correto)
const stageChangeRef = deal.stage_changed_at || deal.created_at;
```

---

## 4. `src/hooks/usePipelineConfig.ts`

### 4.1 Query de pipelines — incluir nome do tenant

```ts
// ANTES
.select('*')
...
return (data || []) as SalesPipeline[];

// DEPOIS
.select('*, tenants(name)')
...
return (data || []) as (SalesPipeline & { tenants?: { name: string } | null })[];
```

### 4.2 Criar pipeline já semeando etapas padrão

Ao criar um novo pipeline (`useCreatePipeline`), o hook agora insere automaticamente as etapas padrão para este contexto (lojistas de veículos):

```ts
const pipelineId = (data as SalesPipeline).id;
const defaultStages = [
  { name: 'Novo Lead',                  position: 0, color: 'slate' },
  { name: 'Em Qualificação',            position: 1, color: 'blue' },
  { name: 'Test Drive',                 position: 2, color: 'cyan' },
  { name: 'Avaliação / Proposta',       position: 3, color: 'amber' },
  { name: 'Financiamento (Credere)',    position: 4, color: 'indigo' },
  { name: 'Ganho',                      position: 5, color: 'green', is_won: true },
  { name: 'Perdido',                    position: 6, color: 'red',   is_lost: true },
];
await supabase.from('sales_pipeline_stages').insert(
  defaultStages.map((s) => ({
    pipeline_id: pipelineId,
    name: s.name,
    position: s.position,
    color: s.color,
    is_won: s.is_won ?? false,
    is_lost: s.is_lost ?? false,
  }))
);
```

E invalida também as queries de stages:

```ts
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: ['pipelines'] });
  queryClient.invalidateQueries({ queryKey: ['pipeline-stages'] }); // NOVO
}
```

---

## Resumo das dependências entre mudanças

```
useSalesPipeline.ts (query com `source`)
    └─ PipelineKanban.tsx (badge de portal usa deal.lead.source)
    └─ SalesPipeline.tsx (filtro de portal usa deal.lead.source)

usePipelineConfig.ts (query com tenants(name))
    └─ SalesPipeline.tsx (isSuperAdmin exibe tenants?.name nas tabs)

PipelineKanban.tsx (allStages + onMoveToStage)
    └─ SalesPipeline.tsx (passa onDealMove como onMoveToStage)
```

---

## Checklist de transferência

- [ ] `src/hooks/useSalesPipeline.ts` — atualizar campos do select do lead + `stage_changed_at`
- [ ] `src/hooks/usePipelineConfig.ts` — join com `tenants(name)` + etapas padrão no create
- [ ] `src/components/sales/PipelineKanban.tsx` — remover estrela, adicionar botão mover, badges portais, fix valor, nomes
- [ ] `src/pages/SalesPipeline.tsx` — responsividade header, filtro portal, superadmin tabs, nomes
- [ ] Verificar que `deal.original_price` existe no tipo `Deal` e na tabela `deals`
- [ ] Verificar que `lead.source` existe na tabela `leads`
- [ ] Verificar que `deal.stage_changed_at` existe na tabela `deals`
