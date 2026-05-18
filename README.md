# 🪖 Foxhole Regiment Bot

Bot de gerenciamento de tarefas para regimentos de Foxhole no Discord.

---

## ✨ Funcionalidades

- 📋 **Taskboard automático** em canal dedicado com embeds e botões
- 📝 **Formulários interativos** por categoria com campos guiados
- ✅ **Fluxo de aprovação**: Aberta → Aprovada (líder) → Em andamento → Concluída
- 🗂️ **5 categorias** com modais específicos: Logística, Produção, Reconhecimento, Fila de Fábrica e Coleta
- ⏳ **Prazo por tarefa** com contagem regressiva e aviso 30 min antes de expirar
- 💬 **Tópico automático** criado quando alguém assume uma tarefa
- 📬 **Notificação via DM** para o criador quando a tarefa é aprovada ou rejeitada
- 🚫 **Limite de tarefas simultâneas** por usuário (padrão: 3)
- ⏰ **Lembrete automático** se a tarefa ficar em andamento por mais de 4h sem conclusão
- 🔥 **Firebase Firestore** como banco de dados (gratuito, sem manutenção)

---

## 🗂️ Categorias e campos

### 🚛 Logística
| Campo | Descrição |
|---|---|
| Título | Resumo da tarefa |
| Carga | Quantidade e tipo (ex: 5 caixas de Soldier Supplies) |
| Origem → Destino | Rota completa |
| Observações | Rota preferida, perigos, veículo necessário |
| Prazo | Tempo limite (ex: 2h, 90min, 1d) |

### 🏭 Produção
| Campo | Descrição |
|---|---|
| Título | Resumo da tarefa |
| Item e quantidade | Ex: 200x Tremola Grenade |
| Fábrica / Local | Ex: Factory Town — Small Arms Factory |
| Observações | Materiais disponíveis, destino da produção |
| Prazo | Tempo limite |

### 🔍 Reconhecimento
| Campo | Descrição |
|---|---|
| Título | Resumo da tarefa |
| Área / Região alvo | Ex: Callahan's Belt — setor norte |
| Objetivo | Ex: Localizar posições de artilharia inimiga |
| Observações | Nível de risco, equipamento necessário |
| Prazo | Tempo limite |

### 📋 Fila de Fábrica
| Campo | Descrição |
|---|---|
| Título | Resumo da tarefa |
| Fábrica / Local | Ex: Factory Town — Small Arms Factory |
| Itens em ordem de prioridade | Lista numerada de itens a enfileirar |
| Observações | Materiais disponíveis, restrições |
| Prazo | Tempo limite |

### ⛏️ Coleta
| Campo | Descrição |
|---|---|
| Título | Resumo da tarefa |
| Recurso e quantidade | Ex: 500x Sulfur Coal |
| Local de coleta | Ex: Weathered Expanse — campo norte |
| Observações | Destino, segurança da área |
| Prazo | Tempo limite |

---

## 🔄 Fluxo de uma tarefa

```
Membro usa /task criar
    ↓
Seleciona categoria e prioridade (dropdowns)
    ↓
Preenche formulário (modal específico por categoria)
    ↓
📩 Canal #aprovações — só líderes veem
   [✅ Aprovar]  [❌ Rejeitar]
    ↓
Criador recebe DM com o resultado
    ↓ se aprovada
📋 Aparece no #taskboard (todos veem)
   [🪖 Assumir tarefa]
    ↓ membro assume
💬 Tópico criado automaticamente
   Bot avisa 30min antes do prazo
   Bot lembra após 4h sem conclusão
   [✅ Marcar como concluída]
    ↓
Tarefa some do taskboard
Tópico arquivado com histórico
```

---

## 🛠️ Configuração passo a passo

### 1. Criar o bot no Discord

1. Acesse https://discord.com/developers/applications e clique em **New Application**
2. Vá em **Bot** → **Add Bot**
3. Em **Privileged Gateway Intents**, ative **Server Members Intent** e **Message Content Intent**
4. Copie o **Token** do bot
5. Vá em **OAuth2 → URL Generator**, marque `bot` e `applications.commands`
6. Em permissões do bot, marque:
   - Read Messages / View Channels
   - Send Messages
   - Embed Links
   - Manage Messages
   - Create Public Threads
   - Send Messages in Threads
   - Manage Threads
7. Copie o link gerado e adicione o bot ao seu servidor

