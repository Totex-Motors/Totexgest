# Repasse Relay — "TOTEX Abaixo da Tabela"

Captura os carros postados num **grupo de repasse** (onde a loja participa),
reescreve cada um no tom da TOTEX **com a margem já embutida** e reposta no
**grupo da comunidade**. Tudo automático, disparado pelo webhook da UAZAPI que
já existe.

## Como funciona (fluxo)

```
Grupo de repasse ──(msg nova)──▶ UAZAPI webhook ──▶ whatsapp-webhook
      │                                                     │
      │                                       maybeRelayRepasse() detecta que
      │                                       o grupo é monitorado
      ▼                                                     ▼
                                             Claude reescreve (tom + esconde
                                             preço de origem, token {{PRECO}})
                                                            │
                                             margem somada no código (não na IA)
                                                            │
                                             política group_only (alvo @g.us) OK
                                                            ▼
                                             /send/text ──▶ Grupo da comunidade
                                                            │
                                             log em repasse_relay_posts
```

Pontos importantes:

- **Só posta em grupo.** O alvo é sempre um `@g.us`, então respeita a regra
  inviolável pós-banimento (uazapi = `group_only`). Nada de 1:1.
- **A conta do preço é feita no código**, nunca pela IA: `preço final = preço do
  anúncio + margem`. A IA só escreve o texto e marca onde o preço entra com o
  token `{{PRECO}}`.
- **Idempotente.** A mesma mensagem de origem nunca é repostada duas vezes
  (`repasse_relay_posts.source_message_id`).
- **Não vira ticket.** Mensagem de grupo de repasse para no relay e não entra no
  roteador de leads/atendimento.

## Arquivos

| Arquivo | O quê |
|---|---|
| `supabase/migrations/20260917100000_repasse_relay.sql` | Tabelas `repasse_relay_config` e `repasse_relay_posts` (+ RLS) |
| `supabase/functions/_shared/repasse.ts` | Núcleo: `maybeRelayRepasse()` e `previewRepasse()` |
| `supabase/functions/whatsapp-webhook/index.ts` | Gancho (import + 12 linhas em `handleIncomingMessage`) |
| `supabase/functions/repasse-relay/index.ts` | Função pra **testar** (`preview`) e **reprocessar** |

## Deploy

```bash
# 1. Migration
supabase db push        # ou: supabase migration up

# 2. Functions (o webhook mudou; a repasse-relay é nova)
supabase functions deploy whatsapp-webhook
supabase functions deploy repasse-relay
```

Pré-requisito: `ANTHROPIC_API_KEY` já configurada (a mesma que o resto do sistema
usa, via `tenant_integration_keys` ou env). Nada novo aqui.

## Configurar (uma linha por grupo monitorado)

1. **Pegue os JIDs dos grupos.** A instância UAZAPI já lista os grupos:
   use a action `group_list` do `uazapi-proxy`, ou consulte `whatsapp_groups`
   (coluna `group_jid`). Você precisa do JID do **grupo de repasse** (origem) e
   do **grupo da comunidade** (destino).

2. **Insira a config** (a instância tem que ser a UAZAPI que participa dos dois
   grupos):

```sql
insert into public.repasse_relay_config
  (instance_id, source_group_jid, target_group_jid, margin, voice, signature)
values
  ('<UUID_DA_INSTANCIA_UAZAPI>',
   '<JID_DO_GRUPO_DE_REPASSE>@g.us',
   '<JID_DA_COMUNIDADE>@g.us',
   5000,            -- margem em R$
   'equilibrado',   -- equilibrado | vendedor | consultor | descolado
   'TOTEX Motors');
```

Opcionais na mesma linha:
- `min_source_price` / `max_source_price` — só reposta carros dentro da faixa.
- `post_without_price` — `false` (padrão): se não achar preço, **pula**; `true`:
  posta com "(consultar)".
- `model` — padrão `claude-sonnet-4-6`.

## Testar sem postar

Chame a função `repasse-relay` com `action: "preview"` (cola um anúncio de
exemplo e veja o post que sairia, sem enviar nada):

```jsonc
// POST /functions/v1/repasse-relay   (Authorization do usuário logado)
{
  "action": "preview",
  "instance_id": "<UUID_DA_INSTANCIA_UAZAPI>",
  "source_group_jid": "<JID_DO_GRUPO_DE_REPASSE>@g.us",
  "text": "Gol 1.0 2018, completo, 78mil km, único dono, R$ 38.500"
}
// → { ok:true, data:{ modelo, precoOriginal, margem, precoFinal, post, targetGroupJid } }
```

Para reprocessar uma mensagem específica (envia de verdade), use
`action: "reprocess"` com `message_id` e `text`.

## Ligar / desligar

`update public.repasse_relay_config set active = false where id = '<...>';`
(ou `true` pra religar). Auditoria completa em `repasse_relay_posts`
(status `posted` / `skipped` / `error`, com preços e o texto final).

## Risco (transparência)

Continua valendo o trade-off da UAZAPI: número não oficial pode ser banido pela
Meta. Por isso o relay **só posta em grupo** (nunca 1:1) e usa a instância
`group_only` de vocês. Ainda assim, mantenha a instância do relay separada das
funções críticas de atendimento e evite volume/spam anormal de mensagens.
