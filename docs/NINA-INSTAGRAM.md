# Nina no Instagram (direct do @totexmotors)

**Desde 08/11/2026.** A Nina responde o direct do Instagram pela **API oficial da Meta**
(mesma conta conectada em Configurações → Instagram Oficial). Nada de navegador, nada
de automação por fora: a Meta baniu o número Totexcar por isso no WhatsApp e no
Instagram o risco é o mesmo (perder a conta da loja).

## O que ela atende
- DM fria (a pessoa escreveu primeiro), resposta a story da Totex, **menção em story**
  (a pessoa marcou a Totex no story dela), vídeo/post compartilhado, áudio e imagem.
- Regra da Meta: só dá pra responder até **24 h** depois da última mensagem da pessoa.
  Backlog antigo não é respondido (a API recusa).

## O que ela faz
Responde curto (1–3 linhas), descobre o carro (`consultar_estoque`), dá FIPE com mês
de referência (`consultar_fipe`) e **leva a pessoa pro WhatsApp oficial** com link
`wa.me/5511978846716?text=...`, onde a Nina do WhatsApp faz simulação (imagem), Grazi,
cupom e agendamento. No direct ela **não** dá número de parcela, **não** dá valor de
troca (trava inviolável), **não** fala taxa, **não** usa escassez e diz "simulação",
nunca "conta". Propaganda, pitch, sorteio, conta da própria rede → `[SKIP]` (nada sai).

## Peças
| Peça | Onde |
|---|---|
| Agente `nina-instagram` (prompt, tools `consultar_estoque`, `consultar_fipe`, `current_time_br`) | `agents_registry` / `agents_tools` (tenant Totex) |
| Liga/desliga por loja: `IG_NINA_AGENT_SLUG` = slug do agente (vazio = DM fria vai pro humano, comportamento antigo) | `tenant_integration_keys` |
| Nunca responder: `IG_NINA_IGNORAR` = JSON array de usernames (contas da rede, sócios) | `tenant_integration_keys` |
| Modo teste: `ig_agent_test_allowlist` = JSON array → só responde esses usernames | `tenant_integration_keys` |
| Entrada e política de DM fria | `instagram-webhook/meta-campaign.ts` (`handleCampaignReplyByUsername`, `runIgAgentReply`) |
| Mídia vira texto (story mention/vídeo/post, Gemini) | `instagram-tools/media-understand.ts` |
| Fila com debounce (15 s) + cron 1/min | `ig_agent_message_queue` → `instagram-crons` action `agent_queue` |
| Pausar numa conversa: botão "Ignorar"/pausa no inbox (`instagram_conversations.is_ignored` / `agent_paused`) | CRM |

## Fluxo
Meta webhook → `instagram-webhook` (dedup por mid, grava mensagem, resolve username) →
mídia vira texto (`media_understand`) → `handleCampaignReplyByUsername` decide se entra
(campanha, sessão existente, gatilho de palavra-chave **ou** `IG_NINA_AGENT_SLUG`) →
fila → cron `agent_queue` → `runIgAgentReply` → `agent-runner` (slug da chave) →
`sendDmToUsername` (Send API, split em até 4 bolhas) → espelha em `instagram_messages`.
Bot ping-pong é detectado e pausa a conversa (`detectIgBotConversation`).

## Ligar em produção
1. Testar com a allowlist (hoje: `marcoscardosoveiculos`, `renataparentel`).
2. Pra liberar pra todo mundo: `ig_agent_test_allowlist` = `[]` e adicionar o próprio
   Marco em `IG_NINA_IGNORAR` (senão a Nina responde o dono).
