import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} from 'discord.js';
import { getDb } from './firebase.js';
import { CATEGORIES, PRIORITY, STATUS, TASK_REMINDER_MS } from './constants.js';

// Cache local: taskId -> { messageId, threadId }
const messageCache = new Map();
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
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0x2c2f33)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## 📋  Taskboard do Regimento'),
                        new TextDisplayBuilder().setContent('> Nenhuma tarefa ativa no momento.\n> Use `/task criar` para adicionar uma!'),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# FELB Regiment  •  Foxhole')),
            ],
        });
        return;
    }

    for (const task of activeTasks) {
        const components = buildTaskMessage(task);
        const cached = messageCache.get(task.id);

        if (cached) {
            const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
            if (msg) {
                await msg.edit({ flags: MessageFlags.IsComponentsV2, components }).catch(() => { });
                continue;
            }
        }

        const sent = await channel.send({ flags: MessageFlags.IsComponentsV2, components });
        messageCache.set(task.id, { messageId: sent.id, threadId: null });

        if (task.status === 'taken' && task.takenAt) {
            const elapsed = Date.now() - task.takenAt.toDate().getTime();
            const remaining = TASK_REMINDER_MS - elapsed;
            if (remaining > 0) scheduleReminder(client, task.id, task.takenBy, remaining);
        }
    }
}

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
        await db.collection('tasks').doc(taskId).update({ discordMessageId: null, discordThreadId: null }).catch(() => { });
        return;
    }

    const components = buildTaskMessage(task);
    const cached = messageCache.get(taskId);

    if (cached) {
        const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
        if (msg) {
            await msg.edit({ flags: MessageFlags.IsComponentsV2, components });
            return;
        }
    }

    const sent = await channel.send({ flags: MessageFlags.IsComponentsV2, components });
    messageCache.set(taskId, { messageId: sent.id, threadId: null });
    await db.collection('tasks').doc(taskId).update({ discordMessageId: sent.id }).catch(() => { });
}

