# Comissões — como o motor funciona

Fonte da verdade do cálculo de comissão da TotexMotors. Atualize aqui se a regra mudar.

## A base do cálculo: LUCRO da operação

A comissão **não** é sobre o preço do carro. É sobre o **lucro da operação**, que é a soma de:

```
Lucro = Carro + Seguro + Acessórios + Documentos + Retorno
```

Esses 5 valores são digitados no fechamento da venda (card "Lucro & Comissão" no detalhe da negociação). O sistema soma e usa o total como base.

## As faixas (plano padrão do Glauter — Shopping)

| Lucro da operação | Comissão |
|---|---|
| Até R$ 19.999,99 | **5%** |
| R$ 20.000 a R$ 29.999,99 | **7,5%** |
| R$ 30.000 ou mais | **10%** |

O percentual da faixa incide sobre **todo o lucro** (não é marginal).

## Adicional de consignado: +5% cumulativo

Quando a venda é de um **carro de captação (consignação)**, soma-se **+5%** ao percentual da faixa.

- Ex.: lucro R$ 25.000 consignado → 7,5% + 5% = **12,5%**.
- **É automático:** quando a negociação é a venda de um carro captado (fica ligada à intermediação, campo `intermediations.buyer_deal_id`), o sistema marca `is_consignado = true` sozinho e aplica o bônus. O switch manual no card existe só como reforço.

## Onde as coisas ficam (técnico)

- **`deals.profit_breakdown`** (jsonb): os 5 componentes do lucro.
- **`deals.operation_profit`**: o lucro total (soma).
- **`deals.is_consignado`**: se é consignação (automático via intermediação, ou manual).
- **`commission_plans`**: os planos por vendedor — `tiers` (faixas `[{min,max,percent}]`) + `consignado_bonus_percent`. Um plano com `sales_rep_id = null` vale como padrão da loja.
- **`calc_deal_commission(deal_id)`** + trigger `trg_deal_commission`: recalculam sozinho quando o lucro é preenchido/alterado, e gravam em **`commissions`** (base = lucro, valor, faixa aplicada, +consignado nas notas).
- **`commissions`**: onde a comissão calculada fica registrada (status `pending` até pagar).

## Remuneração fixa (fora do motor)

O **salário fixo + vale-refeição** é **folha de pagamento**, não entra no motor de comissão (que cuida só da parte variável). Fica registrado como referência no cadastro do colaborador (`team_members.notes`).

Referência do Glauter: Salário R$ 2.000 + Vale-Refeição R$ 800 = **R$ 2.800/mês**. Vendedor/captador — Shopping. Início 17/09/2026.

## Exemplos

| Lucro | Consignado? | % aplicado | Comissão |
|---|---|---|---|
| R$ 15.000 | Não | 5% | R$ 750,00 |
| R$ 22.000 | Não | 7,5% | R$ 1.650,00 |
| R$ 35.000 | Não | 10% | R$ 3.500,00 |
| R$ 25.000 | **Sim** | 12,5% | R$ 3.125,00 |
| R$ 35.000 | **Sim** | 15% | R$ 5.250,00 |

## Como usar (passo a passo)

1. Abra a **negociação** (Comercial → Pipeline → clique no card do cliente; ou Comercial → Deals).
2. No card **"Lucro & Comissão"**, preencha: Carro, Seguro, Acessórios, Documentos, Retorno.
3. Marque **"Venda consignada"** se o carro for de captação (ou deixe o sistema marcar sozinho).
4. Confira a **comissão calculada ao vivo** (mostra a % da faixa).
5. Clique **Salvar lucro e comissão** → fica gravada nas **Comissões** do vendedor.
