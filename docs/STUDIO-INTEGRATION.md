# Totexgest e Carrossel Studio

Marketing → Instagram → Criar com o Carrossel Studio. Preencha objetivo, marca,
público, briefing, palavra-chave, formato e, opcionalmente, link de material existente.
O briefing é salvo como campanha pausada. Clique em Abrir no Studio e mantenha a
aba do CRM aberta. No Studio, clique em Abrir / criar rascunho, gere texto e imagens,
revise, aprove e salve; então clique em Devolver ao Totexgest.

A devolução inclui prévia JPEG da capa, legenda e texto dos cards para o agente.
Só informa sucesso depois da confirmação de gravação do CRM. Não publica no
Instagram, não ativa campanha e não envia mensagens. O operador publica as artes,
edita a campanha para escolher o post real e o agente e só então ativa o interruptor.
As artes completas continuam disponíveis para download no Studio.

A campanha pausada usa post_id `studio:<uuid>`. A coluna nullable studio_payload
preserva briefing e devolução independentemente do cron que recalcula stats.
A constraint impede ativação sem ID numérico do post, conteúdo recebido e agente
quando reply_mode=agent. RLS existente por tenant continua aplicável.

Transporte: postMessage com origem exata, janela de origem e nonce UUID por abertura.
Nenhuma chave/token é transferida entre apps. Schema limita campos e tamanhos;
links de material exigem HTTPS. O tenant da resposta deve coincidir com a sessão CRM.
A confirmação exige abrir ambos os sistemas no navegador. Para retomar após fechar
uma aba, reabra pelo CRM; o mesmo ID recupera o rascunho salvo sem sobrescrevê-lo.

Produção padrão:
- CRM: https://totexgest-crm.vercel.app
- Studio: https://insta.totexmotors.com

URLs alternativas: VITE_CARROSSEL_STUDIO_URL no CRM; NEXT_PUBLIC_TOTEXGEST_ORIGINS
no Studio (origens HTTPS exatas, separadas por vírgula). Rebuild necessário.
Preview da Vercel não está autorizado automaticamente. Não use wildcard.

Aplicar migration studio_campaign_bridge antes do frontend do CRM.
Teste: npx vitest run src/lib/__tests__/studio-protocol.test.ts.
Build: npm run build.

Esta primeira entrega usa os dados confirmados digitados no briefing. Sincronização
automática do estoque, publicação Instagram e atribuição de vendas são evoluções
separadas. Nenhum evento comercial é presumido por comentário ou clique.
