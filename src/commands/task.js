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
        opt
          .setName('status')
          .setDescription('Filtrar por status')
          .addChoices(
            { name: ' Abertas',     value: 'open' },
            { name: ' Aprovadas',    value: 'approved' },
            { name: ' Em andamento', value: 'taken' },
            { name: '✅ Concluídas',   value: 'done' },
          ),
      ),
  )
  .addSubcommand(sub =>
    sub
      .setName('cancelar')
      .setDescription('Cancela (rejeita) uma tarefa pelo ID')
      .addStringOption(opt =>
        opt.setName('id').setDescription('ID da tarefa').setRequired(true),
      ),
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // ── /task criar — Step 1: mostrar selects de categoria e prioridade ──────
  if (sub === 'criar') {
    const categorySelect = new StringSelectMenuBuilder();
    categorySelect.setCustomId('select_task_category');
    categorySelect.setPlaceholder('Selecione a categoria...');
    categorySelect.addOptions(
      new StringSelectMenuOptionBuilder().setLabel('🚛 Logística').setDescription('Transporte e suprimentos').setValue('logistics'),
      new StringSelectMenuOptionBuilder().setLabel('🏭 Produção').setDescription('Fábricas e munição').setValue('production'),
    );

    const prioritySelect = new StringSelectMenuBuilder();
    prioritySelect.setCustomId('select_task_priority');
    prioritySelect.setPlaceholder('Selecione a prioridade...');
    prioritySelect.addOptions(
      new StringSelectMenuOptionBuilder().setLabel('🟢 Baixa').setDescription('Pode ser feito quando possível').setValue('low'),
      new StringSelectMenuOptionBuilder().setLabel('🟡 Média').setDescription('Importante mas não urgente').setValue('medium'),
      new StringSelectMenuOptionBuilder().setLabel('🔴 Alta').setDescription('Urgente, precisa de atenção imediata').setValue('high'),
    );

    const embed = new EmbedBuilder();
    embed.setTitle('📋 Nova Tarefa — Passo 1 de 2');
    embed.setDescription('Selecione a **categoria** e a **prioridade** da tarefa abaixo.\nDepois clique em continuar para preencher os detalhes.');
    embed.setColor(0xf0a500);

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
    const { STATUS, CATEGORIES, PRIORITY } = await import('../utils/constants.js');

    const status = interaction.options.getString('status') ?? 'open';
    const db = getDb();
    const snap = await db
      .collection('tasks')
      .where('status', '==', status)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();

    if (snap.empty) {
      return interaction.reply({ content: `Nenhuma tarefa com status **${status}** encontrada.`, flags: 64 });
    }

    const fields = snap.docs.map(d => {
      const t = d.data();
      const cat = CATEGORIES[t.category]?.label ?? t.category;
      const pri = PRIORITY[t.priority] ?? t.priority;
      return { name: `${cat} — ${t.title}`, value: `Prioridade: ${pri} | ID: \`${d.id}\``, inline: false };
    });

    const embed = new EmbedBuilder()
      .setTitle(`Tarefas — ${STATUS[status]?.label ?? status}`)
      .setColor(STATUS[status]?.color ?? 0xffffff)
      .addFields(fields)
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // ── /task cancelar ───────────────────────────────────────────────────────
  if (sub === 'cancelar') {
    const { isLeader } = await import('../utils/constants.js');
    if (!isLeader(interaction.member)) {
      return interaction.reply({ content: '❌ Apenas líderes podem cancelar tarefas.', flags: 64 });
    }

    const id = interaction.options.getString('id');
    const { getDb } = await import('../utils/firebase.js');
    const db = getDb();
    const ref = db.collection('tasks').doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return interaction.reply({ content: `❌ Tarefa \`${id}\` não encontrada.`, flags: 64 });
    }

    await ref.update({ status: 'rejected', rejectedBy: interaction.user.id, rejectedAt: new Date() });

    const { refreshTaskboard } = await import('../utils/taskboard.js');
    await refreshTaskboard(interaction.client);

    return interaction.reply({ content: `✅ Tarefa \`${id}\` cancelada.`, flags: 64 });
  }
}
