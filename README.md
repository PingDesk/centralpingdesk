# Central PingDesk

Aplicação web para operações de help desk de provedores, com identidade visual inspirada no site PingDesk. Inclui autenticação Firebase, perfis, chamados, vendas, provedores, fechamento e métricas.

## Requisitos

- Node.js 20 ou superior e npm.
- Projeto Firebase `central-pd-1a323`.
- Firebase Authentication com o método **E-mail/senha** habilitado.
- Cloud Firestore criado em produção.
- Firebase CLI para publicar as regras e a função administrativa.

## Configuração local

Sem credenciais Firebase configuradas, `npm run dev` disponibiliza um modo de demonstração local com um perfil fictício de cada tipo (administrador, colaborador e provedor) e dados de exemplo. Essa demonstração não autentica nem grava dados no Firebase; para entrar em contas reais, configure o `.env` conforme abaixo.

1. No Firebase Console, crie um app Web em **Configurações do projeto → Geral → Seus apps**.
2. Copie `.env.example` para `.env` e preencha `VITE_FIREBASE_API_KEY` e `VITE_FIREBASE_APP_ID` com os valores do app Web. Mantenha o `projectId` como `central-pd-1a323` e confira o domínio de autenticação.
3. Crie o primeiro usuário administrador em **Authentication → Users**.
4. No Firestore, crie manualmente `users/{UID}` para esse usuário com os campos:

   ```json
   {
     "uid": "UID_DO_USUARIO",
     "name": "Administrador",
     "email": "admin@seudominio.com.br",
     "role": "admin",
     "isOnline": false
   }
   ```

5. Instale e execute a aplicação:

   ```powershell
   npm install
   npm run dev
   ```

## Publicação no Firebase

Faça login na Firebase CLI, selecione `central-pd-1a323` e publique as regras e a função:

```powershell
firebase login
firebase use central-pd-1a323
firebase deploy --only firestore,functions
```

As funções exigem um plano Firebase com faturamento habilitado. A primeira conta de administrador precisa ser criada manualmente; depois disso, o módulo **Acessos** cria, altera e exclui usuários pelo Firebase Admin SDK, sem expor privilégios administrativos ao navegador.

### Notificações de novos chamados no Telegram

1. Adicione o bot aos dois grupos e permita que ele envie mensagens.
2. Configure o token do bot como segredo, sem colocá-lo no código, no `.env` do site ou em mensagens:

   ```powershell
   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
   ```

3. O ID confirmado do grupo operacional está definido em `functions/.env.central-pd-1a323`. Configure o token como segredo e publique a função de novos chamados:

   ```powershell
   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
   firebase deploy --only functions:notifyTelegramOnTicketCreated
   ```

   O valor de `TELEGRAM_CHAT_ID` é `-1003349243615` (supergrupo **CHAMADOS PINGDESK**). O arquivo `.env` de Functions está ignorado pelo Git, pois contém parâmetros locais do projeto.

4. Após publicar, cada chamado novo salvo no Firestore real aciona uma mensagem no grupo operacional com provedor, colaborador, cliente, endereço, contato, protocolo, assunto e descrição. A demonstração local não grava no Firestore e não envia notificações ao Telegram.
5. Cada comentário de provedor é enviado ao grupo administrativo com o provedor, protocolo e texto.
6. Diariamente às **23:45**, no fuso `America/Sao_Paulo`, o grupo administrativo recebe apenas um lembrete se algum provedor estiver no dia final do ciclo de fechamento. Não há resumo financeiro nessa mensagem.

Os envios acontecem no backend; o token nunca é disponibilizado ao navegador. Falhas são registradas nos logs das Cloud Functions e reprocessadas. O ID `-1003349243615` é do supergrupo operacional e `-5402687555` é do grupo administrativo. O mesmo bot pode enviar para os dois grupos, desde que esteja em ambos e tenha permissão para enviar mensagens. As mensagens do grupo operacional incluem dados pessoais de clientes; restrinja o grupo aos destinatários autorizados.

## Regras de operação

