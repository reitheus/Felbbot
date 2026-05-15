import { getDb } from '../utils/firebase.js';
import { isLeader, CATEGORIES, PRIORITY, PENDING_SELECTION_TTL, MAX_TASKS_PER_USER } from '../utils/constants.js';
import { refreshSingleTask, createTaskThread, postToThread, removeFromThread } from '../utils/taskboard.js';
import { sendToApproval, removeFromApproval} from '../utils/approval.js';
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
        sel.expiresAt = Date.now() + PENDING_SELECTION_TTL;

        // Reconstrói os menus sempre mostrando a opção selecionada
        const { StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = await import('discord.js');

        const categorySelect = new StringSelectMenuBuilder();
        categorySelect.setCustomId('select_task_category');
        categorySelect.setPlaceholder(sel.category ? CATEGORIES[sel.category]?.label ?? sel.category : 'Selecione a categoria...');
        categorySelect.addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🚛 Logística').setDescription('Transporte e suprimentos').setValue('logistics').setDefault(sel.category === 'logistics'),
            new StringSelectMenuOptionBuilder().setLabel('🏭 Produção').setDescription('Fábricas e munição').setValue('production').setDefault(sel.category === 'production'),
            new StringSelectMenuOptionBuilder().setLabel('🔍 Reconhecimento').setDescription('Scouting e mapeamento de inimigos').setValue('recon').setDefault(sel.category === 'recon'),
            new StringSelectMenuOptionBuilder().setLabel('📋 Fila de Fábrica').setDescription('Gerenciar filas e prioridades de produção').setValue('queue').setDefault(sel.category === 'queue'),
            new StringSelectMenuOptionBuilder().setLabel('⛏️ Coleta').setDescription('Coletar recursos e materiais brutos').setValue('gathering').setDefault(sel.category === 'gathering'),
        );

        const prioritySelect = new StringSelectMenuBuilder();
        prioritySelect.setCustomId('select_task_priority');
        prioritySelect.setPlaceholder(sel.priority ? PRIORITY[sel.priority]?.label ?? sel.priority : 'Selecione a prioridade...');
        prioritySelect.addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🟢 Baixa').setDescription('Pode ser feito quando possível').setValue('low').setDefault(sel.priority === 'low'),
            new StringSelectMenuOptionBuilder().setLabel('🟡 Média').setDescription('Importante mas não urgente').setValue('medium').setDefault(sel.priority === 'medium'),
            new StringSelectMenuOptionBuilder().setLabel('🔴 Alta').setDescription('Urgente, precisa de atenção imediata').setValue('high').setDefault(sel.priority === 'high'),
        );

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
                components: [
                    new ActionRowBuilder().addComponents(categorySelect),
                    new ActionRowBuilder().addComponents(prioritySelect),
                    new ActionRowBuilder().addComponents(continueBtn),
                ],
            });
        }

        // Ainda falta selecionar um dos dois — atualiza os menus mostrando o que já foi escolhido
        const embed = new EmbedBuilder()
            .setTitle('📋  Nova Tarefa — Passo 1 de 2')
            .setDescription('Selecione a **categoria** e a **prioridade** da tarefa abaixo.Depois clique em continuar para preencher os detalhes.')
                .setColor(0xe67e22)
                .setFooter({ text: 'Sua seleção expira em 5 minutos.' });

        return interaction.update({
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(categorySelect),
                new ActionRowBuilder().addComponents(prioritySelect),
            ],
        });
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
        titleInput.setRequired(true);
        titleInput.setMaxLength(80);

        const deadlineInput = new TextInputBuilder();
        deadlineInput.setCustomId('task_deadline');
        deadlineInput.setLabel('Prazo (opcional) — ex: 2h, 30min, 1d');
        deadlineInput.setStyle(TextInputStyle.Short);
        deadlineInput.setPlaceholder('Ex: 2h  /  90min  /  1d  (deixe vazio para sem prazo)');
        deadlineInput.setRequired(false);
        deadlineInput.setMaxLength(10);

        const modal = new ModalBuilder();
        modal.setCustomId('modal_create_task');

        if (sel.category === 'logistics') {
            titleInput.setPlaceholder('Ex: Transportar munição para T12');

            const cargoInput = new TextInputBuilder();
            cargoInput.setCustomId('task_field1');
            cargoInput.setLabel('Carga (quantidade e tipo)');
            cargoInput.setStyle(TextInputStyle.Short);
            cargoInput.setPlaceholder('Ex: 5 caixas de Soldier Supplies');
            cargoInput.setRequired(true);
            cargoInput.setMaxLength(100);

            const routeInput = new TextInputBuilder();
            routeInput.setCustomId('task_field2');
            routeInput.setLabel('Origem → Destino');
            routeInput.setStyle(TextInputStyle.Short);
            routeInput.setPlaceholder('Ex: Depósito Stonecradle → Forward Base T12');
            routeInput.setRequired(true);
            routeInput.setMaxLength(150);

            const obsInput = new TextInputBuilder();
            obsInput.setCustomId('task_field3');
            obsInput.setLabel('Observações (opcional)');
            obsInput.setStyle(TextInputStyle.Paragraph);
            obsInput.setPlaceholder('Rota preferida, perigos no caminho, veículo necessário...');
            obsInput.setRequired(false);
            obsInput.setMaxLength(300);

            modal.setTitle('🚛  Logística — Detalhes');
            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(cargoInput),
                new ActionRowBuilder().addComponents(routeInput),
                new ActionRowBuilder().addComponents(obsInput),
                new ActionRowBuilder().addComponents(deadlineInput),
            );

        } else if (sel.category === 'production') {
            titleInput.setPlaceholder('Ex: Produzir granadas Tremola');

            const itemInput = new TextInputBuilder();
            itemInput.setCustomId('task_field1');
            itemInput.setLabel('Item e quantidade');
            itemInput.setStyle(TextInputStyle.Short);
            itemInput.setPlaceholder('Ex: 200x Tremola Grenade');
            itemInput.setRequired(true);
            itemInput.setMaxLength(100);

            const factoryInput = new TextInputBuilder();
            factoryInput.setCustomId('task_field2');
            factoryInput.setLabel('Fábrica / Local de produção');
            factoryInput.setStyle(TextInputStyle.Short);
            factoryInput.setPlaceholder('Ex: Factory Town — Small Arms Factory');
            factoryInput.setRequired(true);
            factoryInput.setMaxLength(150);

            const obsInput = new TextInputBuilder();
            obsInput.setCustomId('task_field3');
            obsInput.setLabel('Observações (opcional)');
            obsInput.setStyle(TextInputStyle.Paragraph);
            obsInput.setPlaceholder('Materiais disponíveis, prioridade de entrega, destino...');
            obsInput.setRequired(false);
            obsInput.setMaxLength(300);

            modal.setTitle('🏭  Produção — Detalhes');
            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(itemInput),
                new ActionRowBuilder().addComponents(factoryInput),
                new ActionRowBuilder().addComponents(obsInput),
                new ActionRowBuilder().addComponents(deadlineInput),
            );

        } else if (sel.category === 'recon') {
            titleInput.setPlaceholder('Ex: Mapear movimentação inimiga em Callahan\'s Belt');

      const areaInput = new TextInputBuilder();
            areaInput.setCustomId('task_field1');
            areaInput.setLabel('Área / Região alvo');
            areaInput.setStyle(TextInputStyle.Short);
            areaInput.setPlaceholder('Ex: Callahan\'s Belt — setor norte');
      areaInput.setRequired(true);
            areaInput.setMaxLength(150);

            const objectiveInput = new TextInputBuilder();
            objectiveInput.setCustomId('task_field2');
            objectiveInput.setLabel('Objetivo do reconhecimento');
            objectiveInput.setStyle(TextInputStyle.Short);
            objectiveInput.setPlaceholder('Ex: Localizar posições de artilharia inimiga');
            objectiveInput.setRequired(true);
            objectiveInput.setMaxLength(200);

            const obsInputR = new TextInputBuilder();
            obsInputR.setCustomId('task_field3');
            obsInputR.setLabel('Observações (opcional)');
            obsInputR.setStyle(TextInputStyle.Paragraph);
            obsInputR.setPlaceholder('Última info conhecida, nível de risco, equipamento necessário...');
            obsInputR.setRequired(false);
            obsInputR.setMaxLength(300);

            modal.setTitle('🔍  Reconhecimento — Detalhes');
            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(areaInput),
                new ActionRowBuilder().addComponents(objectiveInput),
                new ActionRowBuilder().addComponents(obsInputR),
                new ActionRowBuilder().addComponents(deadlineInput),
            );

        } else if (sel.category === 'queue') {
            titleInput.setPlaceholder('Ex: Colocar filas na Forge');

            const factoryQInput = new TextInputBuilder();
            factoryQInput.setCustomId('task_field1');
            factoryQInput.setLabel('Fábrica / Local');
            factoryQInput.setStyle(TextInputStyle.Short);
            factoryQInput.setPlaceholder('Ex: Forge / Campo de Sucata');
            factoryQInput.setRequired(true);
            factoryQInput.setMaxLength(150);

            const queueItemsInput = new TextInputBuilder();
            queueItemsInput.setCustomId('task_field2');
            queueItemsInput.setLabel('Filas:');
            queueItemsInput.setStyle(TextInputStyle.Paragraph);
            queueItemsInput.setPlaceholder('3x Filas de Assembly 1\n2x Filas de Msup\n3. ...');
      queueItemsInput.setRequired(true);
            queueItemsInput.setMaxLength(400);

            const obsInputQ = new TextInputBuilder();
            obsInputQ.setCustomId('task_field3');
            obsInputQ.setLabel('Observações (opcional)');
            obsInputQ.setStyle(TextInputStyle.Short);
            obsInputQ.setPlaceholder('Materiais já disponíveis, restrições, destino da produção...');
            obsInputQ.setRequired(false);
            obsInputQ.setMaxLength(200);

            modal.setTitle('📋  Fila de Fábrica — Detalhes');
            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(factoryQInput),
                new ActionRowBuilder().addComponents(queueItemsInput),
                new ActionRowBuilder().addComponents(obsInputQ),
                new ActionRowBuilder().addComponents(deadlineInput),
            );

        } else if (sel.category === 'gathering') {
            titleInput.setPlaceholder('Ex: Coletar Sulfur Coal em Weathered Expanse');

            const resourceInput = new TextInputBuilder();
            resourceInput.setCustomId('task_field1');
            resourceInput.setLabel('Recurso e quantidade');
            resourceInput.setStyle(TextInputStyle.Short);
            resourceInput.setPlaceholder('Ex: 500x Sulfur Coal');
            resourceInput.setRequired(true);
            resourceInput.setMaxLength(100);

            const locationInput = new TextInputBuilder();
            locationInput.setCustomId('task_field2');
            locationInput.setLabel('Local de Deposito');
            locationInput.setStyle(TextInputStyle.Short);
            locationInput.setPlaceholder('Ex: Weathered Expanse — campo norte');
            locationInput.setRequired(true);
            locationInput.setMaxLength(150);

            const obsInputG = new TextInputBuilder();
            obsInputG.setCustomId('task_field3');
            obsInputG.setLabel('Observações (opcional)');
            obsInputG.setStyle(TextInputStyle.Paragraph);
            obsInputG.setPlaceholder('Levar para a facility principal, Transformar em HEMat,...');
            obsInputG.setRequired(false);
            obsInputG.setMaxLength(300);

            modal.setTitle('⛏️  Coleta — Detalhes');
            modal.addComponents(
                new ActionRowBuilder().addComponents(titleInput),
                new ActionRowBuilder().addComponents(resourceInput),
                new ActionRowBuilder().addComponents(locationInput),
                new ActionRowBuilder().addComponents(obsInputG),
                new ActionRowBuilder().addComponents(deadlineInput),
            );
        }

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
        const deadlineRaw = interaction.fields.getTextInputValue('task_deadline').trim();

        // Lê campos específicos por categoria e monta descrição estruturada
        const field1 = interaction.fields.getTextInputValue('task_field1').trim();
        const field2 = interaction.fields.getTextInputValue('task_field2').trim();
        const field3 = interaction.fields.getTextInputValue('task_field3').trim();

        let desc = '';
        if (sel.category === 'logistics') {
            desc = `**📦 Carga:** ${field1}\n**🗺️ Rota:** ${field2}`;
            if (field3) desc += `\n**📝 Obs:** ${field3}`;
        } else if (sel.category === 'production') {
            desc = `**🔧 Item:** ${field1}\n**🏭 Fábrica:** ${field2}`;
            if (field3) desc += `\n**📝 Obs:** ${field3}`;
        } else if (sel.category === 'recon') {
            desc = `**📍 Área:** ${field1}\n**🎯 Objetivo:** ${field2}`;
            if (field3) desc += `\n**📝 Obs:** ${field3}`;
        } else if (sel.category === 'queue') {
            desc = `**🏭 Fábrica:** ${field1}\n**📋 Fila:**\n${field2}`;
            if (field3) desc += `\n**📝 Obs:** ${field3}`;
        } else if (sel.category === 'gathering') {
            desc = `**⛏️ Recurso:** ${field1}\n**📍 Local:** ${field2}`;
            if (field3) desc += `\n**📝 Obs:** ${field3}`;
        }

        // Converte prazo para timestamp Unix
        let deadlineAt = null;
        if (deadlineRaw) {
            const match = deadlineRaw.match(/^(\d+)\s*(min|h|d)$/i);
            if (!match) {
                return interaction.editReply('⚠️ Formato de prazo inválido. Use: `2h`, `90min` ou `1d`.');
            }
            const value = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            const ms = unit === 'min' ? value * 60_000
                : unit === 'h' ? value * 3_600_000
                    : value * 86_400_000;
            deadlineAt = new Date(Date.now() + ms);
        }

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
                deadlineAt: deadlineAt,
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
                            .setDescription(`A tarefa **${task.title}** foi aprovada e já está disponível no taskboard. Task ID: \'${taskId}\'`)
                            .setTimestamp(),
                    ],
                });
                await removeFromApproval(interaction.client, taskId);
                await refreshSingleTask(interaction.client, taskId);

            } else {
                await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xe74c3c)
                            .setTitle('⛔  Tarefa rejeitada')
                            .setDescription(`A tarefa **${task.title}** foi rejeitada e removida da fila de aprovação. Task ID: \'${taskId}\'`)
                            .setTimestamp(),
                    ],
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
                            .setDescription(`<@${interaction.user.id}> concluiu esta tarefa. Excelente trabalho!`)
                            .setTimestamp(),
                    ],
                });
            } else {
                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0x2ecc71)
                            .setTitle('🎖️  Missão cumprida!')
                            .setDescription(`A tarefa **${task.title}** foi concluída por <@${interaction.user.id}>. Excelente trabalho, Callahan Agradece!`)
                            .setTimestamp(),
                    ],
                    flags: 64,
                });
                await postToThread(interaction.client, taskId,
                    `🎖️  **Missão cumprida!** <@${interaction.user.id}> concluiu esta tarefa. Obrigado pelo serviço!`
                );
            }

            await refreshSingleTask(interaction.client, taskId);
            return;
        }
    }
}