# Integração Tabela FIPE — fipeX (porta única `fipe-lookup`)

> Baseado no documento "Integração Tabela FIPE — fipeX (Totexgest e demais projetos)".
> Regra de ouro: **todo** consumo de FIPE (CRM, site, agente, n8n, demais projetos)
> passa pela edge function `fipe-lookup`. Ninguém chama fipeX ou a FIPE direto.

## Arquitetura

```
Projeto/tela (CRM, site, agente)
        │  POST /functions/v1/fipe-lookup
        ▼
   fipe-lookup (edge function, Supabase Totexgest)
        │
        ├─ 1. cache      → fipe_price_cache (resposta fipeX do mês)
        ├─ 2. fipex      → https://api.fipex.com.br/v1 (10 req/s por IP)
        ├─ 3. dataset    → fipe_prices (release do dataset importada)
        └─ 4. fipe_oficial → veiculos.fipe.org.br (emergência, volume baixo)
```

A função devolve **sempre o mesmo formato**, com `fonte` indicando de onde veio o dado.
Valores **sempre em centavos**. Formatar em reais só na tela. Sempre mostrar o mês de
referência ("FIPE jul/2026").

## Contrato

### Entrada (POST)
Auth: JWT do usuário (front) **ou** header `x-fipe-token` = `FIPE_LOOKUP_TOKEN` + `tenant_id` no body (n8n/cron).
Basta **uma** forma de identificar o veículo:

```json
{ "placa": "ABC1D23", "codigo_fipe": "015069-0", "modelo_slug": "onix-plus-1-0-turbo",
  "combustivel": "F", "ano": 2022, "lead_id": "uuid", "seller_vehicle_id": "uuid" }
```
Para confirmar o modelo (após a pessoa escolher um candidato):
```json
{ "marca": "Chevrolet", "modelo": "Onix Plus", "ano": 2022, "combustivel": "F",
  "confirmar": { "codigo_fipe": "004509-8", "model_slug": "onix-plus-1-0-turbo", "fuel_acronym": "F", "nome_modelo": "Onix Plus 1.0 Turbo" } }
```

### Saída
```json
{ "ok": true, "fonte": "cache|fipex|dataset|fipe_oficial",
  "precisa_confirmar_modelo": false, "candidatos": [],
  "veiculo": { "marca": "Chevrolet", "modelo": "Onix Plus 1.0 Turbo", "ano_modelo": 2022, "combustivel": "Flex", "codigo_fipe": "004509-8" },
  "preco": { "valor_centavos": 8250000, "mes_referencia": "2026-07" },
  "analise": { "depreciacao_anual_pct": null, "retencao_valor_pct": null, "anomalia": null },
  "historico": [ { "ano": 2026, "mes": 7, "valor_centavos": 8250000 } ] }
```
Se `precisa_confirmar_modelo` = true, mostrar `candidatos` para a pessoa escolher (nunca escolher sozinho).

## Fluxo placa → FIPE
1. `vehicle-lookup` (PuxaPlaca) devolve marca, modelo, ano, combustível.
2. `fipe-lookup` procura o modelo em `fipe_model_match`. Se não houver, chama
   `/v1/search/labels` e devolve até 5 `candidatos` com `precisa_confirmar_modelo: true`.
3. A pessoa confirma o modelo na tela; o de-para é gravado em `fipe_model_match`.
4. Com o modelo confirmado, busca preço + análise e grava em `vehicle_fipe_snapshot`.

## Tabelas
| Tabela | Escopo | Conteúdo | Atualização |
|--------|--------|----------|-------------|
| `fipe_prices` | global | dataset fipeX (merged), preço mensal por codigo_fipe+ano+zero_km+sigla_comb | nova release do dataset |
| `fipe_price_cache` | global | resposta fipeX (preço + analytics + histórico) | na consulta; vale até virar o mês |
| `fipe_model_match` | global | de-para texto da placa → modelo FIPE confirmado | cresce com o uso |
| `vehicle_fipe_snapshot` | tenant + RLS | preço FIPE da negociação (append-only) | na captação; nunca sobrescreve |

## Aplicação no Totexgest (prioridades)
1. **Captação**: após a placa, mostra preço FIPE, depreciação anual e retenção de valor; grava snapshot.
1. **Captação — faixa sugerida**: ajusta a FIPE por km e conservação (metodologia FipeV) e mostra faixa para negociar.
2. **Estoque/vitrine**: marca carros abaixo da FIPE (selo de oportunidade) e mostra a diferença em %.
2. **Agente / WhatsApp**: responde "tenho até R$ X" cruzando `/v1/search` (faixa de preço) com o estoque real.
3. **Alerta**: aviso quando a FIPE de um carro em estoque cai > X% na virada do mês.
3. **Argumento de venda**: histórico de preço do modelo (desvalorização) para o cliente.

## Faixa de preço (parâmetros a validar com a operação)
Pontos de partida (NÃO validados — calibrar com negócios reais antes de mostrar):
- Km abaixo da média p/ o ano: +0% a +5% · acima: −3% a −10%
- Conservação ótima/boa/regular/ruim: +3% / 0% / −8% / −15%
- Média de km/ano configurável (ex.: 12–15 mil km/ano)
- Margem de compra: definida pela operação; **só admin/comercial/closer** veem margem e preço de compra.

## Checklist de implementação
- [x] Tabelas `fipe_prices`, `fipe_price_cache`, `fipe_model_match`, `vehicle_fipe_snapshot` (RLS).
- [x] Edge function `fipe-lookup` (cache → fipeX → dataset → FIPE oficial).
- [ ] Confirmar endpoints em `https://api.fipex.com.br/v1/docs` e testar `/v1/prices` e `/v1/search/labels` com 5 carros reais do estoque (ajustar mapeamento dos campos do fipeX em `fipe-lookup`).
- [ ] Importar a release **merged** mais recente do dataset em `fipe_prices`.
- [ ] Ligar a captação: placa → `fipe-lookup` → confirmação de modelo → snapshot.
- [ ] Tela de captação com preço, mês de referência, depreciação e faixa sugerida.
- [ ] Cron mensal: importar a release nova do dataset e limpar o cache do mês anterior.
- [ ] Habilitar o fallback FIPE oficial (POST `veiculos.fipe.org.br`) com volume baixo.
- [ ] Liberar para os demais projetos com o prompt padrão (front nunca chama fipeX direto).
- [ ] Revisar os percentuais da faixa de preço com a operação.

## Pontos de atenção
- fipeX é projeto independente, sem garantia de continuidade → por isso o dataset importado como reserva + FIPE oficial como último recurso.
- Texto da placa não casa direto com o modelo FIPE → confirmação humana + de-para em `fipe_model_match`.
- Limite de 10 req/s por IP no fipeX → cache e chamadas só pela `fipe-lookup`.
- Campos de `analytics` podem vir nulos → tela/agente tratam ausência sem quebrar; não inventar número.
- Consulta por código FIPE não confirmada na doc do fipeX → resolver o código pela base `fipe_prices` (o dataset tem `codigo_fipe`).
