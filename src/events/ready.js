import { refreshTaskboard } from '../utils/taskboard.js';

export const name  = 'ready';
export const once  = true;

export async function execute(client) {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await refreshTaskboard(client);
}
