# HANDOFF — Sessão de customização do Totexgest (CRM automotivo)

> **Pra quem é:** a próxima sessão do Claude Code (ou dev) continuando o trabalho.
> Leia também o `CLAUDE.md` (visão geral do template original) — mas ATENÇÃO:
> este CRM divergiu muito do template; este handoff reflete o estado REAL.
> Última atualização: 2026-07-12.

## Contexto do negócio
- **Totexgest** = CRM multi-tenant da Totex Motors (revenda de veículos + lojas parceiras).
- Foco: atendimento inicial + qualificação da jornada de compra, com IA.
- **Arquitetura de leads (decisão do Marco):** o número oficial **11 97884-6716**
  é a PORTA ÚNICA. Todo lead entra por ele → agente IA qualifica → só então é
  encaminhado (automação) pra loja dona do carro.

## Infra / acessos
| Item | Valor |
|---|---|
| Projeto Supabase (CRM) | `mztfyavuclqzivywkaeu` — "CRM Interno Totex", org "JoaoMendes0524's org" |
| ⚠️ MCP Supabase | A conexão às vezes volta pra conta errada (org "totexmotors", projetos OS/Car Finance). Se der "permission denied" no `mztfy...`, pedir pro Marco reconectar a integração com a conta certa. |
| Frontend | Vercel, auto-deploy no push da `main` via INTEGRAÇÃO NATIVA GitHub↔Vercel (o antigo workflow `deploy.yml` era redundante e falhava com "Project not found" — foi REMOVIDO em 2026-07-12; verificado que o site atualiza normalmente sem ele) |
| Edge functions | GitHub Action `deploy-supabase.yml` — push na `main` deploya **TODAS** as functions (verify_jwt por função via `supabase/config.toml`). Secret `SUPABASE_ACCESS_TOKEN` configurado. |
| Migrations | **NÃO automatizadas** (falta secret `SUPABASE_DB_PASSWORD`). Aplicar via MCP `apply_migration` ou o Marco roda `supabase db push`. Sempre salvar o arquivo em `supabase/migrations/` ANTES. |
| Git flow | trabalhar na `develop` → merge `--no-ff` pra `main` → push (dispara deploys). Commits em pt-BR. |

## IDs importantes (produção)
| Coisa | ID |
|---|---|
| Tenant do Stand (super-admin) | `c13681e3-5db9-48d1-9c5c-856e6041d77f` |
| Agente do Stand "Ronaldo" (agents_registry) | `d19aa9aa-2e6d-4482-a63f-ca01b2373003` — modelo `claude-sonnet-4-6` |
| Instância WhatsApp oficial "IAP - OFICIAL" | `dc078726-dc53-4d16-8417-75c7e7ceb284` (Cloud API, `phone_number_id 1195563230311406`, `business_account_id/WABA 1825337721779046`, metadata.type=`cloud_api`) |
| Instância antiga "IA Stand" | `eb8199e5-...` — DESATIVADA (fora do filtro do inbox, deployment off). Não reativar. |
| Tenant loja exemplo (Julio Multimarcas etc.) | leads de teste em `1a108c13-7fa4-47e9-8264-17e110332549` |

## O agente (plataforma v2 — `agent-runner`)
- O "Ronaldo" atende o WhatsApp oficial. Prompt (em `agents_registry.system_prompt`, editado direto no banco) contém: persona estilo "Lu do Magalu" (fusão do prompt "Pedro" do Marco), estados da conversa (conexão→desejo→segurança→abertura→qualificação), venda consultiva, ASSERTIVIDADE (não concordar passivamente: financiamento por fora → oferecer simulação; prazo → tentar abreviar), regras de ouro (consultar estoque quando o veículo vem identificado na origem; matemática antes de perguntar; nunca msg vazia), follow-up automático.
- **Tools do Ronaldo:** `consultar_estoque`, `capturar_perfil_compra` (grava perfil em `leads.metadata` + BANT), `repassar_lead_loja` (stand-handoff), `agendar_lembrete` (follow-up), `current_time_br`, `qualify_lead` (legado B2B, pouco usado).
- **Follow-up:** Ronaldo agenda lembrete (~3h, máx 2). `agent-jobs-poller` (cron 1min) dispara → `agent-runner` gera o texto → **`lib/wa-delivery.ts` entrega**: UAZAPI = texto livre; Cloud = checa janela 24h (msg recebida <24h) → dentro: `send_text`; fora: TEMPLATE (`agent.settings.followup_template_name` → fallback config `WHATSAPP_FOLLOWUP_TEMPLATE`). Cliente respondeu antes → lembretes únicos pendentes são cancelados (agent-runner index).
- Legado `ai-sales-agent` também recebeu captura automotiva (reserva; gate `config.agent_platform_v2_enabled`).

