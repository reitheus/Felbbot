import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    EmbedBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} from 'discord.js';
import { CATEGORIES, PRIORITY } from './constants.js';

const approvalCache = new Map();

export async function sendToApproval(client, task) {
    const channelId = process.env.APPROVAL_CHANNEL_ID;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.error('❌ Canal de aprovação não encontrado.');

    const catInfo = CATEGORIES[task.category] ?? { label: task.category };
    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };

    let deadlineText = '';
    if (task.deadlineAt) {
        const unix = Math.floor(
            (task.deadlineAt instanceof Date ? task.deadlineAt : new Date(task.deadlineAt)).getTime() / 1000
        );
        deadlineText = `\n⏳ **Prazo:** <t:${unix}:R>`;
    }

    const descText = task.description
        ? task.description
        : '_Sem descrição_';

    const approveBtn = new ButtonBuilder()
        .setCustomId(`task_approve_${task.id}`)
        .setLabel('Aprovar')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅');

    const rejectBtn = new ButtonBuilder()
        .setCustomId(`task_reject_${task.id}`)
        .setLabel('Rejeitar')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⛔');

    const container = new ContainerBuilder()
        .setAccentColor(0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`**${catInfo.label}**  •  ${priInfo.label}`),
            new TextDisplayBuilder().setContent(`## ${task.title}`),
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `👤 **Solicitado por:** <@${task.createdBy}>${deadlineText}\n\n${descText}`
            ),
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(approveBtn, rejectBtn),
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ID: ${task.id}  •  FELB Regiment`),
        );

    const sent = await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
    });
    approvalCache.set(task.id, sent.id);
}

export async function removeFromApproval(client, taskId) {
    const channelId = process.env.APPROVAL_CHANNEL_ID;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return;

    const msgId = approvalCache.get(taskId);
    if (msgId) {
        const msg = await channel.messages.fetch(msgId).catch(() => null);
        if (msg) await msg.delete().catch(() => { });
        approvalCache.delete(taskId);
        return;
    }

    // Fallback: busca pelo ID no conteúdo dos components
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;

    const target = messages.find(m =>
        m.author.id === client.user.id &&
        m.components?.some(c => JSON.stringify(c).includes(`task_approve_${taskId}`))
    );

    if (target) await target.delete().catch(() => { });
}

export async function notifyCreator(client, task, action, leaderUserId) {
    try {
        const creator = await client.users.fetch(task.createdBy).catch(() => null);
        if (!creator) return;

        const isApproved = action === 'approved';

        await creator.send({
            embeds: [
                new EmbedBuilder()
                    .setColor(isApproved ? 0x2ecc71 : 0xe74c3c)
                    .setTitle(isApproved ? '✅  Sua tarefa foi aprovada!' : '⛔  Sua tarefa foi rejeitada')
                    .setDescription(
                        isApproved
                            ? `A tarefa **${task.title}** foi aprovada por <@${leaderUserId}> e já está disponível no taskboard.`
                            : `A tarefa **${task.title}** foi rejeitada por <@${leaderUserId}>.\nSe tiver dúvidas, entre em contato com um líder.`
                    )
                    .setTimestamp(),
            ],
        }).catch(() => { });
    } catch (err) {
        console.error('Erro ao notificar criador:', err);
    }
}