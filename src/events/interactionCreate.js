import { getDb } from '../utils/firebase.js';
import { isLeader, CATEGORIES, PRIORITY, PENDING_SELECTION_TTL, MAX_TASKS_PER_USER } from '../utils/constants.js';
import { refreshSingleTask, createTaskThread, postToThread, removeFromThread } from '../utils/taskboard.js';
import { sendToApproval, removeFromApproval, notifyCreator } from '../utils/approval.js';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';

export const name = 'interactionCreate';

// pendingSelections: userId -> { category, priority, expiresAt }
const pendingSelections = new Map();

/** Limpa seleções expiradas */
function cleanExpired() {
    const now = Date.now();
    for (const [userId, sel] of pendingSelections.entries()) {
        if (sel.expiresAt < now) pendingSelections.delete(userId);
    }
}

export async function execute(interaction) {

    // ── Slash commands ────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand()) {
        const cmd = interaction.client.commands.get(interaction.commandName);
        if (!cmd) return;
        try {
            await cmd.execute(interaction);
        } catch (err) {
            console.error(err);
            const msg = { content: '❌ Ocorreu um erro ao executar o comando.', flags: 64 };
            interaction.replied ? interaction.followUp(msg) : interaction.reply(msg);
        }
        return;
    }

    // ── Select menus — Step 1 ─────────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
        cleanExpired();
        const userId = interaction.user.id;

        if (!pendingSelections.has(userId)) {
            pendingSelections.set(userId, { expiresAt: Date.now() + PENDING_SELECTION_TTL });
        }
        const sel = pendingSelections.get(userId);

        if (interaction.customId === 'select_task_category') sel.category = interaction.values[0];
        if (interaction.customId === 'select_task_priority') sel.priority = interaction.values[0];
        sel.expiresAt = Date.now() + PENDING_SELECTION_TTL; // renova ao interagir

        if (sel.category && sel.priority) {
            const catInfo = CATEGORIES[sel.category] ?? { label: sel.category };
            const priInfo = PRIORITY[sel.priority] ?? { label: sel.priority };

            const continueBtn = new ButtonBuilder();
            continueBtn.setCustomId('btn_open_task_modal');
            continueBtn.setLabel('Continuar — Preencher detalhes');
            continueBtn.setStyle(ButtonStyle.Primary);
            continueBtn.setEmoji('📝');

            const embed = new EmbedBuilder()
                .setTitle('📋  Nova Tarefa — Passo 1 concluído!')
                .setColor(0x2ecc71)
                .setDescription('Tudo certo! Clique em **Continuar** para preencher o título e a descrição da tarefa.')
                .addFields(
                    { name: '📦  Categoria', value: catInfo.label, inline: true },
                    { name: '⚡  Prioridade', value: priInfo.label, inline: true },
                );

            return interaction.update({
                embeds: [embed],
                components: [new ActionRowBuilder().addComponents(continueBtn)],
            });
        }

        return interaction.update({});
    }

    // ── Botão: abrir modal (Step 2) ───────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'btn_open_task_modal') {
        cleanExpired();
        const sel = pendingSelections.get(interaction.user.id);
        if (!sel?.category || !sel?.priority || sel.expiresAt < Date.now()) {
            return interaction.reply({
                content: '⏱️ Sua seleção expirou (5 min). Use `/task criar` para começar novamente.',
                flags: 64,
            });
        }

        const titleInput = new TextInputBuilder();
        titleInput.setCustomId('task_title');
        titleInput.setLabel('Título da tarefa');
        titleInput.setStyle(TextInputStyle.Short);
        titleInput.setPlaceholder('Ex: Transportar caixas de munição para T12');
        titleInput.setRequired(true);
        titleInput.setMaxLength(80);

        const descInput = new TextInputBuilder();
        descInput.setCustomId('task_description');
        descInput.setLabel('Descrição detalhada (opcional)');
        descInput.setStyle(TextInputStyle.Paragraph);
        descInput.setPlaceholder('Descreva a quantidade, localização, urgência e qualquer detalhe relevante...');
        descInput.setRequired(false);
        descInput.setMaxLength(500);

        const modal = new ModalBuilder();
        modal.setCustomId('modal_create_task');
        modal.setTitle('Nova Tarefa — Detalhes');
        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descInput),
        );

        await interaction.showModal(modal);
        await interaction.deleteReply().catch(() => { });
        return;
    }

    // ── Modal submit: salvar tarefa ───────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'modal_create_task') {
        await interaction.deferReply({ flags: 64 });

        cleanExpired();
        const sel = pendingSelections.get(interaction.user.id);
        if (!sel?.category || !sel?.priority || sel.expiresAt < Date.now()) {
            return interaction.editReply('⏱️ Sua seleção expirou. Use `/task criar` para começar novamente.');
        }

        const title = interaction.fields.getTextInputValue('task_title').trim();
        const desc = interaction.fields.getTextInputValue('task_description').trim();

        const db = getDb();

        // Verifica se já existe uma tarefa "open" ou "approved" igual (duplicata)
        const dupSnap = await db.collection('tasks')
            .where('createdBy', '==', interaction.user.id)
            .where('status', 'in', ['open', 'approved'])
            .get().catch(() => null);

        if (dupSnap && !dupSnap.empty) {
            const dup = dupSnap.docs.find(d => d.data().title.toLowerCase() === title.toLowerCase());
            if (dup) {
                return interaction.editReply('⚠️ Você já tem uma tarefa com este título aguardando aprovação.');
            }
        }

        let ref;
        try {
            ref = await db.collection('tasks').add({
                title,
                description: desc || null,
                category: sel.category,
                priority: sel.priority,
                status: 'open',
                createdBy: interaction.user.id,
                createdAt: new Date(),
                takenBy: null,
                discordMessageId: null,
                discordThreadId: null,
            });
        } catch (err) {
            console.error('Erro ao criar tarefa:', err);
            return interaction.editReply('❌ Erro ao salvar a tarefa. Tente novamente em instantes.');
        }

        pendingSelections.delete(interaction.user.id);

        const task = {
            id: ref.id, title,
            description: desc || null,
            category: sel.category,
            priority: sel.priority,
            createdBy: interaction.user.id,
        };

        await sendToApproval(interaction.client, task);

        return interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(0x2ecc71)
                    .setTitle('✅  Tarefa enviada com sucesso!')
                    .setDescription('Sua requisição foi encaminhada para os líderes do regimento.\nVocê será notificado quando for aprovada e aparecer no taskboard.')
                    .addFields({ name: '📋  Tarefa', value: title, inline: false })
                    .setTimestamp(),
            ],
        });
    }

    // ── Botões das tarefas ────────────────────────────────────────────────────
    if (interaction.isButton()) {
        const parts = interaction.customId.split('_');
        if (parts[0] !== 'task') return;

        const action = parts[1];
        const taskId = parts.slice(2).join('_');

        const db = getDb();
        const ref = db.collection('tasks').doc(taskId);

        let doc;
        try {
            doc = await ref.get();
        } catch (err) {
            console.error('Erro ao buscar tarefa:', err);
            return interaction.reply({ content: '❌ Erro ao acessar o banco de dados. Tente novamente.', flags: 64 });
        }

        if (!doc.exists) {
            return interaction.reply({ content: '❌ Tarefa não encontrada ou já removida.', flags: 64 });
        }

        const task = doc.data();

        // ── Aprovar / Rejeitar ────────────────────────────────────────────────
        if (action === 'approve' || action === 'reject') {
            if (!isLeader(interaction.member)) {
                return interaction.reply({
                    content: '🔒 Apenas líderes do regimento podem aprovar ou rejeitar tarefas.',
                    flags: 64,
                });
            }

            if (action === 'approve') {
                await ref.update({ status: 'approved', approvedBy: interaction.user.id, approvedAt: new Date() });
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('✅  Tarefa aprovada!')
                            .setDescription(`A tarefa **${task.title}** foi aprovada e já está disponível no taskboard.`)
                            .setTimestamp(),
                    ],
                    flags: 64,
                });
                await removeFromApproval(interaction.client, taskId);
                await refreshSingleTask(interaction.client, taskId);
            } else {
                await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setTitle('🔴  Tarefa rejeitada')
                            .setDescription(`A tarefa **${task.title}** foi rejeitada e removida da fila de aprovação.`)
                            .setTimestamp(),
                    ],
                    flags: 64,
                });
                await removeFromApproval(interaction.client, taskId);
            }

            return;
        }

        // ── Assumir tarefa ────────────────────────────────────────────────────
        if (action === 'take') {
            if (task.status !== 'approved') {
                return interaction.reply({ content: '❌ Esta tarefa não está mais disponível.', flags: 64 });
            }

            // Verifica limite de tarefas simultâneas
            const activeSnap = await db.collection('tasks')
                .where('takenBy', '==', interaction.user.id)
                .where('status', '==', 'taken')
                .get().catch(() => null);

            if (activeSnap && activeSnap.size >= MAX_TASKS_PER_USER) {
                return interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setTitle('⚠️  Limite de tarefas atingido')
                            .setDescription(`Você já tem **${activeSnap.size}** tarefa(s) em andamento.\nConclua uma antes de assumir outra. (Limite: ${MAX_TASKS_PER_USER})`)
                            .setTimestamp(),
                    ],
                    flags: 64,
                });
            }

            await ref.update({ status: 'taken', takenBy: interaction.user.id, takenAt: new Date() });
            await interaction.reply({
                embeds: [
                    new EmbedBuilder()
                        .setColor(0x3498db)
                        .setTitle('🪖  Tarefa assumida!')
                        .setDescription(`Você assumiu a tarefa **${task.title}**.\nUm tópico foi criado para acompanhamento — use-o para atualizações e coordenação com o regimento.`)
                        .setTimestamp(),
                ],
                flags: 64,
            });
            await refreshSingleTask(interaction.client, taskId);
            await createTaskThread(interaction.client, taskId, interaction.user.id);
            return;
        }

        // ── Concluir tarefa ───────────────────────────────────────────────────
        if (action === 'done') {
            if (task.status !== 'taken') {
                return interaction.reply({ content: '❌ Esta tarefa não está em andamento.', flags: 64 });
            }
            if (task.takenBy !== interaction.user.id && !isLeader(interaction.member)) {
                return interaction.reply({
                    content: '🔒 Apenas o responsável pela tarefa ou um líder pode concluí-la.',
                    flags: 64,
                });
            }

            try {
                await ref.update({ status: 'done', doneBy: interaction.user.id, doneAt: new Date() });
            } catch (err) {
                console.error('Erro ao concluir tarefa:', err);
                return interaction.reply({ content: '❌ Erro ao atualizar a tarefa. Tente novamente.', flags: 64 });
            }

            // Remove o responsável do tópico
            await removeFromThread(interaction.client, taskId, task.takenBy);

            if (interaction.channel?.isThread?.()) {
                const disabledBtn = new ButtonBuilder();
                disabledBtn.setCustomId(`task_done_${taskId}`);
                disabledBtn.setLabel('Concluída!');
                disabledBtn.setStyle(ButtonStyle.Success);
                disabledBtn.setEmoji('✅');
                disabledBtn.setDisabled(true);

                await interaction.update({ components: [new ActionRowBuilder().addComponents(disabledBtn)] });
                await interaction.followUp({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('🎖️  Missão cumprida!')
                            .setDescription(`<@${interaction.user.id}> concluiu esta tarefa. Excelente trabalho, soldado!`)
                            .setTimestamp(),
                    ],
                });
            } else {
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('🎖️  Missão cumprida!')
                            .setDescription(`A tarefa **${task.title}** foi concluída por <@${interaction.user.id}>. Excelente trabalho!`)
                            .setTimestamp(),
                    ],
                    flags: 64,
                });
                await postToThread(interaction.client, taskId,
                    `🎖️  **Missão cumprida!** <@${interaction.user.id}> concluiu esta tarefa. Obrigado pelo serviço, soldado!`
                );
            }

            await refreshSingleTask(interaction.client, taskId);
            return;
        }
    }
}