export async function createTaskThread(client, taskId, takenByUserId) {
    const channelId = process.env.TASKBOARD_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const cached = messageCache.get(taskId);
    if (!cached) return;

    if (cached.threadId) {
        const thread = await client.channels.fetch(cached.threadId).catch(() => null);
        if (thread) { await thread.members.add(takenByUserId).catch(() => { }); return; }
    }

    const msg = await channel.messages.fetch(cached.messageId).catch(() => null);
    if (!msg) return;

    const db = getDb();
    const doc = await db.collection('tasks').doc(taskId).get();
    const task = doc.data();

    // Atualiza mensagem do taskboard para refletir status "taken"
    const updatedComponents = buildTaskMessage({ id: taskId, ...task, status: 'taken', takenBy: takenByUserId });
    await msg.edit({ flags: MessageFlags.IsComponentsV2, components: updatedComponents }).catch(() => { });

    const thread = await msg.startThread({
        name: `📋 ${task.title}`,
        autoArchiveDuration: 1440,
    });

    const doneBtn = new ButtonBuilder()
        .setCustomId(`task_done_${taskId}`)
        .setLabel('Marcar como concluída')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };
    const catInfo = CATEGORIES[task.category] ?? { label: task.category };

    let deadlineText = '';
    if (task.deadlineAt) {
        const unix = Math.floor((task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt)).getTime() / 1000);
        deadlineText = `\n⏳ **Prazo:** <t:${unix}:R>`;
    }

    const descText = task.description ? task.description : '_Sem descrição_';

    await thread.send({
        flags: MessageFlags.IsComponentsV2,
        components: [
            new ContainerBuilder()
                .setAccentColor(0x3498db)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('## 🪖  Tarefa assumida!'),
                    new TextDisplayBuilder().setContent(
                        `<@${takenByUserId}> assumiu esta tarefa. Bom trabalho, soldado!\n` +
                        `Use este tópico para atualizações, dúvidas e coordenação com o regimento.`
                    ),
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**${catInfo.label}**  •  ${priInfo.label}${deadlineText}\n\n${descText}`
                    ),
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addActionRowComponents(new ActionRowBuilder().addComponents(doneBtn))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('-# Clique no botão acima quando concluir.'),
                ),
        ],
    });

    await thread.members.add(takenByUserId).catch(() => { });
    messageCache.set(taskId, { messageId: cached.messageId, threadId: thread.id });
    await db.collection('tasks').doc(taskId).update({ discordThreadId: thread.id }).catch(() => { });

    scheduleReminder(client, taskId, takenByUserId, TASK_REMINDER_MS);

    if (task.deadlineAt) {
        const deadlineDate = task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt);
        const msUntilWarning = deadlineDate.getTime() - Date.now() - 30 * 60_000;
        if (msUntilWarning > 0) {
            setTimeout(async () => {
                const c = messageCache.get(taskId);
                if (!c?.threadId) return;
                const d = await getDb().collection('tasks').doc(taskId).get().catch(() => null);
                if (!d?.exists || d.data().status !== 'taken') return;
                const t = await client.channels.fetch(c.threadId).catch(() => null);
                if (!t) return;
                const unix = Math.floor(deadlineDate.getTime() / 1000);
                await t.send({
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(0xe74c3c)
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## ⚠️  Prazo se aproximando!'),
                                new TextDisplayBuilder().setContent(
                                    `<@${takenByUserId}>, o prazo expira <t:${unix}:R>!\n` +
                                    `Conclua logo ou avise o regimento se precisar de ajuda.`
                                ),
                            ),
                    ],
                }).catch(() => { });
            }, msUntilWarning);
        }
    }
}

export async function postToThread(client, taskId, message) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;
    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.send(message).catch(() => { });
}

export async function removeFromThread(client, taskId, userId) {
    const cached = messageCache.get(taskId);
    if (!cached?.threadId) return;
    const thread = await client.channels.fetch(cached.threadId).catch(() => null);
    if (thread) await thread.members.remove(userId).catch(() => { });
}

function scheduleReminder(client, taskId, userId, delay) {
    cancelReminder(taskId);
    const timer = setTimeout(async () => {
        const cached = messageCache.get(taskId);
        if (!cached?.threadId) return;
        const doc = await getDb().collection('tasks').doc(taskId).get().catch(() => null);
        if (!doc?.exists || doc.data().status !== 'taken') return;
        const thread = await client.channels.fetch(cached.threadId).catch(() => null);
        if (!thread) return;
        await thread.send({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0xe67e22)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ⏰  Lembrete de tarefa'),
                        new TextDisplayBuilder().setContent(
                            `<@${userId}>, esta tarefa está em andamento há mais de ${Math.round(TASK_REMINDER_MS / 3600000)}h.\n` +
                            `Precisa de ajuda ou já concluiu? Atualize o status!`
                        ),
                    ),
            ],
        });
        reminderTimers.delete(taskId);
    }, delay);
    reminderTimers.set(taskId, timer);
}

function cancelReminder(taskId) {
    const timer = reminderTimers.get(taskId);
    if (timer) { clearTimeout(timer); reminderTimers.delete(taskId); }
}

function buildTaskMessage(task) {
    const catInfo = CATEGORIES[task.category] ?? { label: task.category, color: 0xffffff };
    const statusInfo = STATUS[task.status] ?? STATUS.open;
    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };

    const expired = task.deadlineAt &&
        (task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt)).getTime() < Date.now();
    const accentColor = (expired && task.status === 'taken') ? 0xe74c3c : statusInfo.color;

    let deadlineText = '';
    if (task.deadlineAt) {
        const deadlineDate = task.deadlineAt?.toDate ? task.deadlineAt.toDate() : new Date(task.deadlineAt);
        const unix = Math.floor(deadlineDate.getTime() / 1000);
        deadlineText = expired
            ? `\n🔴 **Prazo EXPIRADO** — <t:${unix}:R>`
            : `\n⏳ **Prazo** — <t:${unix}:R>`;
    }

    const responsavelText = task.takenBy ? `\n🪖 **Responsável** — <@${task.takenBy}>` : '';
    const descText = task.description ? '\n\n' + task.description : '';

    const metaLine = `${statusInfo.label}  •  ${priInfo.label}  •  👤 <@${task.createdBy}>`;

    const buttons = buildButtons(task);

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`**${catInfo.label}**`),
            new TextDisplayBuilder().setContent(`## ${task.title}`),
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                metaLine + deadlineText + responsavelText + descText
            ),
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ID: ${task.id}  •  FELB Regiment`),
        );

    if (buttons.length > 0) {
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
        container.addActionRowComponents(new ActionRowBuilder().addComponents(...buttons));
    }

    return [container];
}

function buildButtons(task) {
    const buttons = [];

    if (task.status === 'approved') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`task_take_${task.id}`)
                .setLabel('Assumir tarefa')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🪖')
        );
    }

    if (task.status === 'taken') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`task_done_${task.id}`)
                .setLabel('Concluída')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅')
        );
    }

    return buttons;
}