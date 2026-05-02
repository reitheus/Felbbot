import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { initFirebase } from './utils/firebase.js';

// Commands
import * as taskCmd from './commands/task.js';

// Events
import * as readyEvent from './events/ready.js';
import * as interactionEvent from './events/interactionCreate.js';

// ── Firebase ────────────────────────────────────────────────────────────────
initFirebase();

// ── Discord client ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Registra comandos no client
client.commands = new Collection();
client.commands.set(taskCmd.data.name, taskCmd);

// Registra eventos
const events = [readyEvent, interactionEvent];
for (const event of events) {
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

client.login(process.env.DISCORD_TOKEN);
