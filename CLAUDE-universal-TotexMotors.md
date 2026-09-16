# TotexMotors — Contexto do Ecossistema (para qualquer Claude)

> Arquivo de contexto compartilhado. Onde quer que você esteja (Claude Code, Cowork,
> Designer, Projeto do Claude…), entenda a TotexMotors e aja de forma consistente.
> Escreva em **português brasileiro**, direto e prático.
>
> ⚠️ **Não sobrescreva um CLAUDE.md mais específico do repositório** (ex.: o do Totexgest
> tem regras críticas de setup). Nesses casos, some este contexto ao que já existe, ou
> salve como `CONTEXTO-TOTEXMOTORS.md`.

## Quem somos
**TotexMotors** — venda e **intermediação de veículos**, com CRM próprio (**Totexgest**)
e rede de **promotoras** (captação + repasse por indicação). Dono: **Marco**.

## O eixo da receita (a bússola)
Toda a operação gira num trilho só: **captar/avaliar → anunciar → vender** (e depois **reter**).
Ao decidir prioridade, pergunte: "isso serve a qual elo do trilho?".

## Mapa do ecossistema (sistemas e papéis)

| Sistema | Papel | Elo | Situação |
|---|---|---|---|
| **Totexgest** (CRM) | Núcleo: pipeline, leads, deals, intermediação, captação, repasse | Vender | ✅ Núcleo |
| **autoavalia / Cardoso Avalia** | Vistoria e avaliação de veículo por IA (laudo, preço) | Captar/avaliar | ✅ Manter |
| **totexmotors-marketplace** | Vitrine oficial onde o carro é anunciado (= "Em vitrine" da intermediação) | Anunciar | ✅ Manter |
| **Carrossel Studio** (studio-totex-motors, `insta.totexmotors.com`) | Motor de criativo/conteúdo pra anúncio e tráfego (estático + vídeo) | Anunciar | ✅ Manter (1 só) |
| **totexcar-copilot** | App do **dono do carro** (gastos, manutenção, recompra, fidelidade). Estratégia de **base de dados** e retenção/LTV | Reter (pós-venda) | ✅ Manter (trilha à parte) |
| **totex-motors-vision** | **Calculadora das franquias** — ferramenta para os franqueados | Franquias/rede | ✅ Manter |
| **totex-flip** | Catálogo/guia em flipbook interativo; parte da captação e **produto a ser vendido** | Anunciar/captar + produto | ✅ Manter (experimento→produto) |
| **vitrine-trafego** | Landing de **tráfego pago** (Meta/anúncios), ligada ao marketplace | Atrair (topo de funil) | ✅ Manter |
| **TotexMotors-OS** | **Control plane da rede**: provisiona lojas/tenants, guarda chaves de API, controla franqueados. O Totexgest consome via `os-provision-tenant`/`os-update-tenant-status`/`os-log-crm-event` | Backbone/rede | ✅ Manter (backbone) |
| **autotech** | 2º CRM de WhatsApp (Atendechat whitelabel) — **duplica o Totexgest** | — | 🗄️ **Arquivar** |
| **Segundo Cérebro (MCP)** | Cockpit: supervisiona a operação e aconselha o dono (via Claude) | Todos | ✅ Ativo |

**Duplicatas de conta pessoal** (`casa1615/CARDOSO-AVALIA`, `casa1615/totexcar`,
`casa1615/studio-totex-motors`, etc.) → arquivar; a fonte da verdade é a versão em
`totex-motors/*`.

**Governança (1 ponto):** tanto o **TotexMotors-OS** quanto o **Totexgest** mexem com
tenants + chaves de API. Definir **uma fonte da verdade** (provável: OS provisiona/guarda,
CRM consome) para não ter chave duplicada.

## Como os sistemas se conectam (visão)
- **autoavalia → Totexgest**: laudo/preço da avaliação alimenta a intermediação na captação.
- **Totexgest → marketplace**: carro entra em "Em vitrine"; vendido, sai do ar.
- **marketplace/Totexgest → Studio**: criativo do anúncio (estático/vídeo) a partir do carro.
- **totex-flip**: camada de apresentação/catálogo que puxa pro marketplace.
- **vision**: precificação/calculadora para franqueados (rede).
- **copilot**: pós-venda do cliente, construindo base de dados de donos de carro.

## Onde ficam as coisas
- **Código**: GitHub org `Totex-Motors` (fonte da verdade). Núcleo: `totexgest`. Segundo Cérebro: `mcp-server/`.
- **Backend**: Supabase, projeto `mztfyavuclqzivywkaeu` (Postgres + RLS + Edge Functions + Auth).
- **Deploy**: Vercel (frontend do CRM + servidor MCP em `totexgest-eta.vercel.app`).

## Regras invioláveis
1. **UAZAPI só em grupo/canal** (`@g.us`/`@newsletter`). Conversa 1:1 = API oficial (Cloud API).
2. **Nada de chave hardcoded** — vem da config/UI.
3. **Intermediação**: estágio do funil é **consequência do evento** (contrato assinado, anúncio, venda), nunca movido na mão.
4. **Migrations em produção**: com cuidado, aditivo quando possível, testar antes; nunca reaplicar baseline.
5. Antes de algo difícil de desfazer (deploy, migration, envio externo): trabalhar em branch e confirmar.

## Valores de negócio
- Intermediação: **R$ 25** na formalização (contrato assinado), **R$ 50** na conclusão.
- Repasse por indicação: **R$ 150** à promotora quando o indicado compra (1 telefone = 1 promotora; a primeira vence). Meta: 5 convites/dia.
- Alçadas: venda abaixo do mínimo, comissão, concessão e renúncia exigem aprovação.

## Tom e comportamento
- Português brasileiro, sem jargão. Explique como pra um amigo quando o assunto for técnico.
- Pense **ecossistema**, não só CRM: toda tarefa serve a um elo do trilho (captar→anunciar→vender→reter).
- Traga sempre o **próximo passo**. Não invente dados — se não souber, diga e busque a fonte.
