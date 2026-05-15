import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getDb } from './firebase.js';
import { CATEGORIES, STATUS, PRIORITY, TASK_REMINDER_MS } from './constants.js';

// Cache local: taskId -> { messageId, threadId }
const messageCache = new Map();

// Timers de lembrete: taskId -> timeoutId
const reminderTimers = new Map();

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

        // Restaura lembrete para tarefas em andamento ao reiniciar
        if (task.status === 'taken' && task.takenAt) {
            const elapsed = Date.now() - task.takenAt.toDate().getTime();
            const remaining = TASK_REMINDER_MS - elapsed;
            if (remaining > 0) scheduleReminder(client, task.id, task.takenBy, remaining);
        }
    }
}

/** Atualiza apenas uma tarefa específica no taskboard */
export async function refreshSingleTask(client, taskId) {
    const channelId = process.env.TASKBOARD_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const db = getDb();
    const doc = await db.collection('tasks').doc(taskId).get().catch(() => null);
    if (!doc?.exists) return;

    const task = { id: doc.id, ...doc.data() };

    if (task.status === 'done' || task.status === 'rejected') {
        const cached = messageCache.get(taskId);
        if (cached) {
            const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => { });
            messageCache.delete(taskId);
        }
        cancelReminder(taskId);

        // Persiste remoção do messageId no Firestore
        await db.collection('tasks').doc(taskId).update({ discordMessageId: null, discordThreadId: null }).catch(() => { });
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

    // Persiste o messageId no Firestore
    await db.collection('tasks').doc(taskId).update({ discordMessageId: sent.id }).catch(() => { });
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
            await thread.members.add(takenByUserId).catch(() => { });
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
    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };
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

    // Persiste threadId no Firestore
    await db.collection('tasks').doc(taskId).update({ discordThreadId: thread.id }).catch(() => { });

    // Agenda lembrete de inatividade
    scheduleReminder(client, taskId, takenByUserId, TASK_REMINDER_MS);

    // Agenda lembrete de prazo (avisa 30 min antes se houver prazo)
    if (task.deadlineAt) {
        const deadlineDate = task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt);
        const msUntilWarning = deadlineDate.getTime() - Date.now() - 30 * 60_000;
        if (msUntilWarning > 0) {
            setTimeout(async () => {
                const cached2 = messageCache.get(taskId);
                if (!cached2?.threadId) return;
                const db2 = getDb();
                const doc2 = await db2.collection('tasks').doc(taskId).get().catch(() => null);
                if (!doc2?.exists || doc2.data().status !== 'taken') return;
                const thread2 = await client.channels.fetch(cached2.threadId).catch(() => null);
                if (!thread2) return;
                const unix = Math.floor(deadlineDate.getTime() / 1000);
                await thread2.send({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setTitle('⚠️  Prazo se aproximando!')
                            .setDescription(`<@${takenByUserId}>, o prazo desta tarefa expira <t:${unix}:R>!Conclua logo ou avise o regimento se precisar de ajuda.`)
                            .setTimestamp(),
                    ],
                }).catch(() => { });
            }, msUntilWarning);
        }
    }
}

/** Manda uma mensagem de status no tópico da tarefa */
export async function postToThread(client, taskId, message) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;
    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.send(message).catch(() => { });
}

/** Remove um usuário do tópico da tarefa */
export async function removeFromThread(client, taskId, userId) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;
    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.members.remove(userId).catch(() => { });
}

/** Agenda lembrete automático para tarefa em andamento */
function scheduleReminder(client, taskId, userId, delay) {
    cancelReminder(taskId);
    const timer = setTimeout(async () => {
        const cached = messageCache.get(taskId);
        if (!cached?.threadId) return;

        const db = getDb();
        const doc = await db.collection('tasks').doc(taskId).get().catch(() => null);
        if (!doc?.exists) return;

        const task = doc.data();
        if (task.status !== 'taken') return;

        const thread = await client.channels.fetch(cached.threadId).catch(() => null);
        if (!thread) return;

        await thread.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(0xe67e22)
                    .setTitle('⏰  Lembrete de tarefa')
                    .setDescription(
                        `<@${userId}>, esta tarefa está em andamento há mais de ${Math.round(TASK_REMINDER_MS / 3600000)}h.\n\n` +
                        `Precisa de ajuda ou já concluiu? Atualize o status!`
                    )
                    .setTimestamp(),
            ],
        });

        reminderTimers.delete(taskId);
    }, delay);

    reminderTimers.set(taskId, timer);
}

function cancelReminder(taskId) {
    const timer = reminderTimers.get(taskId);
    if (timer) {
        clearTimeout(timer);
        reminderTimers.delete(taskId);
    }
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

    if (task.imageUrl) embed.setImage(task.imageUrl);

    if (task.takenBy) {
        embed.addFields({ name: '🪖  Responsável', value: `<@${task.takenBy}>`, inline: true });
    }

    if (task.deadlineAt) {
        const deadlineDate = task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt);
        const unix = Math.floor(deadlineDate.getTime() / 1000);
        const now = Date.now();
        const expired = deadlineDate.getTime() < now;
        embed.addFields({
            name: expired ? '🔴  Prazo EXPIRADO' : '⏳  Prazo',
            value: `<t:${unix}:R> (<t:${unix}:f>)`,
            inline: false,
        });
        if (expired && task.status === 'taken') {
            embed.setColor(0xe74c3c); // vermelho se expirou e ainda em andamento
        }
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