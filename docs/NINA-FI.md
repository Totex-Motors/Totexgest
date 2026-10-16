# Nina F&I — financiamento multibanco dentro do Totexgest (pesquisa 16/10/2026)

## O que o concorrente vende (AutoPilot F&I V4, autopilotcrm.com.br/v4)
- IA no WhatsApp/Instagram/portais responde o lead, manda fotos do estoque, qualifica (score).
- Coleta nome, CPF, nascimento, entrada e troca "com consentimento".
- Simula em "12 bancos" em 8 s (Itaú, Bradesco, Santander, Safra, C6, Pan, Daycoval, Creditas,
  Honda, Volkswagen, Yamaha, Hyundai Capital) e mostra as 3 melhores condições (parcela e taxa);
  resultado é pré-análise, a proposta final é com o banco; a loja não precisa ser credenciada.
- Repassa o lead pré-aprovado pro vendedor com resumo; follow-up automático; dashboard.
- Preço: R$ 697/mês (30 simulações, 2.000 leads IA), plano MAX sob consulta; R$ 2 por
  simulação extra. "Seu vendedor nunca mais abre portal de banco."

## Como esse mercado faz a pré-aprovação multibanco
Ninguém fala com 12 bancos na mão: usam um AGREGADOR (correspondente bancário com API):
- **Credere** (já somos app 463; recebemos `processed_simulation` por webhook) — API de
  simulação/pré-aprovação pra parceiros; docs não públicas, contrato direto.
- **Zinix** — API white label "a partir de R$ 1,50 por CPF", 12+ bancos (Pan, Itaú, Bradesco,
  Santander, BV, Creditas, Autobanking, Carbank, Fontecred, Honda, C6, Safra, Omni).
- **Simples Aprova** (Simples Veículo) — consulta simultânea a 12 bancos, resultado
  aprovado / grandes chances / possível / restrito.

## O que o Totexgest JÁ tem (mais da metade do caminho)
| Peça | Onde |
|---|---|
| Módulo Credere (mapeamento de loja, página /comercial/credere, etapa "Financiamento (Credere)", webhook de simulação processada) | `credere-webhook`, `useCredere.ts`, `CredereLeads.tsx` |
| Nina voz + agente de texto com dossiê, estoque, agendamento, memória compartilhada | `voice-agent-*`, `agent-runner`, `lead-brief.ts` |
| Simulação com a conta da planilha + card em imagem no WhatsApp | `simulador-cardoso`, `simulacao-card` |
| Cupom de R$ 300 na parcela (48 h) + aviso à Grazi (17 bancos, humano) | `reaquecimento_cupons`, `lead-rewarm avisar_grazi` |
| Perfil de compra no card (orçamento, entrada, financiar, troca), carro na troca, FIPE | `BuyerProfileCard`, `trade_in_vehicles`, `fipe-lookup` |
| Follow-up automático, cadência de ligação, reaquecimento | `followup-auto.ts`, `nina-cadence.ts`, `lead-rewarm` |
| Segurança (auth nas funções), LGPD mascarando CPF no simulador | `_shared/auth.ts` |

## O que FALTA pra ser o "AutoPilot F&I" (e melhor)
1. **Motor de pré-aprovação multibanco** (a peça que não temos): API do agregador.
   Caminho A: pedir à Credere a API de simulação (já somos cliente; o webhook que recebemos é
   a metade de volta). Caminho B: Zinix API white label (R$ 1,50/CPF). Decidir por custo,
   bancos e se a Totex atua como correspondente ou o agregador.
2. **Coleta com consentimento no WhatsApp**: a Nina pede CPF, data de nascimento, renda e
   entrada só depois do "sim" explícito (texto LGPD curto), grava mascarado/criptografado,
   nunca em log, nunca por voz (na ligação ela manda um link/pergunta no WhatsApp).
3. **Card "pré-aprovado"**: reaproveita o renderizador do card: 3 melhores bancos, parcela,
   entrada, prazo; sem taxa na imagem (decisão do Marco: só reais) ou com CET, a definir.
4. **Handoff**: lead pré-aprovado → Grazi/loja com resumo (já existe `chamar_grazi` e
   `repassar_lead_loja`; só muda o conteúdo).
5. **Dashboard F&I**: simulações, aprovações, parcela média, conversão por banco.
6. **Nina por voz**: nunca coleta CPF falado; oferece "te mando o passo a passo no WhatsApp".

## Decisões que só o Marco toma
- Agregador: Credere (contrato existente) ou Zinix (API barata) — ou os dois (fallback).
- Mostrar taxa/CET? A regra atual da Nina é "só reais". Pré-aprovação de banco vem com taxa.
- LGPD: CPF/renda passam a transitar pelo Totexgest (hoje a regra do simulador da Cardoso é
  que NÃO passam). Precisa de texto de consentimento e política de retenção.
- Quem é o correspondente bancário no contrato (Totex, loja ou o agregador).

## Fases
- **F1 (1–2 semanas, depois do contrato com o agregador)**: consentimento + coleta no agente
  de texto, chamada de simulação, card pré-aprovado, handoff pra Grazi/loja.
- **F2**: Nina voz oferece e dispara o fluxo pelo WhatsApp; follow-up específico de
  "pré-aprovação vence em X dias".
- **F3**: dashboard F&I + campanha Meta Ads "simule em 8 segundos" (o mesmo gancho deles).
