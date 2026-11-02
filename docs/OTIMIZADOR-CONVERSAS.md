# Otimizador de conversas — auditoria e agente (2026-11-02)

## Auditoria (30 dias, número oficial 5511978846716)
- 58 contatos: 37 abordados por nós, 21 iniciados pelo cliente.
- Abordados que responderam: 9/37 (24%). Continuidade depois de uma resposta do agente: 59%.
- **Causa principal do "1%"**: 20 primeiras mensagens da Nina (texto "vou te pedir pra me deixar te
  ligar…") pra leads do totem/captação **falharam** na Meta com "Re-engagement message" (texto
  livre fora da janela de 24 h não entrega; só template aprovado). E 21 de 35 pedidos de
  permissão de ligação falharam pelo mesmo motivo. Resultado: 31 de 35 ligações da Nina
  presas em `awaiting_permission` sem o cliente ter visto nada.
- Templates: reaquecimento_trocar 27% de resposta; reaquecimento_viu_carro 0/9; pausa 0/7;
  retomada 1/4; permissão 7/35 (só os que tinham janela aberta).
- 55 envios falharam no total (também "Media upload error" e "healthy ecosystem engagement" =
  limite de marketing por usuário da Meta).

## Correção de entrega (nina-dialer)
Janela fechada → sai **template com botões** (`nina_primeiro_contato` / `_b`, variantes do
otimizador; `{{1}}` nome, `{{2}}` motivo curto por playbook); fila em `awaiting_window`.
Cliente responde (qualquer coisa) → webhook `onClienteRespondeu` → fila volta pra `queued` e o
discador manda o pedido de permissão com a janela aberta. "Prefiro por aqui" → ligação
cancelada (`outcome prefere_whatsapp`), o agente de texto segue. Sem resposta em 72 h → `expired`.

## Medição
- `whatsapp_touchpoint_stats(tenant, dias)`: por tipo (template/texto): enviadas, entregues,
  lidas, falhas (+ erro principal), respondidas em 48 h, taxa.
- `whatsapp_conversation_funnel(tenant, dias)`: contatos, abordados, abordados que responderam,
  iniciados pelo cliente, conversas com 3+ msgs, continuidade após resposta do agente.
- `message_variant_stats(tenant, dias)`: por variante (envios, respondidas, permitiram, taxa).

## Variantes (A/B automático) — `_shared/message-variants.ts`
`message_variants` (touchpoint, nome do template, corpo, botões, status) e
`message_variant_sends` (cada envio). `pickVariant()` escolhe por amostragem de Thompson entre
as ativas (template só se APROVADO na Meta); `logVariantSend()`; `markVariantOutcome()` no
webhook (replied / permitted). Hoje ligado em `nina_primeiro_contato`; próximos: curiosidade,
reaquecimento, retomada.

## Agente (`message-optimizer`, cron diário 07:40 BRT)
`run`: coleta funil + touchpoints + variantes + amostras (com/sem resposta) → Claude
(`OPTIMIZER_MODEL`, padrão sonnet 4.5) → `message_optimizer_runs.report` {diagnóstico,
hipóteses, ações, propostas de template (body + botões, regras da Meta), sugestões de prompt}.
Pausa automática: variante com ≥30 envios e taxa < metade da melhor do touchpoint
(`OPTIMIZER_AUTO_PAUSE=false` desliga). `approve`: cria o template na Meta e registra a variante
(`submitted` → `active` quando aprovar). Tela: Configurações › IA & Bots › **Otimizador de
conversas** (funil, tabela por mensagem, variantes, relatório, aprovar propostas).

## Regras
- Nunca texto livre pra quem está fora da janela: template aprovado ou nada.
- Botões de template: sem emoji, até 20 caracteres. Body não começa nem termina com variável.
- Nunca taxa de juros nas mensagens. Propostas passam por aprovação humana antes de ir pra Meta.
