import {
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
} from "discord.js";
import { CATEGORIES, PRIORITY, STATUS } from '../utils/constants.js';

export const data = new SlashCommandBuilder()
    .setName('task')
    .setDescription('Gerencia as tarefas do regimento')
    .addSubcommand(sub =>
        sub.setName('criar').setDescription('Abre o formulário para criar uma nova tarefa'),
    )
    .addSubcommand(sub =>
        sub
            .setName('listar')
            .setDescription('Lista tarefas por status')
            .addStringOption(opt =>
                opt.setName('status').setDescription('Filtrar por status')
                    .addChoices(
                        { name: '🟨 Abertas', value: 'open' },
                        { name: '🟩 Aprovadas', value: 'approved' },
                        { name: '🔵 Em andamento', value: 'taken' },
                        { name: '✅ Concluídas', value: 'done' },
                    ),
            ),
    )
    .addSubcommand(sub =>
        sub
            .setName('status')
            .setDescription('Veja os detalhes de uma tarefa específica')
            .addStringOption(opt =>
                opt.setName('id').setDescription('ID da tarefa').setRequired(true),
            ),
    )
    .addSubcommand(sub =>
        sub
            .setName('historico')
            .setDescription('Últimas tarefas concluídas do regimento')
            .addIntegerOption(opt =>
                opt.setName('quantidade').setDescription('Quantas tarefas mostrar (padrão: 10)').setMinValue(1).setMaxValue(25),
            ),
    )
    .addSubcommand(sub =>
        sub.setName('stats').setDescription('Estatísticas gerais do regimento'),
    )
    .addSubcommand(sub =>
        sub
            .setName('cancelar')
            .setDescription('Cancela uma tarefa pelo ID (apenas líderes)')
            .addStringOption(opt =>
                opt.setName('id').setDescription('ID da tarefa').setRequired(true),
            ),
    );

