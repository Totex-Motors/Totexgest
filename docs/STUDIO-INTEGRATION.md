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
- CRM: https://totexgest.vercel.app
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

## Publicação direta no Instagram

A versão aprovada retorna agora todas as artes JPEG (1080 px, quadrado/4:5),
na ordem, além da legenda. `instagram-publish` recebe e armazena as artes em
bucket privado; os dados binários não entram em `studio_payload`.

No CRM: escolha a conta → Verificar autorização → confira artes e legenda →
Publicar no Instagram. A verificação consulta `content_publishing_limit` na
Meta com o token guardado no servidor. Ter acesso a comentários/DMs não garante
permissão de publicação. Se a Meta recusar, revise Conta e tokens e conceda
`instagram_business_content_publish` (Instagram Login) ou
`instagram_content_publish` (Facebook Login).

Preparação avança em chamadas curtas. Um bloqueio no banco impede dois cliques
simultâneos. O estado `publishing` é salvo ANTES do envio final; após timeout não
há reenvio automático. Confira o Instagram e vincule o post existente. Só
`media_id` confirmado produz estado publicado. O atendimento permanece pausado
para revisão; a publicação não dispara mensagens de teste.

A função exige usuário validado, empresa em app_metadata e membro ativo.
A tabela não permite leitura/escrita direta por clientes; a função retorna
somente os campos necessários e URLs temporárias. Não copie tokens para o CRM.
`INSTAGRAM_GRAPH_VERSION` permite atualizar a versão da API (padrão v23.0).

Preparação interrompida pode ser retomada pelo botão Continuar. Se o container
expirar, devolva novamente pelo Studio. Uma campanha vinculada a post existente
não recebe uma nova publicação: crie outra campanha.

Validação: `npx vitest run --config vitest.publish.config.ts` testa isolamento,
permissão negada, publicação em ordem, concorrência e timeout sem duplicação.
Nenhum teste chama a Meta real. Publicação real exige confirmação do operador.

## Melhorias operacionais propostas

1. Separar campanhas de venda, captação e orientação nos relatórios. Medir
   conversas qualificadas e agendamentos, além de comentários e DMs enviadas.
2. Atribuir responsável e prazo para cada conversa que precisa de intervenção.
   Mostrar uma fila de falhas de publicação e atendimentos sem resposta.
3. Relacionar campanha, veículo e oportunidade. Na captação, contrato e venda
   continuam sendo confirmados pelos eventos e evidências da intermediação.
4. Conferir disponibilidade e preço do estoque antes de cada publicação
   programada. Não anunciar automaticamente veículo vendido ou reservado.
5. Manter a criação no Studio e a aprovação, publicação e acompanhamento no CRM.
   Agendamento e atribuição comercial completa são próximos incrementos.
