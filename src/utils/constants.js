export const CATEGORIES = {
  logistics: { label: '🚛 Logística', color: 0xf0a500 },
  production: { label: '🏭 Produção',  color: 0x3b82f6 },
};

export const STATUS = {
  open:      { label: '🟨 Aberta',      color: 0xf0a500 },
  approved:  { label: '🟩 Aprovada',    color: 0x22c55e },
  taken:     { label: '🔵 Em andamento',color: 0x3b82f6 },
  done:      { label: '✅ Concluída',   color: 0x6b7280 },
  rejected:  { label: '🟥 Rejeitada',   color: 0xef4444 },
};

export const PRIORITY = {
    low: {
        label: '🟢 Baixa', emoji: '🟢'
    },
    medium: {
        label: '🟡 Média', emoji: '🟡'
    },
    high: {
        label: '🔴 Alta', emoji: '🔴'
    }
};

// Tempo limite para seleções pendentes (5 minutos)
export const PENDING_SELECTION_TTL = 5 * 60 * 1000;

// Tempo para lembrete de tarefa em andamento (4 horas)
export const TASK_REMINDER_MS = 4 * 60 * 60 * 1000;

// Limite de tarefas simultâneas por usuário
export const MAX_TASKS_PER_USER = 3;

/** Verifica se o membro possui algum dos cargos de líder */
export function isLeader(member) {
    const leaderIds = process.env.LEADER_ROLE_IDS?.split(',').map(s => s.trim()) ?? [];
    return leaderIds.some(id => member.roles.cache.has(id));
}