export async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /task criar ──────────────────────────────────────────────────────────
    if (sub === 'criar') {
        const categorySelect = new StringSelectMenuBuilder()
            .setCustomId('select_task_category')
            .setPlaceholder('Selecione a categoria...')
            .addOptions([
                { label: '🚛 Logística', description: 'Transporte e suprimentos', value: 'logistics' },
                { label: '🏭 Produção', description: 'Fábricas e munição', value: 'production' },
                { label: '🔍 Reconhecimento', description: 'Scouting e mapeamento de inimigos', value: 'recon' },
                { label: '📋 Fila de Fábrica', description: 'Gerenciar filas e prioridades de produção', value: 'queue' },
                { label: '⛏️ Coleta', description: 'Coletar recursos e materiais brutos', value: 'gathering' },
            ]);

        const prioritySelect = new StringSelectMenuBuilder()
            .setCustomId('select_task_priority')
            .setPlaceholder('Selecione a prioridade...')
            .addOptions([
                { label: '🟢 Baixa', description: 'Pode ser feito quando possível', value: 'low' },
                { label: '🟡 Média', description: 'Importante mas não urgente', value: 'medium' },
                { label: '🔴 Alta', description: 'Urgente, precisa de atenção imediata', value: 'high' },
            ]);

        const container = new ContainerBuilder()
            .setAccentColor(0xe67e22)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('## 📋  Nova Tarefa'),
                new TextDisplayBuilder().setContent(
                    'Selecione a **categoria** e a **prioridade** da tarefa.\n' +
                    'O botão para continuar aparecerá após selecionar as duas opções.\n' +
                    '-# Sua seleção expira em 5 minutos.'
                ),
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent('⬜  **Categoria:** _não selecionada_\n⬜  **Prioridade:** _não selecionada_'),
            )
            .addActionRowComponents(new ActionRowBuilder().addComponents(categorySelect))
            .addActionRowComponents(new ActionRowBuilder().addComponents(prioritySelect));

        return interaction.reply({
            flags: [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral],
            components: [container],
        });
    }

    // ── /task listar ─────────────────────────────────────────────────────────
    if (sub === 'listar') {
        const { getDb } = await import('../utils/firebase.js');
        const status = interaction.options.getString('status') ?? 'open';
        const db = getDb();

        await interaction.deferReply();

        const snap = await db.collection('tasks').where('status', '==', status).orderBy('createdAt', 'desc').limit(10).get()
            .catch(() => null);

        if (!snap || snap.empty) {
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [
                    new ContainerBuilder()
                        .setAccentColor(0x6b7280)
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`## ${STATUS[status]?.label ?? status}`),
                            new TextDisplayBuilder().setContent('Nenhuma tarefa encontrada com este status.'),
                        ),
                ],
            });
        }

        const lines = snap.docs.map(d => {
            const t = d.data();
            const cat = CATEGORIES[t.category]?.label ?? t.category;
            const pri = PRIORITY[t.priority]?.label ?? t.priority;
            const resp = t.takenBy ? `  •  🪖 <@${t.takenBy}>` : '';
            return `**${t.title}**\n${cat}  •  ${pri}${resp}\n-# \`${d.id}\``;
        }).join('\n\n');

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(STATUS[status]?.color ?? 0xffffff)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`## ${STATUS[status]?.label ?? status} — ${snap.size} tarefa(s)`),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines)),
            ],
        });
    }

    // ── /task status ─────────────────────────────────────────────────────────
    if (sub === 'status') {
        const { getDb } = await import('../utils/firebase.js');
        const id = interaction.options.getString('id');
        const db = getDb();

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const doc = await db.collection('tasks').doc(id).get().catch(() => null);
        if (!doc?.exists) {
            return interaction.editReply('❌ Tarefa não encontrada. Verifique o ID.');
        }

        const t = doc.data();
        const catInfo = CATEGORIES[t.category] ?? { label: t.category, color: 0xffffff };
        const priInfo = PRIORITY[t.priority] ?? { label: t.priority };
        const statusInfo = STATUS[t.status] ?? { label: t.status, color: 0xffffff };

        let deadlineText = '';
        if (t.deadlineAt) {
            const unix = Math.floor((t.deadlineAt?.toDate ? t.deadlineAt.toDate() : new Date(t.deadlineAt)).getTime() / 1000);
            const expired = (t.deadlineAt?.toDate ? t.deadlineAt.toDate() : new Date(t.deadlineAt)).getTime() < Date.now();
            deadlineText = `\n${expired ? '🔴 **Prazo EXPIRADO**' : '⏳ **Prazo**'} — <t:${unix}:R>`;
        }

        const extraFields = [];
        if (t.takenBy) extraFields.push(`🪖 **Responsável:** <@${t.takenBy}>`);
        if (t.approvedBy) extraFields.push(`✅ **Aprovado por:** <@${t.approvedBy}>`);
        if (t.doneBy) extraFields.push(`🎖️ **Concluído por:** <@${t.doneBy}>`);
        if (t.rejectedBy) extraFields.push(`⛔ **Rejeitado por:** <@${t.rejectedBy}>`);

        const metaLine = `${statusInfo.label}  •  ${priInfo.label}  •  👤 <@${t.createdBy}>${deadlineText}`;

        const container = new ContainerBuilder()
            .setAccentColor(statusInfo.color)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**${catInfo.label}**`),
                new TextDisplayBuilder().setContent(`## ${t.title}`),
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(metaLine),
                new TextDisplayBuilder().setContent(t.description || '_Sem descrição_'),
            );

        if (extraFields.length) {
            container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(extraFields.join('\n')),
            );
        }

        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`-# ID: ${doc.id}  •  FELB Regiment`),
        );

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [container],
        });
    }

    // ── /task historico ──────────────────────────────────────────────────────
    if (sub === 'historico') {
        const { getDb } = await import('../utils/firebase.js');
        const limit = interaction.options.getInteger('quantidade') ?? 10;
        const db = getDb();

        await interaction.deferReply();

        const snap = await db.collection('tasks').where('status', '==', 'done').limit(50).get().catch(() => null);

        if (!snap || snap.empty) {
            return interaction.editReply('Nenhuma tarefa concluída ainda. O regimento precisa trabalhar mais! 🪖');
        }

        const sorted = snap.docs
            .sort((a, b) => (b.data().doneAt?.toDate?.()?.getTime() ?? 0) - (a.data().doneAt?.toDate?.()?.getTime() ?? 0))
            .slice(0, limit);

        const lines = sorted.map(d => {
            const t = d.data();
            const cat = CATEGORIES[t.category]?.label ?? t.category;
            const doneAt = t.doneAt?.toDate ? `<t:${Math.floor(t.doneAt.toDate().getTime() / 1000)}:R>` : '_data desconhecida_';
            return `**${t.title}**\n${cat}  •  🎖️ <@${t.doneBy}> ${doneAt}`;
        }).join('\n\n');

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0x95a5a6)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`## 🎖️  Histórico — Últimas ${sorted.length} concluídas`),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines)),
            ],
        });
    }

    // ── /task stats ──────────────────────────────────────────────────────────
    if (sub === 'stats') {
        const { getDb } = await import('../utils/firebase.js');
        const db = getDb();

        await interaction.deferReply();

        const [allSnap, doneSnap, takenSnap, openSnap] = await Promise.all([
            db.collection('tasks').get(),
            db.collection('tasks').where('status', '==', 'done').get(),
            db.collection('tasks').where('status', '==', 'taken').get(),
            db.collection('tasks').where('status', '==', 'approved').get(),
        ]).catch(() => [null, null, null, null]);

        if (!allSnap) return interaction.editReply('❌ Erro ao buscar estatísticas.');

        const contributions = {};
        doneSnap.docs.forEach(d => {
            const uid = d.data().doneBy;
            if (uid) contributions[uid] = (contributions[uid] ?? 0) + 1;
        });

        const top = Object.entries(contributions)
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([uid, count], i) => `${['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]} <@${uid}> — **${count}**`)
            .join('\n') || '_Nenhuma tarefa concluída ainda._';

        const byCategory = {};
        doneSnap.docs.forEach(d => {
            const cat = d.data().category;
            byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        });

        const catStats = Object.entries(byCategory)
            .map(([cat, count]) => `${CATEGORIES[cat]?.label ?? cat}: **${count}**`)
            .join('  •  ') || '_Sem dados_';

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0x3498db)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## 📊  Estatísticas do Regimento'),
                    )
                    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `📋 **Total:** ${allSnap.size}  •  ` +
                            `✅ **Concluídas:** ${doneSnap.size}  •  ` +
                            `🔵 **Em andamento:** ${takenSnap.size}  •  ` +
                            `🟩 **Disponíveis:** ${openSnap.size}`
                        ),
                        new TextDisplayBuilder().setContent(`**📦 Por categoria:**\n${catStats}`),
                        new TextDisplayBuilder().setContent(`**🏆 Top contribuidores:**\n${top}`),
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('-# FELB Regiment  •  Foxhole'),
                    ),
            ],
        });
    }

    // ── /task cancelar ───────────────────────────────────────────────────────
    if (sub === 'cancelar') {
        const { isLeader } = await import('../utils/constants.js');
        if (!isLeader(interaction.member)) {
            return interaction.reply({ content: '🔒 Apenas líderes podem cancelar tarefas.', flags: MessageFlags.Ephemeral });
        }

        const id = interaction.options.getString('id');
        const { getDb } = await import('../utils/firebase.js');
        const db = getDb();
        const ref = db.collection('tasks').doc(id);
        const doc = await ref.get().catch(() => null);

        if (!doc?.exists) {
            return interaction.reply({ content: `❌ Tarefa \`${id}\` não encontrada.`, flags: MessageFlags.Ephemeral });
        }

        await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });

        const { refreshSingleTask } = await import('../utils/taskboard.js');
        const { removeFromApproval } = await import('../utils/approval.js');
        await removeFromApproval(interaction.client, id);
        await refreshSingleTask(interaction.client, id);

        return interaction.reply({
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [
                new ContainerBuilder()
                    .setAccentColor(0xe74c3c)
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent('## ⛔  Tarefa cancelada'),
                        new TextDisplayBuilder().setContent(`A tarefa \`${id}\` foi cancelada com sucesso.`),
                    ),
            ],
        });
    }
}