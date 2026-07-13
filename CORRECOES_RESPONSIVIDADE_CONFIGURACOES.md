# Correções de Responsividade e Funcionalidades — Seção de Configurações

> Aplique estas correções em ordem. Cada bloco indica o arquivo, o problema original e o código correto.

---

## 1. `src/pages/SettingsUnified.tsx` — Layout mobile com navegação sidebar → conteúdo

**Problema:** No mobile, a sidebar de 260 px ocupava a tela inteira e o conteúdo ficava invisível. Não havia forma de navegar de volta ao menu após abrir uma seção. Além disso, havia um `x` solto no código que causava crash ao carregar a página.

**Dependências novas:**
```tsx
import { useState } from "react";            // já deve existir
import { ChevronLeft } from "lucide-react";  // adicionar ao bloco de imports do lucide
```

**Correções no componente:**

```tsx
// 1. Adicionar estado de alternância mobile (dentro do componente, antes de handleNavigate)
const [mobileShowContent, setMobileShowContent] = useState(false);

// 2. Atualizar handleNavigate para ativar o conteúdo no mobile
const handleNavigate = (sectionId: string) => {
  setSearchParams({ s: sectionId });
  setMobileShowContent(true);   // <-- linha nova
};

// 3. Remover o "x" solto que causava crash (logo após o .filter)
// ANTES (com bug):
.filter((section) => section.items.length > 0); 
}, [isAdmin, isSuperAdmin]);x   // <-- "x" aqui quebrava o build

// DEPOIS (correto):
.filter((section) => section.items.length > 0);
}, [isAdmin, isSuperAdmin]);
```

**Correções no JSX — wrapper externo:**
```tsx
// ANTES:
<div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">

// DEPOIS (remove o double-padding do AppLayout):
<div className="flex h-[calc(100vh-3.5rem)] overflow-hidden -m-4 sm:-m-6">
```

**Sidebar (`<aside>`):**
```tsx
// ANTES:
<aside className="w-[260px] shrink-0 border-r border-border/50 bg-background/50">

// DEPOIS:
<aside
  className={cn(
    "w-full md:w-[260px] shrink-0 border-r border-border/50 bg-background/50",
    mobileShowContent && "max-md:hidden",
  )}
>
```

**Área de conteúdo (`<main>`):**
```tsx
// ANTES:
<main className="flex-1 overflow-hidden">
  <ScrollArea className="h-full">
    <div className="max-w-4xl p-6 lg:p-8">

// DEPOIS (ScrollArea substituído por div nativa para evitar overflow horizontal):
<main
  className={cn(
    "flex-1 min-w-0 overflow-hidden",
    !mobileShowContent && "max-md:hidden",
  )}
>
  <div className="h-full overflow-y-auto overflow-x-hidden">
    <div className="max-w-4xl min-w-0 p-4 sm:p-6 lg:p-8">

      {/* Botão voltar — só no mobile */}
      <button
        onClick={() => setMobileShowContent(false)}
        className="md:hidden flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ChevronLeft className="h-4 w-4" />
        Configurações
      </button>

      {/* ... resto do conteúdo ... */}

    </div>
  </div>
</main>
```

> **Fechar os novos wrappers:** o `</ScrollArea>` antigo vira `</div>` (div de scroll) e o `</main>` fecha normalmente.

---

## 2. `src/pages/SalesSettings.tsx` — Múltiplas correções de responsividade

### 2a. Tabela de Produtos — ocultar colunas no mobile

```tsx
// ANTES (cabeçalho):
<TableHead>SKU</TableHead>
<TableHead>Categoria</TableHead>

// DEPOIS:
<TableHead className="hidden md:table-cell">SKU</TableHead>
<TableHead className="hidden sm:table-cell">Categoria</TableHead>

// ANTES (células):
<TableCell className="text-muted-foreground">{product.sku || "-"}</TableCell>
<TableCell>{product.category || "-"}</TableCell>

// DEPOIS:
<TableCell className="hidden md:table-cell text-muted-foreground">{product.sku || "-"}</TableCell>
<TableCell className="hidden sm:table-cell">{product.category || "-"}</TableCell>
```

### 2b. Tabela de Equipe — ocultar colunas no mobile

