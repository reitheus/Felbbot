import {
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    EmbedBuilder,
} from 'discord.js';
import { CATEGORIES, PRIORITY, STATUS, MAX_TASKS_PER_USER } from '../utils/constants.js';

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
    //mudar o nome stats
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
        const categorySelect = new StringSelectMenuBuilder();
        categorySelect.setCustomId('select_task_category');
        categorySelect.setPlaceholder('Selecione a categoria...');
        categorySelect.addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🚛 Logística').setDescription('Transporte e suprimentos').setValue('logistics'),
            new StringSelectMenuOptionBuilder().setLabel('🏭 Produção').setDescription('Fábricas e munição').setValue('production'),
            new StringSelectMenuOptionBuilder().setLabel('🔍 Reconhecimento').setDescription('Scouting e mapeamento de inimigos').setValue('recon'),
            new StringSelectMenuOptionBuilder().setLabel('📋 Fila de Fábrica').setDescription('Gerenciar filas e prioridades de produção').setValue('queue'),
            new StringSelectMenuOptionBuilder().setLabel('⛏️ Coleta').setDescription('Coletar recursos e materiais brutos').setValue('gathering'),
        );

        const prioritySelect = new StringSelectMenuBuilder();
        prioritySelect.setCustomId('select_task_priority');
        prioritySelect.setPlaceholder('Selecione a prioridade...');
        prioritySelect.addOptions(
            new StringSelectMenuOptionBuilder().setLabel('🟢 Baixa').setDescription('Pode ser feito quando possível').setValue('low'),
            new StringSelectMenuOptionBuilder().setLabel('🟡 Média').setDescription('Importante mas não urgente').setValue('medium'),
            new StringSelectMenuOptionBuilder().setLabel('🔴 Alta').setDescription('Urgente, precisa de atenção imediata').setValue('high'),
        );

        const embed = new EmbedBuilder()
            .setTitle('📋  Nova Tarefa — Passo 1 de 2')
            .setDescription('Selecione a **categoria** e a **prioridade** da tarefa abaixo.\nDepois clique em continuar para preencher os detalhes.')
            .setColor(0xe67e22)
            .setFooter({ text: `Sua seleção expira em 5 minutos.` });

        return interaction.reply({
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(categorySelect),
                new ActionRowBuilder().addComponents(prioritySelect),
            ],
            flags: 64,
        });
    }

    // ── /task listar ─────────────────────────────────────────────────────────
    if (sub === 'listar') {
        const { getDb } = await import('../utils/firebase.js');
        const status = interaction.options.getString('status') ?? 'open';
        const db = getDb();

        await interaction.deferReply({ flags: 64 });

        const snap = await db.collection('tasks').where('status', '==', status).orderBy('createdAt', 'desc').limit(10).get()
            .catch(() => null);

        if (!snap || snap.empty) {
            return interaction.editReply({ content: `Nenhuma tarefa com status **${STATUS[status]?.label ?? status}** encontrada.` });
        }

        const fields = snap.docs.map(d => {
            const t = d.data();
            const cat = CATEGORIES[t.category]?.label ?? t.category;
            const pri = PRIORITY[t.priority]?.label ?? t.priority;
            const responsible = t.takenBy ? ` • 🪖 <@${t.takenBy}>` : '';
            return { name: `${cat} — ${t.title}`, value: `${pri}${responsible} • \`${d.id}\``, inline: false };
        });

        const embed = new EmbedBuilder()
            .setTitle(`${STATUS[status]?.label ?? status} — ${snap.size} tarefa(s)`)
            .setColor(STATUS[status]?.color ?? 0xffffff)
            .addFields(fields)
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    // ── /task status ─────────────────────────────────────────────────────────

    if (sub === 'status') {
        const { getDb } = await import('../utils/firebase.js');
        const id = interaction.options.getString('id');
        const db = getDb();

        await interaction.deferReply({ flags: 64 });

        const doc = await db.collection('tasks').doc(id).get().catch(() => null);

        if (!doc?.exists) {
            return interaction.editReply('❌ Tarefa não encontrada. Verifique o ID.');
        }

        const t = doc.data();
        const catInfo = CATEGORIES[t.category] ?? { label: t.category, color: 0xffffff };
        const priInfo = PRIORITY[t.priority] ?? { label: t.priority };
        const statusInfo = STATUS[t.status] ?? { label: t.status, color: 0xffffff };

        const embed = new EmbedBuilder()
            .setColor(statusInfo.color)
            .setAuthor({ name: catInfo.label })
            .setTitle(t.title)
            .addFields(
                { name: '📊  Status', value: statusInfo.label, inline: true },
                { name: '⚡  Prioridade', value: priInfo.label, inline: true },
                { name: '👤  Criado por', value: `<@${t.createdBy}>`, inline: true },
                { name: '📝  Descrição', value: t.description || '_Sem descrição_', inline: false },
            )
            .setFooter({ text: `ID: ${doc.id}` })
            .setTimestamp(t.createdAt?.toDate?.() ?? new Date());

        if (t.takenBy) embed.addFields({ name: '🪖  Responsável', value: `<@${t.takenBy}>`, inline: true });
        if (t.approvedBy) embed.addFields({ name: '✅  Aprovado por', value: `<@${t.approvedBy}>`, inline: true });
        if (t.doneBy) embed.addFields({ name: '🎖️  Concluído por', value: `<@${t.doneBy}>`, inline: true });
        if (t.rejectedBy) embed.addFields({ name: '🟥  Rejeitado por', value: `<@${t.rejectedBy}>`, inline: true });

        return interaction.editReply({ embeds: [embed] });
    }

    // ── /task historico ──────────────────────────────────────────────────────
    if (sub === 'historico') {
        const { getDb } = await import('../utils/firebase.js');
        const limit = interaction.options.getInteger('quantidade') ?? 10;
        const db = getDb();

        await interaction.deferReply();

        // Busca sem orderBy para evitar necessidade de índice composto
        const snap = await db.collection('tasks').where('status', '==', 'done').limit(50).get()
            .catch(() => null);

        if (!snap || snap.empty) {
            return interaction.editReply('Nenhuma tarefa concluída ainda. O regimento precisa trabalhar mais! 🪖');
        }

        // Ordena localmente por doneAt (mais recente primeiro) e limita
        const sorted = snap.docs
            .sort((a, b) => {
                const aTime = a.data().doneAt?.toDate?.()?.getTime() ?? 0;
                const bTime = b.data().doneAt?.toDate?.()?.getTime() ?? 0;
                return bTime - aTime;
            })
            .slice(0, limit);

        const fields = sorted.map(d => {
            const t = d.data();
            const cat = CATEGORIES[t.category]?.label ?? t.category;
            const doneAt = t.doneAt?.toDate ? `<t:${Math.floor(t.doneAt.toDate().getTime() / 1000)}:R>` : '_data desconhecida_';
            return {
                name: `${cat} — ${t.title}`,
                value: `🎖️ <@${t.doneBy}> ${doneAt}`,
                inline: false,
            };
        });

        const embed = new EmbedBuilder()
            .setTitle(`🎖️  Histórico — Últimas ${snap.size} tarefas concluídas`)
            .setColor(0x95a5a6)
            .addFields(fields)
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }


    /* ── /task stats ──────────────────────────────────────────────────────────
    mudar nome do comando*/
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

        if (!allSnap) {
            return interaction.editReply('❌ Erro ao buscar estatísticas. Tente novamente.');
        }

        // Top contribuidores
        const contributions = {};
        doneSnap.docs.forEach(d => {
            const uid = d.data().doneBy;
            if (uid) contributions[uid] = (contributions[uid] ?? 0) + 1;
        });

        const top = Object.entries(contributions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([uid, count], i) => `${['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i]} <@${uid}> — **${count}** tarefa(s)`)
            .join('\n') || '_Nenhuma tarefa concluída ainda._';

        // Stats por categoria
        const byCategory = {};
        doneSnap.docs.forEach(d => {
            const cat = d.data().category;
            byCategory[cat] = (byCategory[cat] ?? 0) + 1;
        });

        const catStats = Object.entries(byCategory)
            .map(([cat, count]) => `${CATEGORIES[cat]?.label ?? cat}: **${count}**`)
            .join(' • ') || '_Sem dados_';

        const embed = new EmbedBuilder()
            .setTitle('📊  Estatísticas do Regimento')
            .setColor(0x3498db)
            .addFields(
                { name: '📋  Total de tarefas', value: `**${allSnap.size}**`, inline: true },
                { name: '✅  Concluídas', value: `**${doneSnap.size}**`, inline: true },
                { name: '🔵  Em andamento', value: `**${takenSnap.size}**`, inline: true },
                { name: '🟢  Disponíveis', value: `**${openSnap.size}**`, inline: true },
                { name: '📦  Por categoria', value: catStats, inline: false },
                { name: '🏆  Top contribuidores', value: top, inline: false },
            )
            .setFooter({ text: 'FELB Regiment  •  Foxhole' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    // ── /task cancelar ───────────────────────────────────────────────────────
    if (sub === 'cancelar') {
        const { isLeader } = await import('../utils/constants.js');
        if (!isLeader(interaction.member)) {
            return interaction.reply({ content: '🔒 Apenas líderes podem cancelar tarefas.', flags: 64 });
        }

        const id = interaction.options.getString('id');
        const { getDb } = await import('../utils/firebase.js');
        const db = getDb();
        const ref = db.collection('tasks').doc(id);
        const doc = await ref.get().catch(() => null);

        if (!doc?.exists) {
            return interaction.reply({ content: `❌ Tarefa \`${id}\` não encontrada.`, flags: 64 });
        }

        await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });

        const { refreshSingleTask } = await import('../utils/taskboard.js');
        const { removeFromApproval } = await import('../utils/approval.js');
        await removeFromApproval(interaction.client, id);
        await refreshSingleTask(interaction.client, id);

        return interaction.reply({ content: `✅ Tarefa \`${id}\` cancelada.`, flags: 64 });
    }
}