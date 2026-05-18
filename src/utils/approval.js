import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { CATEGORIES, PRIORITY } from './constants.js';

const approvalCache = new Map();

/** Envia uma tarefa nova para o canal de aprovação dos líderes */
export async function sendToApproval(client, task) {
    const channelId = process.env.APPROVAL_CHANNEL_ID;
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return console.error('❌ Canal de aprovação não encontrado.');

    const catInfo = CATEGORIES[task.category] ?? { label: task.category, color: 0xffffff };
    const priInfo = PRIORITY[task.priority] ?? { label: task.priority };

    const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setAuthor({ name: '⏳  Nova tarefa aguardando aprovação' })
        .setTitle(task.title)
        .setDescription('Um membro enviou uma nova requisição para o regimento. Revise e tome uma decisão.')
        .addFields(
            { name: '📦  Categoria', value: catInfo.label, inline: true },
            { name: '⚡  Prioridade', value: priInfo.label, inline: true },
            { name: '👤  Solicitado por', value: `<@${task.createdBy}>`, inline: true },
            { name: '📝  Descrição', value: task.description || '_Sem descrição_', inline: false },
            ...(task.deadlineAt ? [{
                name: '⏳  Prazo',
                value: `<t:${Math.floor((task.deadlineAt instanceof Date ? task.deadlineAt : new Date(task.deadlineAt)).getTime() / 1000)}:R>`,
                inline: true,
            }] : []),
        )
        .setFooter({ text: `ID: ${task.id}  •  FELB Regiment` })
        .setTimestamp();

    const approveBtn = new ButtonBuilder();
    approveBtn.setCustomId(`task_approve_${task.id}`);
    approveBtn.setLabel('Aprovar');
    approveBtn.setStyle(ButtonStyle.Success);
    approveBtn.setEmoji('✅');

    const rejectBtn = new ButtonBuilder();
    rejectBtn.setCustomId(`task_reject_${task.id}`);
    rejectBtn.setLabel('Rejeitar');
    rejectBtn.setStyle(ButtonStyle.Danger);
    rejectBtn.setEmoji('⛔');

    const row = new ActionRowBuilder().addComponents(approveBtn, rejectBtn);

    if (task.imageUrl) embed.setImage(task.imageUrl);

    const sent = await channel.send({ embeds: [embed], components: [row] });
    approvalCache.set(task.id, sent.id);
}

/** Remove a mensagem de aprovação após a tarefa ser aprovada ou rejeitada */
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

    // Fallback: busca pelo footer quando o cache foi perdido (ex: bot reiniciou)
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return;

    const target = messages.find(m =>
        m.author.id === client.user.id &&
        m.embeds?.[0]?.footer?.text?.includes(`ID: ${taskId}`)
    );

    if (target) await target.delete().catch(() => { });
}