```tsx
// ANTES (cabeçalhos):
<TableHead>Email</TableHead>
<TableHead>Telefone</TableHead>
<TableHead>Cargo</TableHead>
<TableHead>Time</TableHead>
<TableHead>WhatsApp</TableHead>
<TableHead>Ligações (WaVoIP)</TableHead>

// DEPOIS:
<TableHead className="hidden lg:table-cell">Email</TableHead>
<TableHead className="hidden xl:table-cell">Telefone</TableHead>
<TableHead className="hidden sm:table-cell">Cargo</TableHead>
<TableHead className="hidden lg:table-cell">Time</TableHead>
<TableHead className="hidden md:table-cell">WhatsApp</TableHead>
<TableHead className="hidden xl:table-cell">Ligações (WaVoIP)</TableHead>

// ANTES (células correspondentes):
<TableCell className="text-muted-foreground text-sm">...</TableCell>  // email
<TableCell className="text-muted-foreground text-sm">...</TableCell>  // telefone
<TableCell>...</TableCell>  // cargo
<TableCell>...</TableCell>  // time
<TableCell>...</TableCell>  // whatsapp
<TableCell>...</TableCell>  // wavoip

// DEPOIS:
<TableCell className="hidden lg:table-cell text-muted-foreground text-sm">...</TableCell>
<TableCell className="hidden xl:table-cell text-muted-foreground text-sm">...</TableCell>
<TableCell className="hidden sm:table-cell">...</TableCell>
<TableCell className="hidden lg:table-cell">...</TableCell>
<TableCell className="hidden md:table-cell">...</TableCell>
<TableCell className="hidden xl:table-cell">...</TableCell>
```

### 2c. Headers com botão ao lado do título — quebrar para coluna no mobile

Padrão a aplicar em **todos** os `CardHeader` / divs que têm título + botão lado a lado:

```tsx
// ANTES (Produtos, Equipe, Comissões, Playbooks):
<div className="flex items-center justify-between">
  <div>...</div>
  <Button>...</Button>
</div>

// DEPOIS:
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div className="min-w-0">...</div>
  <Button className="w-full sm:w-auto shrink-0">...</Button>
</div>
```

Aplicar nos seguintes componentes/seções:
- **Produtos** (`ProductsTab`) — botão "Novo Produto"
- **Gestão de Equipe** (`TeamTab`) — botão "Novo Membro"
- **Comissões** (`CommissionsTab`) — tabs Lista/Regras/Gateways
- **Playbooks** (`PlaybooksTab`) — tabs Editar/Preview + botão salvar

Para a aba de **Comissões** (tabs inline no header):
```tsx
// ANTES:
<Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
  <TabsList>
    <TabsTrigger value="list">Lista</TabsTrigger>
    <TabsTrigger value="rules">Regras</TabsTrigger>
    <TabsTrigger value="gateways">Gateways</TabsTrigger>
  </TabsList>
</Tabs>

// DEPOIS:
<Tabs value={activeSubTab} onValueChange={setActiveSubTab} className="w-full sm:w-auto">
  <TabsList className="w-full sm:w-auto">
    <TabsTrigger value="list" className="flex-1 sm:flex-none">Lista</TabsTrigger>
    <TabsTrigger value="rules" className="flex-1 sm:flex-none">Regras</TabsTrigger>
    <TabsTrigger value="gateways" className="flex-1 sm:flex-none">Gateways</TabsTrigger>
  </TabsList>
</Tabs>
```

Para **Playbooks** (botões de ação no header):
```tsx
// ANTES:
<div className="flex items-center gap-2">

// DEPOIS:
<div className="flex flex-wrap items-center gap-2">
```

### 2d. Grids 2 colunas fixas → responsivos nos modais

Todos os `grid grid-cols-2` dentro de dialogs/modais devem ser:

```tsx
// ANTES:
<div className="grid grid-cols-2 gap-4">

// DEPOIS:
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

Locais afetados em `SalesSettings.tsx`:
- Modal de Templates de Análise (nome + tipo)
- Modal de Criar Produto (preço + categoria)
- Modal de Criar Membro (nome + email, cargo + time)
- Modal de Editar Membro (nome + email, cargo + time)
- Modal de Conta Instagram (business ID + token)
- Modal de Regra Instagram (nome + tipo, de estágio + para estágio)

---

## 3. `src/components/settings/sections/GoogleCalendarSection.tsx`

### 3a. Status de conexão — quebrar layout no mobile

```tsx
// ANTES:
<div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
  <div className="flex items-center gap-3">

