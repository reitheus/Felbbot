import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextDisplayBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js';
import { removeFromApproval, sendToApproval, notifyCreator } from '../utils/approval.js';
import { CATEGORIES, isLeader, MAX_TASKS_PER_USER, PENDING_SELECTION_TTL, PRIORITY } from '../utils/constants.js';
import { getDb } from '../utils/firebase.js';
import { createTaskThread, postToThread, refreshSingleTask, removeFromThread } from '../utils/taskboard.js';

export const name = 'interactionCreate';

const pendingSelections = new Map();

function cleanExpired() {
    const now = Date.now();
    for (const [userId, sel] of pendingSelections.entries()) {
        if (sel.expiresAt < now) pendingSelections.delete(userId);
    }
}

/** Monta o container de seleção de categoria/prioridade */
function buildSelectionContainer(sel = {}) {
    const catInfo = sel.category ? CATEGORIES[sel.category] : null;
    const priInfo = sel.priority ? PRIORITY[sel.priority] : null;
    const canContinue = !!(sel.category && sel.priority);

    const categorySelect = new StringSelectMenuBuilder()
        .setCustomId('select_task_category')
        .setPlaceholder(catInfo ? catInfo.label : 'Selecione a categoria...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🚛 Logística').setDescription('Transporte e suprimentos').setValue('logistics').setDefault(sel.category === 'logistics'),
            new StringSelectMenuOptionBuilder().setLabel('🏭 Produção').setDescription('Fábricas e munição').setValue('production').setDefault(sel.category === 'production'),
            new StringSelectMenuOptionBuilder().setLabel('🔍 Reconhecimento').setDescription('Scouting e mapeamento de inimigos').setValue('recon').setDefault(sel.category === 'recon'),
            new StringSelectMenuOptionBuilder().setLabel('📋 Fila de Fábrica').setDescription('Gerenciar filas e prioridades de produção').setValue('queue').setDefault(sel.category === 'queue'),
            new StringSelectMenuOptionBuilder().setLabel('⛏️ Coleta').setDescription('Coletar recursos e materiais brutos').setValue('gathering').setDefault(sel.category === 'gathering'),
        );

    const prioritySelect = new StringSelectMenuBuilder()
        .setCustomId('select_task_priority')
        .setPlaceholder(priInfo ? priInfo.label : 'Selecione a prioridade...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🟢 Baixa').setDescription('Pode ser feito quando possível').setValue('low').setDefault(sel.priority === 'low'),
            new StringSelectMenuOptionBuilder().setLabel('🟡 Média').setDescription('Importante mas não urgente').setValue('medium').setDefault(sel.priority === 'medium'),
            new StringSelectMenuOptionBuilder().setLabel('🔴 Alta').setDescription('Urgente, precisa de atenção imediata').setValue('high').setDefault(sel.priority === 'high'),
        );

    const statusLines = [
        catInfo ? `✅  **Categoria:** ${catInfo.label}` : `⬜  **Categoria:** _não selecionada_`,
        priInfo ? `✅  **Prioridade:** ${priInfo.label}` : `⬜  **Prioridade:** _não selecionada_`,
    ].join('\n');

    const container = new ContainerBuilder()
        .setAccentColor(canContinue ? 0x2ecc71 : 0xe67e22)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent('## 📋  Nova Tarefa'),
            new TextDisplayBuilder().setContent(
                canContinue
                    ? 'Tudo selecionado! Clique em **Continuar** para preencher os detalhes.'
                    : 'Selecione a **categoria** e a **prioridade** abaixo.\n-# Sua seleção expira em 5 minutos.'
            ),
        )
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLines))
        .addActionRowComponents(new ActionRowBuilder().addComponents(categorySelect))
        .addActionRowComponents(new ActionRowBuilder().addComponents(prioritySelect));

    if (canContinue) {
        const continueBtn = new ButtonBuilder()
            .setCustomId('btn_open_task_modal')
            .setLabel('Continuar — Preencher detalhes')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('📝');
        container.addActionRowComponents(new ActionRowBuilder().addComponents(continueBtn));
    }

    return [container];
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
            const msg = { content: '❌ Ocorreu um erro ao executar o comando.', flags: MessageFlags.Ephemeral };
            interaction.replied ? interaction.followUp(msg) : interaction.reply(msg);
        }
        return;
    }

    // ── Select menus ──────────────────────────────────────────────────────────
    if (interaction.isStringSelectMenu() && ['select_task_category', 'select_task_priority'].includes(interaction.customId)) {
        cleanExpired();
        const userId = interaction.user.id;

        if (!pendingSelections.has(userId)) {
            pendingSelections.set(userId, { expiresAt: Date.now() + PENDING_SELECTION_TTL });
        }
        const sel = pendingSelections.get(userId);

        if (interaction.customId === 'select_task_category') sel.category = interaction.values[0];
        if (interaction.customId === 'select_task_priority') sel.priority = interaction.values[0];
        sel.expiresAt = Date.now() + PENDING_SELECTION_TTL;

        return interaction.update({
            flags: MessageFlags.IsComponentsV2,
            components: buildSelectionContainer(sel),
        });
    }

    // ── Botão: abrir modal ────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'btn_open_task_modal') {
        cleanExpired();
        const sel = pendingSelections.get(interaction.user.id);

        if (!sel?.category || !sel?.priority || sel.expiresAt < Date.now()) {
            return interaction.reply({
                content: '⏱️ Seleção expirada. Use `/task criar` novamente.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const catInfo = CATEGORIES[sel.category] ?? { label: sel.category };
        const needsFactory = sel.category === 'production' || sel.category === 'queue';

        const titleInput = new TextInputBuilder()
            .setCustomId('task_title')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Título da tarefa...')
            .setRequired(true)
            .setMaxLength(80);

        const titleLabel = new LabelBuilder()
            .setLabel('Título da tarefa')
            .setTextInputComponent(titleInput);

        const descQuant = new TextInputBuilder()
            .setCustomId('task_quantity')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 100 tanques, 50 soldados, 2000 unidades...')
            .setRequired(true)
            .setMaxLength(200);

        const descQuantLabel = new LabelBuilder()
            .setLabel('Quantidade / Tipo')
            .setTextInputComponent(descQuant);

        const descInput = new TextInputBuilder()
            .setCustomId('task_description')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Quantidade, localização, rota, observações...')
            .setRequired(false)
            .setMaxLength(500);

        const descLabel = new LabelBuilder()
            .setLabel('Detalhes adicionais (opcional)')
            .setTextInputComponent(descInput);

        const deadlineInput = new TextInputBuilder()
            .setCustomId('task_deadline')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 2h / 30min / 1d  (vazio = sem prazo)')
            .setRequired(false)
            .setMaxLength(10);

        const deadlineLabel = new LabelBuilder()
            .setLabel('Prazo (opcional)')
            .setDescription('Formatos aceitos: 30min, 2h, 1d')
            .setTextInputComponent(deadlineInput);

        const descLocal = new TextInputBuilder()
            .setCustomId('task_location')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: Clanshead Valley -> Marban Hollow')
            .setRequired(true)
            .setMaxLength(100);

        const descLocalLabel = new LabelBuilder()
            .setLabel('Localização/Destino')
            .setTextInputComponent(descLocal);

        const modal = new ModalBuilder()
            .setCustomId('modal_create_task')
            .setTitle(`${catInfo.label} — Detalhes`);

        if (needsFactory && sel.category === 'production') {
            const factorySelect = new StringSelectMenuBuilder()
                .setCustomId('task_factory')
                .setPlaceholder('Selecione a fábrica...')
                .setRequired(true)
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('🏗️ Facility').setValue('facility'),
                    new StringSelectMenuOptionBuilder().setLabel('⚗️ Refinery').setValue('refinery'),
                    new StringSelectMenuOptionBuilder().setLabel('🏭 Mass Production Factory').setValue('mpp'),
                );

            const factoryLabel = new LabelBuilder()
                .setLabel('Fábrica')
                .setStringSelectMenuComponent(factorySelect);
            modal.addComponents(titleLabel, descLocalLabel, factoryLabel, descQuantLabel, descLabel, deadlineLabel);

        } else if (needsFactory && sel.category === 'queue') {
            const factorySelect = new StringSelectMenuBuilder()
                .setCustomId('task_factory')
                .setPlaceholder('Selecione a fábrica...')
                .setRequired(true)
                .addOptions(
                    new StringSelectMenuOptionBuilder({
                        label: 'MetalWorks Factory',
                        emoji: '1407059365080600848',
                        value: 'metalwork',
                    }),
                    new StringSelectMenuOptionBuilder({
                        label: 'Materials Factory',
                        emoji: '🏭',
                        vaule: 'materials',
                    }),
                    new StringSelectMenuOptionBuilder({
                        label: 'Refinaria de Óleo',
                        emoji: '1407059367630602341',
                        value: 'oil_refinery',
                    }),
                    new StringSelectMenuOptionBuilder({
                        label: 'Refinaria de Carvão',
                        emoji: '1407027297567117343',
                        vaule: 'coal_refinery',
                    }),
                    new StringSelectMenuOptionBuilder({
                        label: 'Fábrica de Munição',
                        emoji: '1407059355685224458',
                        vaule: 'ammo_factory',
                    })

                );

            const factoryLabel = new LabelBuilder()
                .setLabel('Fábrica')
                .setStringSelectMenuComponent(factorySelect);

            if (factorySelect.options.value === 'metalwork') {
                const processSelect = new StringSelectMenuBuilder()
                    .setCustomId('task_process')
                    .setPlaceholder('Selecione o tipo...')
                    .setRequired(true)
                    .addOptions(
                        new StringSelectMenuOptionBuilder({
                            label: 'Recicladora',
                            vaule: 'recycler',
                        }),
                        new StringSelectMenuOptionBuilder({
                            label: "Fornalha Metalurgica",
                            vaule: 'blast_furnace',
                        }),
                        new StringSelectMenuOptionBuilder({
                            label: 'Estação de Engenharia',
                            vaule: 'engineering_station',
                        })
                    );
                const processLabel = new LabelBuilder()
                    .setLabel('Tipo de Fabrica')
                    .setStringSelectMenuComponent(processSelect);
                
                if(processSelect.options.value === 'recycler') {
                    const recycleInput = new StringSelectMenuBuilder()
                        .setCustomId('task_recycle_recipe')
                        .setplaceholder('Selecione a receita...')
                        .setRequired(true)
                        .addOptions(
                            new StringSelectMenuOptionBuilder({
                                label: 'Cano'
                                emoji: '1407044454614962328'
                                vaule: 'pipe',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Pcom',
                                emoji: '1407044459597926532',
                                vaule: 'pcom',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Componente Quebrado',
                                emoji: '1407027301421551648',
                                value: 'broken_component',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Pcom Vegano',
                                emoji: '1407044459597926532',
                                vaule: 'vegan_pcom',
                            })
                        );
                    modal.addComponents(titleLabel, descLocalLabel, processLabel, recycleInput, descQuantLabel, descLabel, deadlineLabel);
                }else if(processSelect.options.value === 'blast_furnace') {
                    const blastInput = new StringSelectMenuBuilder()
                        .setCustomId('task_blast_recipe')
                        .setplaceholder('Selecione a receita...')
                        .setRequired(true)
                        .addOptions(
                            new StringSelectMenuOptionBuilder({
                                label: 'Cano'
                                emoji: '1407044454614962328'
                                vaule: 'pipe',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Construção Processado - PCom',
                                emoji: '1407044459597926532',
                                vaule: 'pcom',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Montagem 3 - ASMat3'
                                emoji:'1407027260451590224',
                                vaule: 'asmat3',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Montagem 4 - ASMat4'
                                emoji:'1407027262452138054',
                                vaule: 'asmat4',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material Raro - Rare Materials(RM)'
                                emoji:'1407044473153654804',
                                vaule: 'raremat',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Liga Rara - Rare Alloy(RA)'
                                emoji:'1407044470729474088',
                                vaule: 'rarea',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Construção Processado x3 - PCom x3'
                                emoji:'1407044459597926532',
                                vaule: 'pcom3',
                            })
                        )
                    modal.addComponents(titleLabel, descLocalLabel, processLabel, blastInput, descQuantLabel, descLabel, deadlineLabel);
                }else if(processSelect.options.value === 'engineering_station') {
                    const engInput = new StringSelectMenuBuilder()
                        .setCustomId('task_eng_recipe')
                        .setplaceholder('Selecione a receita...')
                        .setRequired(true)
                        .addOptions(
                            new StringSelectMenuOptionBuilder({
                                label: 'Cano'
                                emoji: '1407044454614962328'
                                vaule: 'pipe',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Construção Processado - PCom',
                                emoji: '1407044459597926532',
                                vaule: 'pcom',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Construção de Aço - Steel'
                                emoji:'1407027178926768138',
                                vaule: 'steel',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Construção de Aço x3 - Steel x3'
                                emoji:'1407027178926768138',
                                vaule: 'steel3',
                            })
                            new StringSelectMenuOptionBuilder({
                                label: 'Material de Montagem 5 - ASMat5'
                                emoji:'1407027264482181271',
                                vaule: 'asmat5',
                            })
                        )
                    modal.addComponents(titleLabel, descLocalLabel, processLabel, engInput, descQuantLabel, descLabel, deadlineLabel);
                }
            }

        await interaction.showModal(modal);
        await interaction.deleteReply().catch(() => { });
        return;
    }

    // ── Modal submit ──────────────────────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId === 'modal_create_task') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        cleanExpired();
        const sel = pendingSelections.get(interaction.user.id);
        if (!sel?.category || !sel?.priority || sel.expiresAt < Date.now()) {
            return interaction.editReply('⏱️ Seleção expirada. Use `/task criar` novamente.');
        }

        const title = interaction.fields.getTextInputValue('task_title').trim();
        const extra = interaction.fields.getTextInputValue('task_description').trim();
        const deadlineRaw = interaction.fields.getTextInputValue('task_deadline').trim();

        // Lê fábrica se vier do modal
        let factory = null;
        try { factory = interaction.fields.getField('task_factory')?.value ?? null; } catch { factory = null; }

        // Monta descrição estruturada
        const facInfo = factory ? { facility: '🏗️ Facility', refinery: '⚗️ Refinery', mpp: '🏭 Mass Production Factory' }[factory] : null;
        let desc = '';
        if (sel.category === 'production' || sel.category === 'queue') {
            if (facInfo) desc = `**🏭 Fábrica:** ${facInfo}`;
            if (extra) desc += (desc ? '\n' : '') + `**📝 Detalhes:** ${extra}`;
        } else {
            desc = extra || '';
        }

        // Converte prazo
        let deadlineAt = null;
        if (deadlineRaw) {
            const match = deadlineRaw.match(/^(\d+)(min|h|d)$/i);
            if (!match) return interaction.editReply('⚠️ Formato de prazo inválido. Use: `2h`, `30min` ou `1d`.');
            const ms = { min: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()] * parseInt(match[1]);
            deadlineAt = new Date(Date.now() + ms);
        }

        const db = getDb();

        // Verifica duplicata
        const dupSnap = await db.collection('tasks')
            .where('createdBy', '==', interaction.user.id)
            .where('status', 'in', ['open', 'approved'])
            .get().catch(() => null);

        if (dupSnap && !dupSnap.empty) {
            const dup = dupSnap.docs.find(d => d.data().title.toLowerCase() === title.toLowerCase());
            if (dup) return interaction.editReply('⚠️ Você já tem uma tarefa com este título aguardando aprovação.');
        }

        let ref;
        try {
            ref = await db.collection('tasks').add({
                title,
                description: desc || null,
                category: sel.category,
                priority: sel.priority,
                factory: factory,
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
            return interaction.editReply('❌ Erro ao salvar a tarefa. Tente novamente.');
        }

        pendingSelections.delete(interaction.user.id);

        const task = { id: ref.id, title, description: desc || null, category: sel.category, priority: sel.priority, factory, deadlineAt, createdBy: interaction.user.id };
        await sendToApproval(interaction.client, task);

        const priInfo = PRIORITY[sel.priority] ?? { label: sel.priority };
        const catInfo = CATEGORIES[sel.category] ?? { label: sel.category };
        let dlText = deadlineAt ? `\n⏳ **Prazo:** ${deadlineRaw}` : '';
        let facText = facInfo ? `\n🏭 **Fábrica:** ${facInfo}` : '';

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0x2ecc71)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ✅  Tarefa enviada!'),
                        new TextDisplayBuilder().setContent(
                            `**${title}**\n${catInfo.label}  •  ${priInfo.label}${facText}${dlText}\n\n` +
                            `Sua requisição foi encaminhada para os líderes.\nVocê receberá uma DM quando for aprovada.`
                        ),
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`-# ID: ${ref.id}`),
                    ),
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
        try { doc = await ref.get(); }
        catch (err) {
            console.error('Erro ao buscar tarefa:', err);
            return interaction.reply({ content: '❌ Erro ao acessar o banco de dados.', flags: MessageFlags.Ephemeral });
        }

        if (!doc.exists) {
            return interaction.reply({ content: '❌ Tarefa não encontrada ou já removida.', flags: MessageFlags.Ephemeral });
        }

        const task = doc.data();

        // ── Aprovar / Rejeitar ────────────────────────────────────────────────
        if (action === 'approve' || action === 'reject') {
            if (!isLeader(interaction.member)) {
                return interaction.reply({
                    content: '🔒 Apenas líderes podem aprovar ou rejeitar tarefas.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            if (action === 'approve') {
                await ref.update({ status: 'approved', approvedBy: interaction.user.id, approvedAt: new Date() });
                await interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(0x2ecc71)
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## ✅  Tarefa aprovada!'),
                                new TextDisplayBuilder().setContent(`A tarefa **${task.title}** está disponível no taskboard.`),
                            ),
                    ],
                });
                await removeFromApproval(interaction.client, taskId);
                await refreshSingleTask(interaction.client, taskId);
                await notifyCreator(interaction.client, task, 'approved', interaction.user.id);
            } else {
                await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });
                await interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(0xe74c3c)
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## ⛔  Tarefa rejeitada'),
                                new TextDisplayBuilder().setContent(`A tarefa **${task.title}** foi removida da fila de aprovação.`),
                            ),
                    ],
                });
                await removeFromApproval(interaction.client, taskId);
                await notifyCreator(interaction.client, task, 'rejected', interaction.user.id);
            }
            return;
        }

        // ── Assumir tarefa ────────────────────────────────────────────────────
        if (action === 'take') {
            if (task.status !== 'approved') {
                return interaction.reply({ content: '❌ Esta tarefa não está mais disponível.', flags: MessageFlags.Ephemeral });
            }

            const activeSnap = await db.collection('tasks')
                .where('takenBy', '==', interaction.user.id)
                .where('status', '==', 'taken')
                .get().catch(() => null);

            if (activeSnap && activeSnap.size >= MAX_TASKS_PER_USER) {
                return interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(0xe74c3c)
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent('## ⚠️  Limite de tarefas atingido'),
                                new TextDisplayBuilder().setContent(
                                    `Você já tem **${activeSnap.size}** tarefa(s) em andamento.\n` +
                                    `Conclua uma antes de assumir outra. (Limite: ${MAX_TASKS_PER_USER})`
                                ),
                            ),
                    ],
                });
            }

            await ref.update({ status: 'taken', takenBy: interaction.user.id, takenAt: new Date() });
            await interaction.reply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [
                    new ContainerBuilder()
                        .setAccentColor(0x3498db)
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent('## 🪖  Tarefa assumida!'),
                            new TextDisplayBuilder().setContent(
                                `Você assumiu a tarefa **${task.title}**.\nUm tópico foi criado para acompanhamento.`
                            ),
                        ),
                ],
            });
            await refreshSingleTask(interaction.client, taskId);
            await createTaskThread(interaction.client, taskId, interaction.user.id);
            return;
        }

        // ── Concluir tarefa ───────────────────────────────────────────────────
        if (action === 'done') {
            if (task.status !== 'taken') {
                return interaction.reply({ content: '❌ Esta tarefa não está em andamento.', flags: MessageFlags.Ephemeral });
            }
            if (task.takenBy !== interaction.user.id && !isLeader(interaction.member)) {
                return interaction.reply({ content: '🔒 Apenas o responsável ou um líder pode concluir esta tarefa.', flags: MessageFlags.Ephemeral });
            }

            try { await ref.update({ status: 'done', doneBy: interaction.user.id, doneAt: new Date() }); }
            catch (err) {
                console.error('Erro ao concluir tarefa:', err);
                return interaction.reply({ content: '❌ Erro ao atualizar a tarefa.', flags: MessageFlags.Ephemeral });
            }

            await removeFromThread(interaction.client, taskId, task.takenBy);

            const conclusionContainer = new ContainerBuilder()
                .setAccentColor(0x2ecc71)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent('## 🎖️  Missão cumprida!'),
                    new TextDisplayBuilder().setContent(
                        `<@${interaction.user.id}> concluiu esta tarefa. Excelente trabalho, soldado!`
                    ),
                );

            if (interaction.channel?.isThread?.()) {
                const disabledBtn = new ButtonBuilder()
                    .setCustomId(`task_done_${taskId}`)
                    .setLabel('Concluída!')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅')
                    .setDisabled(true);

                await interaction.update({
                    flags: MessageFlags.IsComponentsV2,
                    components: [
                        new ContainerBuilder()
                            .setAccentColor(0x2ecc71)
                            .addActionRowComponents(new ActionRowBuilder().addComponents(disabledBtn))
                            .addTextDisplayComponents(
                                new TextDisplayBuilder().setContent(`-# Concluída por <@${interaction.user.id}>`),
                            ),
                    ],
                });
                await interaction.followUp({
                    flags: MessageFlags.IsComponentsV2,
                    components: [conclusionContainer],
                });
            } else {
                await interaction.reply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [conclusionContainer],
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