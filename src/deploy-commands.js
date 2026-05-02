import dotenv from 'dotenv';
dotenv.config();
import { REST, Routes } from 'discord.js';
import * as taskCmd from './commands/task.js';

const commands = [taskCmd.data.toJSON()];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registrando slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registrados com sucesso!');
  } catch (err) {
    console.error(err);
  }
})();