// DEPOIS:
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-4 bg-muted/50 rounded-lg">
  <div className="flex items-center gap-3 min-w-0">
```

### 3b. Toggle de sincronização automática

```tsx
// ANTES:
<div className="flex items-center justify-between">
  <div>

// DEPOIS:
<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
  <div className="min-w-0">
```

### 3c. Botões de ação — permitir quebra de linha

```tsx
// ANTES:
<div className="flex gap-2">

// DEPOIS:
<div className="flex flex-wrap gap-2">
```

---

## 4. `src/components/settings/NotificationRulesBuilder.tsx`

### 4a. Header com botão "Nova Automação"

```tsx
// ANTES:
<CardHeader className="flex flex-row items-center justify-between">
  <div className="flex items-center gap-3">
    <div className="p-2 rounded-lg bg-purple-500/10">
  <div>
    <CardTitle>...</CardTitle>
  </div>
  <Button onClick={() => handleOpenModal()} className="gap-2">

// DEPOIS:
<CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div className="flex items-center gap-3 min-w-0">
    <div className="p-2 rounded-lg bg-purple-500/10 shrink-0">
  <div className="min-w-0">
    <CardTitle>...</CardTitle>
  </div>
  <Button onClick={() => handleOpenModal()} className="gap-2 w-full sm:w-auto shrink-0">
```

### 4b. Grid de gatilho no modal

```tsx
// ANTES:
<div className="grid grid-cols-2 gap-4">

// DEPOIS:
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

### 4c. Campo "Tempo" que ocupava 2 colunas

```tsx
// ANTES:
<div className="space-y-2 col-span-2">

// DEPOIS:
<div className="space-y-2 sm:col-span-2">
```

---

## 5. `src/components/settings/WhatsAppTaskBotConfig.tsx`

### 5a. Header do bot

```tsx
// ANTES:
<div className="flex items-center justify-between">
  <div className="flex items-center gap-3">
    <div className="p-2 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600">
  <div>

// DEPOIS:
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div className="flex items-center gap-3 min-w-0">
    <div className="p-2 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 shrink-0">
  <div className="min-w-0">
```

### 5b. Botão Ativar/Desativar bot

```tsx
// Adicionar className ao Button existente:
className="w-full sm:w-auto shrink-0"
```

### 5c. Grids 2 colunas fixas no formulário de configuração

```tsx
// ANTES (duas ocorrências):
<div className="grid grid-cols-2 gap-4">

// DEPOIS:
<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
```

### 5d. Header da aba "Grupos"

```tsx
// ANTES:
<div className="flex items-center justify-between">
  <div>
    <CardTitle className="text-lg">Grupos Habilitados</CardTitle>
  </div>
  <Button variant="outline" onClick={handleSyncGroups} ...>

// DEPOIS:
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
  <div className="min-w-0">
    <CardTitle className="text-lg">Grupos Habilitados</CardTitle>
  </div>
  <Button variant="outline" onClick={handleSyncGroups} ... className="w-full sm:w-auto shrink-0">
```

---

## 6. `src/hooks/useTeamMembers.ts` + `src/pages/SalesSettings.tsx` — Resetar senha de membro

**Problema:** O modal de resetar senha não chamava a edge function corretamente; o campo de senha na criação de membro não validava mínimo de 6 caracteres antes de habilitar o botão.

**Botão de criar membro — validação:**
```tsx
// ANTES:
disabled={!createForm.name || !createForm.email || createMember.isPending}

// DEPOIS:
disabled={!createForm.name || !createForm.email || createForm.password.length < 6 || createMember.isPending}
```

**Modal de reset de senha — campo e botão já existem; garantir que o hook `resetPassword` chama `manage-team-member` com action `reset_password`:**

Em `useTeamMembers.ts`, a mutation de reset deve fazer:
```ts
const { error } = await supabase.functions.invoke("manage-team-member", {
  body: { action: "reset_password", member_id, new_password },
});
```

