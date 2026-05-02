import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getDb } from './firebase.js';
import { CATEGORIES, STATUS, PRIORITY } from './constants.js';

// Cache local: taskId -> { messageId, threadId }
const messageCache = new Map();

export async function refreshTaskboard(client) {
    const channelId = process.env.TASKBOARD_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.error('❌ Canal taskboard não encontrado.');

    const db = getDb();
    const snapshot = await db
        .collection('tasks')
        .where('status', 'not-in', ['done', 'rejected'])
        .orderBy('status')
        .orderBy('createdAt', 'desc')
        .get();

    const activeTasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    const activeIds = new Set(activeTasks.map(t => t.id));

    for (const [taskId, cache] of messageCache.entries()) {
        if (!activeIds.has(taskId)) {
            const msg = await channel.messages.fetch(cache.messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => { });
            messageCache.delete(taskId);
        }
    }

    if (activeTasks.length === 0) {
        if (messageCache.size === 0) {
            const msgs = await channel.messages.fetch({ limit: 20 });
            const botMsgs = msgs.filter(m => m.author.id === client.user.id);
            for (const m of botMsgs.values()) await m.delete().catch(() => { });
        }
        await channel.send({
            embeds: [
                new EmbedBuilder()
                    .setTitle('📋  Taskboard do Regimento')
                    .setDescription('> Nenhuma tarefa ativa no momento.\n> Use `/task criar` para adicionar uma!')
                    .setColor(0x2c2f33)
                    .setFooter({ text: 'FELB Regiment  •  Foxhole' })
                    .setTimestamp(),
            ],
        });
        return;
    }

    for (const task of activeTasks) {
        const { embed, components } = buildTaskMessage(task);
        const cached = messageCache.get(task.id);

        if (cached) {
            const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
            if (msg) {
                await msg.edit({ embeds: [embed], components }).catch(() => { });
                continue;
            }
        }

        const sent = await channel.send({ embeds: [embed], components });
        messageCache.set(task.id, { messageId: sent.id, threadId: null });
    }
}

/** Atualiza apenas uma tarefa específica no taskboard */
export async function refreshSingleTask(client, taskId) {
    const channelId = process.env.TASKBOARD_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const db = getDb();
    const doc = await db.collection('tasks').doc(taskId).get();
    if (!doc.exists) return;

    const task = { id: doc.id, ...doc.data() };

    if (task.status === 'done' || task.status === 'rejected') {
        const cached = messageCache.get(taskId);
        if (cached) {
            const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => { });
            messageCache.delete(taskId);
        }
        return;
    }

    const { embed, components } = buildTaskMessage(task);
    const cached = messageCache.get(taskId);

    if (cached) {
        const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
        if (msg) {
            await msg.edit({ embeds: [embed], components });
            return;
        }
    }

    const sent = await channel.send({ embeds: [embed], components });
    messageCache.set(taskId, { messageId: sent.id, threadId: null });
}

/** Cria um tópico na mensagem da tarefa quando alguém a pega */
export async function createTaskThread(client, taskId, takenByUserId) {
    const channelId = process.env.TASKBOARD_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const cached = messageCache.get(taskId);
    if (!cached) return;

    if (cached.threadId) {
        const thread = await client.channels.fetch(cached.threadId).catch(() => null);
        if (thread) {
            await thread.send(`🔵  <@${takenByUserId}> assumiu esta tarefa!`);
            return;
        }
    }

    const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
    if (!msg) return;

    const db = getDb();
    const doc = await db.collection('tasks').doc(taskId).get();
    const task = doc.data();

    const thread = await msg.startThread({
        name: `📋 ${task.title}`,
        autoArchiveDuration: 1440,
    });

    const doneBtn = new ButtonBuilder();
    doneBtn.setCustomId(`task_done_${taskId}`);
    doneBtn.setLabel('Marcar como concluída');
    doneBtn.setStyle(ButtonStyle.Success);
    doneBtn.setEmoji('✅');

    const row = new ActionRowBuilder().addComponents(doneBtn);

    const priInfo = PRIORITY[task.priority] ?? { label: task.priority, emoji: '' };
    const catInfo = CATEGORIES[task.category] ?? { label: task.category };

    await thread.send({
        embeds: [
            new EmbedBuilder()
                .setTitle('🪖  Tarefa em andamento!')
                .setColor(0x3498db)
                .setDescription(
                    `<@${takenByUserId}> assumiu esta tarefa. Bom trabalho, soldado!\n\n` +
                    `Use este tópico para atualizações de progresso, dúvidas e coordenação com o regimento.`
                )
                .addFields(
                    { name: 'Categoria', value: catInfo.label, inline: true },
                    { name: 'Prioridade', value: priInfo.label, inline: true },
                    { name: 'Descrição', value: task.description || '_Sem descrição_', inline: false },
                )
                .setFooter({ text: 'Quando concluir, clique no botão abaixo.' })
                .setTimestamp(),
        ],
        components: [row],
    });
    await thread.members.add(takenByUserId).catch(() => { });
    messageCache.set(taskId, { messageId: cached.messageId, threadId: thread.id });
}

/** Manda uma mensagem de status no tópico da tarefa */
export async function postToThread(client, taskId, message) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;

    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.send(message).catch(() => { });
}

/** Remove o membro do topico */
export async function removeFromThread(client, taskId, userId) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;

    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.members.remove(userId).catch(() => { });
}

function buildTaskMessage(task) {
    const catInfo = CATEGORIES[task.category] ?? { label: task.category, color: 0xffffff };
    const statusInfo = STATUS[task.status] ?? STATUS.open;
    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };

    const embed = new EmbedBuilder()
        .setColor(statusInfo.color)
        .setAuthor({ name: catInfo.label })
        .setTitle(task.title)
        .addFields(
            { name: '📊  Status', value: statusInfo.label, inline: true },
            { name: '⚡  Prioridade', value: priInfo.label, inline: true },
            { name: '👤  Criado por', value: `<@${task.createdBy}>`, inline: true },
            { name: '📝  Descrição', value: task.description || '_Sem descrição_', inline: false },
        )
        .setFooter({ text: `ID: ${task.id}  •  FELB Regiment` })
        .setTimestamp(task.createdAt?.toDate?.() ?? new Date());

    if (task.takenBy) {
        embed.addFields({ name: '🪖  Responsável', value: `<@${task.takenBy}>`, inline: true });
    }

    const buttons = buildButtons(task);
    const components = buttons.length > 0 ? [new ActionRowBuilder().addComponents(...buttons)] : [];

    return { embed, components };
}

function buildButtons(task) {
    const buttons = [];

    if (task.status === 'approved') {
        const take = new ButtonBuilder();
        take.setCustomId(`task_take_${task.id}`);
        take.setLabel('Assumir tarefa');
        take.setStyle(ButtonStyle.Primary);
        take.setEmoji('🪖');
        buttons.push(take);
    }

    if (task.status === 'taken') {
        const done = new ButtonBuilder();
        done.setCustomId(`task_done_${task.id}`);
        done.setLabel('Concluída');
        done.setStyle(ButtonStyle.Success);
        done.setEmoji('✅');
        buttons.push(done);
    }

    return buttons;
}