# Vídeos de treinamento comercial por pessoa e tenant

## Conteúdo do PR

A rota `/comercial/treinamento` lista apenas aulas atribuídas ao membro autenticado. O administrador do tenant pode enviar um MP4 e atribuí-lo a um vendedor ativo do próprio tenant. O vídeo é guardado no bucket privado `commercial-training`; o player baixa o arquivo com a sessão autenticada e a permissão RLS vigente, sem expor URL pública ou link assinado compartilhável.

## Publicação do vídeo do Glauter

O MP4 não é versionado no Git nem colocado em `public/`. Após a migration e o deploy da aplicação:

1. Entre no TotexGest com uma conta administradora do tenant do Glauter.
2. Abra **Comercial → Treinamento**.
3. Informe o título `Treinamento CRM — Glauter`, uma descrição e selecione Glauter na lista de vendedores do próprio tenant.
4. Escolha `treinamento-completo.mp4` e clique em **Enviar e atribuir**.
5. Entre com a conta do Glauter para conferir o vídeo. Um membro de outro tenant não deve ver a atribuição nem conseguir baixar o objeto.

O arquivo `treinamento-completo.mp4` é fornecido junto com a entrega do treinamento. Ele não é incluído no Git: carregue-o pela tela depois de aplicar a migration e publicar a aplicação.

## Modelo de acesso

- `training_video_assignments` liga o vídeo ao tenant e ao `team_members.id` de um vendedor.
- RLS limita leitura ao membro atribuído (publicado) e a escrita ao administrador do mesmo tenant.
- O bucket `commercial-training` é privado, aceita apenas MP4 até 100 MB e usa caminho `<tenant_id>/<member_id>/<uuid>.mp4`.
- A policy de `storage.objects` confere tenant, membro e atribuição publicada; a URL pública não é usada.
- A navegação comercial também é limitada a papéis admin/comercial/closer/SDR.

Para testar o isolamento de ponta a ponta após aplicar a migration, use duas contas de tenants diferentes: atribua a aula no primeiro, confira que o primeiro a reproduz e que o segundo não a lista nem baixa o arquivo.
