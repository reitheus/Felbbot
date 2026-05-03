# 🪖 Foxhole Regiment Bot

Bot de gerenciamento de tarefas para regimentos de Foxhole no Discord.

---

## ✨ Funcionalidades

- 📋 **Taskboard automático** em canal dedicado com embeds e botões
- 📝 **Formulário interativo** para criar tarefas (modal no Discord)
- ✅ **Fluxo de aprovação**: Aberta → Aprovada (líder) → Em andamento → Concluída
- 🗂️ **Categorias**: Logística, Produção, coleta, reconhecimeto e filas
- 🔥 **Firebase Firestore** como banco de dados (gratuito, sem manutenção)

---

## 🛠️ Configuração passo a passo

### 1. Criar o bot no Discord

1. Acesse https://discord.com/developers/applications e clique em **New Application**
2. Vá em **Bot** → **Add Bot**
3. Em **Privileged Gateway Intents**, ative **Server Members Intent** e **Message Content Intent**
4. Copie o **Token** do bot
5. Vá em **OAuth2 → URL Generator**, marque `bot` e `applications.commands`
6. Em permissões do bot, marque:
   - Read Messages/View Channels
   - Send Messages
   - Embed Links
   - Manage Messages
7. Copie o link gerado e adicione o bot ao seu servidor

### 2. Criar o projeto Firebase

1. Acesse https://console.firebase.google.com e crie um projeto
2. Vá em **Firestore Database** → **Criar banco de dados** → modo **produção**
3. Vá em **Configurações do projeto → Contas de serviço**
4. Clique em **Gerar nova chave privada** → salva o arquivo JSON
5. Abra o arquivo JSON e copie o conteúdo inteiro

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o `.env` com:

| Variável | Como obter |
|---|---|
| `DISCORD_TOKEN` | Portal de desenvolvedor do Discord → Bot → Token |
| `CLIENT_ID` | Portal de desenvolvedor → OAuth2 → Client ID |
| `GUILD_ID` | No Discord, clique com botão direito no servidor → Copiar ID do servidor |
| `TASKBOARD_CHANNEL_ID` | Clique com botão direito no canal taskboard → Copiar ID do canal |
| `LEADER_ROLE_IDS` | Configurações do servidor → Cargos → clique direito no cargo de líder → Copiar ID |
| `STAFF_ROLE_IDS` | Cargo para criação de tarefas
| `FIREBASE_SERVICE_ACCOUNT` | Conteúdo completo do JSON da conta de serviço (em uma linha) |

> **Dica:** Para colocar o JSON em uma linha, use: `cat serviceAccountKey.json | tr -d '\n'`

### 4. Instalar e rodar

```bash
npm install

# Registrar slash commands no servidor (só precisa rodar uma vez ou quando mudar comandos)
npm run deploy

# Iniciar o bot
npm start
```

---

## 🎮 Como usar

### Criar uma tarefa
```
/task criar
```
Um formulário abrirá com os campos:
- **Título** — descrição curta da tarefa
- **Descrição** — detalhes (localização, quantidade, etc.)
- **Categoria** — `logistics` ou `production`
- **Prioridade** — `low`, `medium` ou `high`

### Fluxo de aprovação
1. Tarefa criada → aparece no taskboard como **🟡 Aberta**
2. Líder clica **Aprovar** → status muda para **🟢 Aprovada**
3. Membro clica **Pegar tarefa** → status muda para **🔵 Em andamento**
4. Responsável clica **Marcar como concluída** → tarefa sai do taskboard

### Outros comandos
```
/task listar [status]   — lista tarefas filtradas por status (ephemeral)
/task cancelar <id>     — cancela uma tarefa (somente líderes)
```

---

## 🗂️ Estrutura do projeto

```
foxhole-bot/
├── src/
│   ├── commands/
│   │   └── task.js          # Slash command /task
│   ├── events/
│   │   ├── ready.js         # Inicialização
│   │   └── interactionCreate.js  # Modals e botões
│   ├── utils/
│   │   ├── firebase.js      # Conexão com Firestore
│   │   ├── constants.js     # Categorias, status, helpers
│   │   └── taskboard.js     # Lógica de atualização do embed
│   ├── index.js             # Entry point
│   └── deploy-commands.js   # Script de registro de comandos
├── .env.example
├── package.json
└── README.md
```

---

## ☁️ Hospedagem gratuita sugerida

Para manter o bot online 24/7 sem custo:

- **[Railway](https://railway.app)** — $5 de crédito grátis/mês, suficiente para um bot leve
- **[Render](https://render.com)** — plano gratuito com sleep após inatividade (não ideal para bot)
- **[Fly.io](https://fly.io)** — generoso tier gratuito, requer cartão de crédito

> **Recomendação:** Railway é o mais simples. Suba o repositório no GitHub, conecte no Railway e configure as variáveis de ambiente lá.
