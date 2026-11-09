# Indique e Ganhe (programa de indicação aberto)

**Desde 09/11/2026.** Qualquer pessoa se cadastra, ganha um link e indica quem quer trocar de
carro. Decisão do Marco: **R$ 200 quando o indicado dá o sinal, R$ 800 quando a venda fecha**
(R$ 1.000 por indicação), **até 5 indicações pagas** (R$ 5.000) por indicador.

## Fluxo
1. `/indique` (público): nome + WhatsApp → `indique_cadastrar` gera o código (6 chars) e o
   link do **WhatsApp OFICIAL** da loja com texto pronto: "Oi Nina! Vim pela indicação ABC123
   e quero ver os carros da Totex." Nunca UAZAPI.
2. O indicado clica → `whatsapp-cloud-webhook` (`absorbIndicacao`) chama
   `indique_registrar_contato`: um telefone = um indicador (o primeiro vence), barra
   auto-indicação e quem já estava em negociação (lead antigo com interação em 90 dias →
   `cancelada/ja_cliente`). Marca `leads.metadata.indicacao` + `utm_source=indicacao`.
3. A Nina atende normal (bloco "VEIO POR INDICAÇÃO" no auto-context: não fala de comissão).
4. CRM: **Registrar Sinal** no deal (`deals.commitment_amount`, colunas criadas agora) →
   trigger `trg_indicacao_deal_events` → `indique_evento('sinal')` → pagamento R$ 200
   `a_pagar`. Deal **ganho** (`won_at`) → `indique_evento('venda')` → R$ 800 (e o sinal, se
   ainda não existia). Teto: 5 indicações com pagamento por indicador.
5. Indicador acompanha em `/indique/painel/<TOKEN>`: token privado de 64 hex
   (`indicadores.painel_token`), mostrado uma vez no cadastro. **O código de 6 letras é
   público e nunca abre o painel.** Recadastro com telefone já usado não devolve nada nem
   altera dados; recuperação só mandando "meu painel" pro WhatsApp oficial **a partir do
   número cadastrado** (webhook → `indique_recuperar_painel` → link por WhatsApp = prova de
   posse). Lista dos indicados sempre mascarada (primeiro nome + 4 últimos dígitos).
6. Gestor vê no Claude: `indicacoes` (a pagar com WhatsApp/PIX do indicador) e
   `marcar_indicacao_paga` depois do PIX.

## Tabelas
`indicadores` (code, nome, telefone, pix_chave, status), `indicacoes` (indicador, lead, deal,
status contato→sinal→venda / cancelada), `indicacao_pagamentos` (sinal|venda, a_pagar|pago).
Config: `INDIQUE_VALOR_SINAL_CENTS`, `INDIQUE_VALOR_VENDA_CENTS`, `INDIQUE_MAX_PAGAS`,
`INDIQUE_TENANT_ID` (loja dona do programa), `app_url`.

## Peças
| Peça | Onde |
|---|---|
| Edge fn pública (cadastro + painel) | `supabase/functions/indique` (verify_jwt=false) |
| Páginas públicas | `src/pages/IndiqueLanding.tsx` (`/indique`, `/indique/:code`) |
| Amarração do lead | `whatsapp-cloud-webhook/index.ts` → `absorbIndicacao` |
| Contexto da Nina | `agent-runner/lib/auto-context.ts` (bloco Indique e Ganhe) |
| Regras/pagamentos | migration `20261109100000_indique_e_ganhe.sql` |
| Visão do gestor | MCP `indicacoes`, `marcar_indicacao_paga` (RPCs `mcp_indicacoes`, `mcp_indicacao_marcar_pago`) |

## Live no Instagram (tática do vídeo)
Live com arte parada + adesivo de link pro WhatsApp oficial. O link da live pode ser o de um
indicador (ex.: da própria loja) ou o genérico com texto "Vim da live". Volume cai na Nina.