## O que foi entregue nesta sessão (tudo na main, deployado)
1. **Tela branca na Vercel** (era env vars faltando) + guarda de config no index.html.
2. **4 frentes:** captura de perfil no 1º contato (skill+função SQL `agent_capture_buyer_profile`); venda consultiva + assertividade; follow-up automático + view SLA `vw_agent_sla_mensagens`; dashboard **/comercial/inteligencia** (view `vw_inteligencia_leads`).
3. **stand-handoff** leva o perfil de compra (metadata) pro lead da loja.
4. **Polida B2B→automotivo:** deal com veículo por busca no estoque (preço automático); faturamento/funcionários fora da UI (veículo/orçamento no lugar); Reuniões→Agendamentos; "Visita/Vídeo".
5. **Vincular veículo** no lead: busca no estoque com autocomplete + múltiplos veículos (`metadata.vehicles`, principal segue em `metadata.vehicle`).
6. **Segurança v3:** `config` global legível/gravável só super-admin (allowlist pública); credenciais de agentes só admin/dono; `uazapi-proxy` (token nunca no browser; WhatsAppInstancesSection reescrita).
7. **Ports do template v3 do Frank:** Lead Ads Meta (`meta-lead-webhook`+telas), Canais de Entrada (`receive-lead`), Importar Leads (CSV **funcional** — wizard implementado do zero), Formulários, WhatsApp Cloud multi-número/Embedded Signup (seção em Configurações), RPC `match_distribution_config_for_meta_lead` (criada, catch-all).
8. **Nutrição/templates:** criação de template na Meta OK (drift multi-número aplicado; WABA salvo na instância; auto-resolve via debug_token na função); Inbox com trava de janela 24h + seletor de templates (existia, ativado via `metadata.type` + predicado `isCloudMeta`).
9. **CI estabilizado:** deploy-all com retry; imports `esm.sh` → `jsr:` (24 functions); 20 entradas órfãs removidas do config.toml.

## ⏳ PENDÊNCIAS (por prioridade)
1. **Configurar template de follow-up:** quando a Meta aprovar o template de nutrição do Marco, gravar o nome em `config` (`WHATSAPP_FOLLOWUP_TEMPLATE`) ou `agent.settings.followup_template_name` do Ronaldo. (Existe `boas_vindas` APROVADO que pode servir de provisório.)
2. **Testar follow-up ponta-a-ponta:** `agent_reminders` estava VAZIA (Ronaldo nunca agendou em teste). Testar: conversar, deixar pergunta no ar, sumir → ver lembrete criado, disparo, entrega (e fora da janela → template).
3. **Refino de tom do Ronaldo** — o Marco disse que faria; ciclo: conversa real → ler `agents_messages` → ajustar prompt no banco.
4. **Marketplace/clique (STANDBY — dev do Marco):** leads de clique no carro nascem direto no tenant da LOJA (via `marketplace-lead-webhook` + `marketplace_store_mappings`), duplicando lead e furando a porta única. Plano desenhado: rotear pro tenant do Stand + dedup por telefone + `owner_tenant_id` no metadata.
5. ~~**Mensagem vazia do assistant** no runner~~ ✅ **RESOLVIDO (2026-07-12).** Investigado: (a) o cliente no WhatsApp NUNCA recebe bolha vazia — UAZAPI e Cloud já têm fallback `"|| Desculpa..."`; (b) linhas vazias com `tool_calls` são POR DESIGN (carregam o tool_use, necessárias pro histórico); (c) o adapter Anthropic já descarta assistant vazio no turno seguinte (sem 400). Único defeito real: buraco em branco no chat interno ao recarregar. Fix: `agent-runner` não persiste mais turno 100% vazio (sem texto E sem tool) + `AgentChat` não renderiza bolha de assistant sem conteúdo.
6. **Lead Ads Meta — ativação:** requer `META_APP_ID`/`META_APP_SECRET`, cadastrar página em `meta_lead_ads_pages`, criar fila em Canais de Entrada (lead_distribution_config tinha 0 rows) e webhook leadgen na Meta.
7. **uazapi-proxy — rewiring restante:** WhatsAppChat/MyWhatsApp/whatsappService ainda usam `api_key` direto do browser em alguns fluxos UAZAPI (o principal foi fechado; migrar o resto pra `callUazapi` de `@/lib/uazapiProxy`).
8. Adicionar secret `SUPABASE_DB_PASSWORD` no GitHub pra migrations automáticas (opcional).

## Comandos/queries úteis
```sql
-- conversas do Ronaldo
select m.role, left(m.content,200), m.created_at from agents_messages m
join agents_sessions s on s.id=m.session_id
join agents_registry a on a.id=s.agent_id
where a.display_name='Agente do Stand' order by m.created_at desc limit 30;

-- lembretes de follow-up
select * from agent_reminders order by created_at desc limit 10;

-- SLA e inteligência
select * from vw_agent_sla_mensagens limit 10;
select * from vw_inteligencia_leads order by created_at desc limit 10;
```
- Typecheck: `npx tsc --noEmit -p tsconfig.json` · Build: `npm run build` (rodar `npm install` antes; deps mudam).
- Validar sintaxe de edge function sem deno: esbuild via node (`require('esbuild').transform(...,{loader:'ts'})`).

## Estilo de trabalho com o Marco
- Português brasileiro, tom próximo, explicar como pra não-técnico quando for operação de tela.
- Ele autoriza e gosta que EXECUTE (deploy incluído) — mas mudanças no comportamento do agente que fala com cliente real: mostrar o texto/tom antes.
- Sempre commitar develop→main e confirmar CI verde antes de dizer "no ar".
