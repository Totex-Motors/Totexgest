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
10. **Melhorias (kanban interno, 2026-07-12):** port da feature do vídeo do Frank. Botão flutuante 💡 MÓVEL na borda direita (todas as telas, badge = nº de novos, posição arrastável salva no navegador) → painel "Reportar melhoria" (captura rota/URL/tela/browser + **log dos últimos 20 erros do console** via `src/lib/errorBuffer.ts` instalado no main.tsx + prints via getDisplayMedia ou upload, categoria, severidade). **Anotador estilo Zoho** (`PrintAnnotator.tsx`): após capturar (ou pelo lápis na miniatura) abre editor canvas com retângulo/círculo/seta/texto/caneta em 4 cores; anotações assadas no PNG final — serve pra marcar melhorias que NÃO são erros. Kanban `/gestao/melhorias` (Novo → Eu peguei → Resolvido → Não vai rolar; drag nativo; filtros; detalhe com prints/log de erros/contexto/notas de resolução/análise do Claude). Tabela `melhoria_reports` (RLS tenant, colunas `ai_analysis`+`ai_analyzed_at`) + bucket privado `melhorias-prints` (signed URLs) — migrations `20260712120000` e `20260712130000` APLICADAS em produção. Só interno por enquanto (grupo WhatsApp fica pra depois, decisão do Marco).
11. **Captação / Promotoras — Fases 1, 2 e 4 (2026-09-10, MERGEADO na main, migrations `20260910100000` e `20260910120000` APLICADAS em produção):** Fase 4 = handoff automático (rodízio de especialista, tarefa, aviso WhatsApp via edge function `capture-handoff`, SLA por cron `capture-sla`, 1º contato por trigger, retorno pra promotora em `capture_lead_events`). Config em Configurações › Comercial › Captação. Funil usado: "Captação Tamboré" (nome começa com "Capta"). Detalhes abaixo são da entrega original: papel `promotora` (`isPromotora`), `RoleRoute`, `ProtectedRoute scope` (promotora só entra em `/captacao`), workspace mobile-first `/captacao` (Hoje · Captar · Meus Leads · Treino · Perfil), Quick Capture (6 campos + passo opcional, dedupe, score transparente). Migration `20260910100000_captacao_promotoras_base.sql` (lead_intent, captured_by imutável, seller_vehicles, capture_locations/campaigns, RLS RESTRICTIVE só pra promotora, RPCs `create_capture_lead`/`update_my_capture_lead`/`list_my_capture_leads`/`capture_home_stats`/`ensure_capture_pipeline`) — validada em Postgres local com smoke test de RLS; **ainda não aplicada em produção**. Doc de revisão: `docs/CAPTACAO-PROMOTORAS.md`. Plano completo (Fases 0–8) no docx do Marco (`Plano_TotexGest_Captacao_Promotoras_Franquias_1.docx`).
    **Rotina semi-automática:** trigger `trig_01We62KGpnussHC5vR9YyuVr` (cron `0 * * * *` — DE HORA EM HORA, pedido do Marco 2026-07-12) dispara NESTA sessão: lê cards em `em_andamento` com `ai_analyzed_at IS NULL`, investiga (incl. prints anotados via signed URL + Read), corrige no branch de trabalho (SEM merge na main — Marco autoriza), grava `ai_analysis` e manda resumo. Fila vazia = silêncio. Gerenciar via `list_triggers`/`update_trigger`/`delete_trigger` do MCP Claude_Code_Remote.

12. **REGRA INVIOLÁVEL (2026-09-10) — UAZAPI só grupos/canais.** O número Totexcar ("IA Stand") foi BANIDO pela Meta por mensagem privada via API não oficial (Marco pediu revisão). Enforce em 3 camadas: `whatsapp_instances.group_only` (trigger força true pra provider != meta_cloud), `_shared/wa-policy.ts` → `uazapiTargetAllowed()` antes de todo `/send/*` nas edge functions, `src/lib/waPolicy.ts` na UI (Inbox/Cockpit/lembretes). Bloqueios ficam em `whatsapp_send_blocks`. Conversa 1:1 = só Cloud API ("IAP - OFICIAL"). Avisos da captação vão pro grupo com @menção (`mentions` da UAZAPI). Ver regra no CLAUDE.md.

13. **Reward Engine da captação (PRD do Marco, 2026-09-10):** migration `20260911100000_captacao_reward_engine.sql` APLICADA — regras (`capture_reward_rules`, seed Totex: 40 válidos/semana → Voucher Outback; captado R$25; vendido R$50; campeã do mês R$100), eventos + ledger idempotentes, `leads.capture_valid` (consentimento obrigatório), `seller_vehicles.status` (jornada do carro), carteira/extrato, ranking/ROI, campeã do mês, campanha com frase do dia. UI: `/captacao` (Hoje com GoalRing/WalletCard, Meus Carros, Prêmios) e Configurações › Prêmios da captação (Regras/Aprovações/Ranking/Campanha) + card do veículo no detalhe do lead. Detalhes em `docs/CAPTACAO-PROMOTORAS.md`.

14. **Roleplay IA no treino + perfil folgista (2026-09-11):** `capture-roleplay` (edge fn, JWT) com 5 cenários, avaliação por rubrica; progresso de aulas em `capture_training_progress`. `team_members.capture_profile` padrao|folgista — folgista fora dos incentivos (`capture_award` pula; regra pode marcar `include_folgista`); painel simples. Trigger `protect_team_member_privileges`: só admin muda `role`/`capture_profile` (antes qualquer membro podia se promover pela policy de auto-edição).

15. **Jornada do carro validada (2026-09-11):** migration `20260911160000_captacao_anuncio_venda.sql` + edge fn `capture-listing-sync` (verify_jwt=false; cron `capture-listings` 2×/dia 8h/18h BRT). **Anunciado** = carro aparece no estoque da loja no marketplace (`capture_handoff_config.marketplace_store_id`; sumiu 2× → tarefa pro especialista). **Negociação/Vendido** = negócio do COMPRADOR (`metadata.vehicle.id` = `seller_vehicles.marketplace_vehicle_id`) em Proposta/Ganho (`trg_capture_buyer_deal`). Vendido manual exige valor + deal do comprador ou nota (`set_seller_vehicle_status` ganhou `p_sold_deal_id`/`p_sold_note`; assinatura antiga DROPada). Bônus de venda nasce pendente com a evidência em `ledger.note`. **Pendência:** a loja Totex Motors (Tamboré) NÃO está no marketplace — sem loja configurada o sync só registra "loja não configurada". Detalhes em `docs/CAPTACAO-PROMOTORAS.md`.

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