- A franquia é compartilhada entre chamados N1, N2 e Pré Venda em ordem cronológica de abertura; chamados Massivo são cobrados separadamente. A taxa correspondente do provedor é aplicada apenas ao excedente.
- A conversão de Pré Venda registra o valor do plano e a data de instalação na coleção de vendas. O atendimento continua contando como Pré Venda para a franquia; a venda aparece no fechamento do ciclo em que foi convertida como linha informativa fora da cobrança de help desk.
- O período de fechamento considera o dia de início e de fim cadastrados no provedor, inclusive quando o ciclo atravessa dois meses.
- Após o encerramento do ciclo, o administrador pode arquivar o fechamento. Os atendimentos e as vendas deixam as listas operacionais e permanecem no histórico; o administrador e o provedor vinculado podem baixar novamente a planilha Excel arquivada.
- O padrão de protocolo é opcional e aceita uma expressão regular JavaScript. O fechamento sinaliza protocolos duplicados e divergentes desse padrão.
- Assuntos são configurados pelo administrador e podem ser vinculados a vários provedores. Ao abrir um chamado, o colaborador escolhe um assunto disponível para o provedor selecionado para preencher a descrição e o nível sugeridos, que permanecem editáveis antes do envio.
- Colaboradores têm Dashboard, Registro de Chamados e Registro em Massa no menu, sem necessidade de vincular a conta a um provedor. O Dashboard é uma tela simples de status ativo/pausa, sem métricas ou relatórios; ao iniciar uma pausa, os demais colaboradores ativos recebem um aviso em tempo real na central. Em Registro de Chamados, o formulário fica aberto na página, com espaço ampliado para complementar a descrição, sem acesso ao histórico; o campo de provedor inicia em “Selecione um provedor” e pode ser preenchido manualmente ou automaticamente pelo padrão de protocolo cadastrado. Se o protocolo corresponder a mais de um provedor, é necessário escolher manualmente. O assunto disponível corresponde ao provedor selecionado; assunto, cliente, endereço, protocolo, contato, nível e descrição são obrigatórios. Ao trocar de assunto, o nível e a descrição sugeridos são atualizados juntos. Protocolos incompatíveis com o padrão do provedor geram um aviso e bloqueiam o envio até a conferência. A abertura grava data e hora do computador do colaborador. Em Registro em Massa, seleciona um provedor e registra até 500 protocolos do mesmo evento em um único envio; cada protocolo vira um chamado de nível `Massivo`, com o assunto e a descrição `EVENTO NA REDE`. Esse assunto é fixo do fluxo e não precisa ser cadastrado previamente.
- Administradores usam **Atuações** como uma agenda diária por colaborador, com escala horária de 24 horas. Arrastam um provedor para a coluna do colaborador e definem data, início e término; também podem clicar no provedor para iniciar o agendamento ou editar e excluir turnos na agenda. O Dashboard do colaborador exibe as atuações do dia em sua própria agenda horária. Nos últimos 15 minutos de cada turno, o colaborador recebe um aviso com o próximo responsável agendado para o provedor; se não houver turno cadastrado nos próximos 60 dias, isso também é informado.
- Contas de provedor têm apenas Dashboard, Chamados e Pré Fechamento. O Dashboard apresenta os chamados do mês, a média mensal por nível dos últimos seis meses e o valor previsto do ciclo atual. Chamados e pré-fechamento usam somente os dados vinculados ao provedor da conta; a lista permite busca, filtro por nível e exportação Excel. O pré-fechamento detalha os chamados, o uso da franquia, os excedentes, o valor fixo, alertas de protocolo e as vendas do ciclo, e também pode ser exportado.
- O provedor pode incluir comentários nos chamados associados à sua conta. Os comentários ficam visíveis no Dashboard do administrador como atualizações por provedor e protocolo; somente administradores podem ler a coleção de comentários.
- A presença é atualizada enquanto a central está aberta, com heartbeat a cada minuto; o painel considera online um acesso atualizado nos últimos dois minutos e mostra todos os colaboradores cadastrados, priorizando os online, com o tempo da sessão atual ou desde a última presença registrada.
- O cartão **Precisa de ajuda?** abre o WhatsApp de contato da PingDesk. O sino exibe comentários recentes para administradores, avisos de pausa recebidos nesta sessão para colaboradores e chamados recentes vinculados ao provedor.
- Exporte chamados e fechamentos em `.xlsx` diretamente na tela correspondente.

## Estrutura de dados

- `users/{uid}`: identidade, perfil, provedor associado e presença.
- `providers/{providerId}`: CNPJ, franquia, valores, ciclo e padrão de protocolo.
- `subjects/{subjectId}`: assunto, provedor, nível padrão e mensagem inicial do chamado.
- `tickets/{ticketId}`: chamado, provedor, colaborador, nível, protocolo e horários.
- `ticketComments/{commentId}`: comentário do provedor, protocolo, provedor vinculado e data de envio; apenas administradores podem ler os comentários.
- `telegramNotificationClaims/{ticketId}`: estado interno de envio da notificação do chamado ao Telegram, usado para evitar mensagens duplicadas em reprocessamentos.
- `sales/{saleId}`: chamado convertido, valor do plano e data de instalação.
- `archivedClosings/{closingId}`: resumo imutável do fechamento, período e provedor; os registros arquivados permanecem nas coleções de chamados e vendas associados pelo campo `archiveId`.
- `actuations/{actuationId}`: provedor, colaborador responsável, data e horário do turno.

As regras de `firestore.rules` limitam a leitura de chamados a administradores e ao provedor associado; colaboradores podem criar chamados, mas não consultar o histórico. Agendamentos só podem ser criados ou editados pelo administrador; o colaborador pode ler somente os turnos atribuídos à própria conta. Cada assunto fica vinculado a um provedor; o colaborador precisa selecionar um para abrir o chamado, podendo ajustar o nível e a descrição sugeridos.
