# Gerenciador de E-mails com Node.js e PM2

Este projeto consiste em um serviço de backend robusto, construído em Node.js, para monitorar múltiplas caixas de e-mail (via IMAP), persistir as mensagens em um banco de dados Supabase e fornecer uma API RESTful para listar e enviar e-mails (via SMTP).

O sistema é projetado para ser resiliente, garantindo que nenhuma mensagem seja perdida mesmo que o serviço seja interrompido, e escalável para gerenciar um número dinâmico de contas de e-mail.

## ✨ Funcionalidades

  - **Monitoramento IMAP:** Conecta-se a múltiplas caixas de entrada para ouvir por novos e-mails.
  - **Persistência de Dados:** Salva e-mails processados em um banco de dados PostgreSQL no Supabase.
  - **Sincronização Inteligente:**
      - Na primeira conexão, ignora o histórico e começa a monitorar a partir daquele momento.
      - Em reinicializações, recupera automaticamente e-mails perdidos durante o tempo offline usando o `UID` do IMAP.
  - **API de Gerenciamento:** Adicione e remova caixas de e-mail dinamicamente através de endpoints REST.
  - **API de E-mail:** Endpoints para listar e-mails de uma conta com paginação e para enviar novos e-mails.
  - **Gerenciamento de Processos:** Utiliza o **PM2** para gerenciar e isolar o processo de cada caixa de entrada, garantindo estabilidade e reinicialização automática em caso de falhas.

## 📋 Pré-requisitos

Antes de começar, certifique-se de que você tem os seguintes softwares instalados:

  - [Node.js](https://nodejs.org/) (versão 18 ou superior)
  - [npm](https://www.npmjs.com/) (geralmente vem com o Node.js)
  - [PM2](https://pm2.keymetrics.io/) instalado globalmente:
    ```bash
    npm install pm2 -g
    ```
  - Uma conta gratuita no [Supabase](https://supabase.com/).

## ⚙️ Instalação e Configuração

Siga estes passos para configurar e rodar o projeto localmente.

### 1\. Clonar o Repositório

```bash
# Clone este repositório para sua máquina local
git clone <URL_DO_SEU_REPOSITORIO>
cd <NOME_DO_DIRETORIO>
```

### 2\. Instalar Dependências

Execute o seguinte comando para instalar todas as bibliotecas necessárias listadas no `package.json`:

```bash
npm install
```

### 3\. Configurar o Banco de Dados (Supabase)

O arquivo `db.sql` contém todo o esquema necessário para o banco de dados.

1.  Acesse seu painel no [Supabase](https://www.google.com/search?q=https://app.supabase.com) e crie um novo projeto.
2.  No menu esquerdo do projeto, vá para **SQL Editor**.
3.  Clique em **+ New query**.
4.  Copie **todo o conteúdo** do arquivo `db.sql` do projeto e cole no editor.
5.  Clique em **RUN**. Isso criará todas as tabelas e configurações necessárias (`mailboxes`, `emails`, `mailbox_sync_status`).

### 4\. Configurar Variáveis de Ambiente

As credenciais e configurações sensíveis são gerenciadas através de um arquivo `.env`.

1.  Crie uma cópia do arquivo de exemplo:

    ```bash
    cp .env.example .env
    ```

2.  Abra o arquivo `.env` e preencha com suas informações do Supabase:

    ```env
    # Porta em que a API principal irá rodar
    PORT=3000

    # Credenciais do seu projeto Supabase
    # Vá para Project Settings > API no seu painel Supabase
    SUPABASE_URL=https://SEU_PROJETO.supabase.co
    SUPABASE_KEY=SUA_CHAVE_SERVICE_ROLE
    ```

    > **Importante:** Para o backend, use a chave **`service_role`** (encontrada em Project Settings -> API Keys -> service_role (secret)), pois ela tem as permissões necessárias para operar no banco de dados, ignorando as políticas de RLS.

## ▶️ Executando a Aplicação

Para iniciar o servidor da API principal, que por sua vez gerenciará os workers de e-mail, use o PM2:

```bash
pm2 start api.js --name="mailbox-manager-api"
```

O serviço agora está rodando em segundo plano.

### Comandos Úteis do PM2

  - **Listar todos os processos gerenciados:**

    ```bash
    pm2 list
    ```

    *(Inicialmente, você verá apenas `mailbox-manager-api`. Os workers aparecerão aqui à medida que você os adicionar via API.)*

  - **Visualizar logs em tempo real:**

    ```bash
    pm2 logs
    ```

  - **Monitorar uso de CPU e Memória:**

    ```bash
    pm2 monit
    ```

  - **Parar o serviço:**

    ```bash
    pm2 stop mailbox-manager-api
    ```

  - **Reiniciar o serviço:**

    ```bash
    pm2 restart mailbox-manager-api
    ```

## 🚀 Documentação da API

Todos os endpoints rodam na porta definida no seu arquivo `.env` (padrão: `3000`).

### Gerenciamento de Mailboxes

  - **`POST /api/mailboxes`** - Adiciona uma nova caixa de e-mail para monitoramento.
      - **Body (JSON):**
        ```json
        {
          "email": "teste@provedor.com",
          "imap_host": "imap.provedor.com",
          "imap_port": 993,
          "imap_user": "teste@provedor.com",
          "imap_pass": "senha123",
          "imap_tls": true,
          "smtp_host": "smtp.provedor.com",
          "smtp_port": 465,
          "smtp_user": "teste@provedor.com",
          "smtp_pass": "senha123",
          "smtp_secure": true
        }
        ```
  - **`GET /api/mailboxes`** - Lista todas as caixas de e-mail configuradas.
  - **`DELETE /api/mailboxes/:id`** - Remove uma caixa de e-mail e para seu worker.

### Leitura e Envio de E-mails

  - **`GET /api/mailboxes/:id/emails`** - Lista os e-mails salvos para uma mailbox, com paginação.
      - **Query Params:** `page` (número da página, ex: 1), `limit` (itens por página, ex: 20).
      - **Exemplo:** `http://localhost:3000/api/mailboxes/1/emails?page=1&limit=10`
  - **`POST /api/send`** - Envia um novo e-mail.
      - **Body (JSON):**
        ```json
        {
          "from": "email_configurado@provedor.com",
          "to": "destinatario@exemplo.com",
          "subject": "Assunto do E-mail",
          "text": "Corpo do e-mail em texto puro.",
          "html": "<p>Corpo do e-mail em <b>HTML</b>.</p>"
        }
        ```

### Saúde do Servidor

  - **`GET /health/live`** - Verifica se o processo da API está ativo.
  - **`GET /health/ready`** - Verifica se a API está pronta para receber requisições (ex: conexão com o banco está OK).

## 🌳 Estrutura do Projeto

```
.
├── api.js              # Processo Mestre: Servidor da API e gerenciador de workers
├── worker.js           # Processo Filho: Lógica de monitoramento de UMA caixa de e-mail
├── supabase.js         # Configuração do cliente Supabase
├── db.sql              # Script com o schema completo do banco de dados
├── .env                # Arquivo para variáveis de ambiente (local)
├── .env.example        # Arquivo de exemplo para as variáveis de ambiente
├── package.json        # Dependências e scripts do projeto
└── README.md           # Este arquivo
```