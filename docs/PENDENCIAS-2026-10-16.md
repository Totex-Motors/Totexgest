# Pendências — sessão das 10h de 16/10/2026 (Marco)

PR pra mergear: https://github.com/Totex-Motors/Totexgest/pull/147

## Você faz (ordem)
1. **Mergear o PR 147** (segurança + Nina + follow-up + card + clique do site). A Vercel publica
   a tela em ~3 min.
2. **Cadastrar `META_APP_SECRET`** — Meta for Developers › seu app do WhatsApp › Configurações
   do app › Básico › "Chave secreta do aplicativo" › Mostrar. No CRM: Configurações ›
   Integrações › API Keys › chave `META_APP_SECRET`. Depois me avisa: eu confirmo que o
   webhook continua recebendo com a assinatura válida.
3. **Testar o envio logado**: Inbox › qualquer conversa › mandar uma mensagem (você passa como
   superadmin). Se der, pede pra alguém da Cardoso (conta de loja) mandar uma também.
4. **Aprovar/rejeitar as lições da Nina**: Configurações › IA & Bots › Nina — Ligações › card
   "5. O que a Nina aprendeu" (7 aprovadas, 1 pendente).
5. **Templates na Meta**: WhatsApp Manager › Modelos de mensagem. Pendentes:
   reaquecimento_vender, nina_curiosidade_1, nina_curiosidade_2, retomada_conversa,
   pausa_conversa. Se algum for REJEITADO, me manda o motivo que eu reescrevo.
6. **Site**: mandar o texto de `docs/SITE-BOTAO-WHATSAPP.md` pro time do site (ref no botão).
7. **Simulador (opcional)**: gerar o token de aparelho no painel do simulador
   (aparelho-liberar) e me passar → liga a fila de retorno da loja.
8. **Soraya**: me diz se agendo o retorno de 5 de janeiro, 9h30.
9. **Testar o card**: no WhatsApp oficial, "quanto fica a parcela do Nivus?".

## Eu faço (depois do seu OK)
- Segurança, rodada 2 (webhooks e crons menores sem barreira própria — lista em
  `docs/SEGURANCA-FUNCOES.md`): UAZAPI, Instagram, Telegram, calendário, intake de leads por
  token, crons de alerta. Preciso de: secret do webhook da UAZAPI (painel da UAZAPI, se
  houver) e o secret token do bot do Telegram.
- Template novo de reaquecimento com "13º, férias ou FGTS" (o aprovado fala só do 13º).
- Nina F&I: ver `docs/NINA-FI.md` (decisões 1–4 são suas).