### 2. Criar o projeto Firebase

1. Acesse https://console.firebase.google.com e crie um projeto
2. Vá em **Firestore Database** → **Criar banco de dados** → modo **produção**
3. Selecione a região `southamerica-east1` (São Paulo)
4. Vá em **Configurações do projeto → Contas de serviço**
5. Clique em **Gerar nova chave privada** → salve o arquivo JSON

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

| Variável | Como obter |
|---|---|
| `DISCORD_TOKEN` | Portal de desenvolvedor → Bot → Token |
| `CLIENT_ID` | Portal de desenvolvedor → OAuth2 → Client ID |
| `GUILD_ID` | Discord → clique direito no servidor → Copiar ID |
| `TASKBOARD_CHANNEL_ID` | Clique direito no canal taskboard → Copiar ID |
| `APPROVAL_CHANNEL_ID` | Clique direito no canal de aprovações → Copiar ID |
| `LEADER_ROLE_IDS` | Configurações → Cargos → clique direito no cargo → Copiar ID |
| `FIREBASE_SERVICE_ACCOUNT` | Conteúdo completo do JSON da conta de serviço em uma linha |

Para converter o JSON em uma linha:
```bash
# Linux/Mac
cat serviceAccountKey.json | tr -d '\n'

# Windows (PowerShell)
(Get-Content serviceAccountKey.json) -join ''
```

### 4. Configurar canais no Discord

Crie dois canais:
- **`#taskboard`** — visível para todos, onde aparecem as tarefas aprovadas
- **`#aprovações`** — visível apenas para líderes, onde chegam as tarefas aguardando aprovação

### 5. Instalar e rodar

```bash
npm install

# Registrar slash commands (apenas uma vez ou ao adicionar novos comandos)
npm run deploy

# Iniciar o bot
npm start
```

---

## 🎮 Comandos

| Comando | Descrição | Quem pode usar |
|---|---|---|
| `/task criar` | Cria uma nova tarefa com formulário interativo | Todos |
| `/task listar [status]` | Lista tarefas filtradas por status | Todos |
| `/task status <id>` | Detalhes completos de uma tarefa específica | Todos |
| `/task historico [quantidade]` | Últimas tarefas concluídas | Todos |
| `/task stats` | Estatísticas gerais do regimento | Todos |
| `/task cancelar <id>` | Cancela uma tarefa | Apenas líderes |

### Formatos de prazo
| Formato | Significado |
|---|---|
| `30min` | 30 minutos |
| `2h` | 2 horas |
| `1d` | 1 dia |
| _(vazio)_ | Sem prazo |

---

## ⚙️ Configurações

Editáveis em `src/utils/constants.js`:

| Constante | Padrão | Descrição |
|---|---|---|
| `MAX_TASKS_PER_USER` | `3` | Limite de tarefas simultâneas por membro |
| `TASK_REMINDER_MS` | `4h` | Tempo para lembrete de inatividade |
| `PENDING_SELECTION_TTL` | `5min` | Tempo limite para seleção de categoria/prioridade |

---

## 🗂️ Estrutura do projeto

```
foxhole-bot/
├── src/
│   ├── commands/
│   │   └── task.js               # Slash commands
│   ├── events/
│   │   ├── ready.js              # Inicialização
│   │   └── interactionCreate.js  # Modals, botões e select menus
│   ├── utils/
│   │   ├── firebase.js           # Conexão com Firestore
│   │   ├── constants.js          # Categorias, status, configurações
│   │   ├── taskboard.js          # Lógica do taskboard e tópicos
│   │   └── approval.js           # Canal de aprovação e notificações
│   ├── index.js                  # Entry point
│   └── deploy-commands.js        # Registro de slash commands
├── .env.example
├── package.json
└── README.md
```

---

## ☁️ Hospedagem gratuita

| Opção | Descrição |
|---|---|
| **Railway** | Mais simples — conecte o GitHub e configure as variáveis. $5 crédito grátis/mês (suficiente para um bot leve) |
| **Fly.io** | 3 VMs pequenas grátis, sem limite de horas |
| **Oracle Cloud** | VM grátis para sempre, mais trabalhoso de configurar |
| **PM2 local** | Se seu PC fica ligado quando o regimento joga |

### Rodar em background com PM2
```bash
npm install -g pm2
pm2 start src/index.js --name foxhole-bot
pm2 startup   # inicia automaticamente com o PC
pm2 save
```