---

## 7. `src/contexts/AuthContext.tsx` + Edge Function `manage-team-member` — Desativar usuário não bloqueava o login

**Problema:** Desativar um membro no CRM (`is_active = false`) não impedia que ele continuasse logado ou fizesse novo login.

### 7a. `src/contexts/AuthContext.tsx` — bloquear sessão ao carregar

Nos dois pontos onde `setTeamMember(tm)` é chamado (carregamento inicial e `onAuthStateChange`), substituir por:

```tsx
if (tm.is_active === false) {
  await supabase.auth.signOut();
  setSession(null);
  setUser(null);
  setTeamMember(null);
  sessionRef.current = null;     // só no carregamento inicial
  // hasInitiallySignedIn = false; // só no onAuthStateChange
} else {
  setTeamMember(tm);
  // linkAuthUser(...);  // só no onAuthStateChange
}
```

### 7b. Edge Function `supabase/functions/manage-team-member/index.ts` — banir conta no Auth

Na action `toggle_active`, após atualizar `is_active` na tabela, buscar o `auth_user_id` e banir/desbanir a conta:

```ts
// No select, adicionar auth_user_id:
.select("id, auth_user_id")   // era apenas "id"

// Após o update bem-sucedido:
const authUserId = updated[0].auth_user_id as string | null;
if (authUserId) {
  const { error: banErr } = await supabase.auth.admin.updateUserById(authUserId, {
    ban_duration: is_active ? "none" : "876000h", // ~100 anos = banido indefinidamente
  });
  if (banErr) {
    console.error("[manage-team-member] Falha ao (des)banir conta:", banErr.message);
  }
}
```

---

## 8. `src/components/ui/phone-input.tsx` (arquivo novo) — Máscara de telefone

**Problema:** Campos de telefone aceitavam qualquer texto sem formatação.

Criar o componente `src/components/ui/phone-input.tsx`:

```tsx
import { Input } from "@/components/ui/input";

interface PhoneInputProps {
  id?: string;
  value: string;
  onChange: (digits: string) => void;
  placeholder?: string;
}

export function PhoneInput({ id, value, onChange, placeholder = "(11) 99999-9999" }: PhoneInputProps) {
  const format = (raw: string) => {
    const d = raw.replace(/\D/g, "").slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : "";
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  };

  return (
    <Input
      id={id}
      type="tel"
      value={format(value)}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
      placeholder={placeholder}
    />
  );
}
```

**Usar em:**
- `src/components/settings/sections/SuperAdminTenantsSection.tsx` — campos de telefone no dialog de nova loja e convidar admin
- `src/pages/SalesSettings.tsx` — campo telefone no modal de criar/editar membro

```tsx
import { PhoneInput } from "@/components/ui/phone-input";

// Substituir:
<Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />

// Por:
<PhoneInput value={phone} onChange={(digits) => setPhone(digits)} />
```

---

## Resumo das correções por arquivo

| Arquivo | Correções |
|---------|-----------|
| `src/pages/SettingsUnified.tsx` | Layout mobile menu↔conteúdo, botão voltar, correção de crash (`x` solto), padding ajustado |
| `src/pages/SalesSettings.tsx` | Tabelas com colunas ocultas no mobile, headers com botão em coluna, grids de modal responsivos, validação de senha |
| `src/components/settings/sections/GoogleCalendarSection.tsx` | Status de conexão e toggle de sync em coluna no mobile |
| `src/components/settings/NotificationRulesBuilder.tsx` | Header em coluna, grid de modal responsivo, col-span condicional |
| `src/components/settings/WhatsAppTaskBotConfig.tsx` | Header em coluna, botões full-width no mobile, grids responsivos |
| `src/contexts/AuthContext.tsx` | Bloquear sessão de membro desativado ao carregar |
| `supabase/functions/manage-team-member/index.ts` | Banir conta no Auth ao desativar membro |
| `src/components/ui/phone-input.tsx` *(novo)* | Componente de input com máscara de telefone brasileiro |
| `src/components/settings/sections/SuperAdminTenantsSection.tsx` | Usar `PhoneInput` nos campos de telefone |
