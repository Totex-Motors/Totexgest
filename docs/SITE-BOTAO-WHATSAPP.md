# Botão do WhatsApp do site (marketplace) → CRM

Texto pra mandar pro time do site (totexmotors.com).

---

Pessoal, uma mudança pequena no botão "Falar no WhatsApp" da página do veículo.

**O que acontece hoje:** no clique, o site cria o lead no CRM sem telefone
("Cliente (não identificado)") com o carro e a loja. O WhatsApp não entrega o número de
quem clica, só de quem manda a mensagem. O CRM agora casa o clique com a mensagem que
chega, mas sem um código ele precisa adivinhar pelo carro e pela hora.

**O que precisamos:** incluir no texto pré-preenchido do WhatsApp um código de referência
= os **8 primeiros caracteres do id do lead** que o site acabou de criar. O texto fica assim
(mantendo o padrão atual):

```
Olá! Eu vi o {carro} da loja {loja} no site da TotexMotors e gostaria de saber mais. (ref {id_do_lead_8_chars})
```

Exemplo real: `... no site da TotexMotors e gostaria de saber mais. (ref 8d8b123f)`

Regras:
- `ref` seguido de espaço e os 8 primeiros caracteres do id (uuid) do lead criado no clique,
  em minúsculas. Pode ficar entre parênteses no fim, como no exemplo.
- Criar o lead ANTES de abrir o WhatsApp (já é assim), pra ter o id na hora de montar o link.
- O resto do texto não muda: "vi o … da loja … no site" continua sendo lido pelo CRM.
- Se por algum motivo o lead não for criado a tempo, mandar sem o `ref` (o CRM cai no
  casamento por carro + hora, que já funciona).

Com isso o CRM identifica o cliente na hora em que a mensagem chega, mesmo que duas pessoas
cliquem no mesmo carro no mesmo minuto.

---

## Como o CRM trata (referência interna)

- `whatsapp-cloud-webhook` → `absorbMarketplaceClick`: ref exata (48 h) ou órfão mais recente
  (2 h) com o mesmo carro. Número já com lead na loja → carro/loja/deal vão pra ele e o órfão
  some; senão o órfão ganha telefone e nome do WhatsApp e vira o lead da conversa.
- Clique sem mensagem em 24 h → `marketplace_cliques_sem_contato()` (cron diário):
  lead "Clique sem contato (site)", status `clique_sem_contato`, fora do funil; deal perdido
  com motivo.
