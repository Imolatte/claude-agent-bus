// Everything a human reads in the chat. Agents get English from the tools either way.
const STRINGS = {
  en: {
    kind: { question: 'question', answer: 'answer', request: 'request', fyi: 'fyi', escalation: '🚨 escalation' },
    needsApproval: '⚠ <b>needs approval</b> - reply «go»',
    budgetSpent: (thread, why) => `⏳ Thread ${thread}: ${why}. Only an escalation is left.`,
    closedAfterEscalation: (thread) => `🧊 Thread ${thread} closed after the escalation. A human is needed.`,
    escalationReason: 'escalation after the budget ran out',
    escalates: (agent, thread, reason, question) => `🚨 ${agent} escalates ${thread}\nReason: ${reason}\nQuestion: ${question}`,
    approved: (who, what) => `✅ ${who} approved: ${what}.`,
    approvedThread: (thread) => `work in thread ${thread}`,
    held: (who, thread) => `✋ ${who} put thread ${thread} on hold. Agents stay quiet until «continue».`,
    holdNote: 'hold from the group',
    taken: (who, thread) => `🙋 ${who} took ${thread}. Agents keep their hands off it.`,
    takenReason: (who) => `${who} took the thread`,
    released: (who, thread) => `▶️ ${who} released thread ${thread}.`,
    status: (thread, state, hops, max) => `${thread}: ${state}, exchanges ${hops}/${max}.`,
    state: { frozen: 'frozen', hold: 'on hold', open: 'open' },
    whichThread: 'Not sure which thread you mean - reply to a letter or name the thread.',
    proposalTitle: (from, to) => `🧩 <b>${from} offers a setup change</b> to ${to}`,
    proposalWhat: 'What it does',
    proposalWhy: 'Why it helps',
    proposalFiles: 'Files (full text below)',
    proposalAsk: 'Apply it on your side?',
    decides: 'your call',
    apply: '✅ Apply',
    decline: '✖️ No',
    noSuchProposal: 'No such proposal.',
    notYours: 'Only the human behind the receiving agent decides.',
    alreadyDecided: 'Already decided.',
    willApply: 'It installs on the next session start.',
    declined: 'Declined.',
    verdictApply: '✅ installs on the next session start',
    verdictDecline: '✖️ declined',
  },
  ru: {
    kind: { question: 'вопрос', answer: 'ответ', request: 'просьба', fyi: 'к сведению', escalation: '🚨 эскалация' },
    needsApproval: '⚠ <b>нужно согласие</b> - ответь «делай»',
    budgetSpent: (thread, why) => `⏳ Тред ${thread}: ${why}. Осталась только эскалация.`,
    closedAfterEscalation: (thread) => `🧊 Тред ${thread} закрыт после эскалации. Нужен человек.`,
    escalationReason: 'эскалация после исчерпанного бюджета',
    escalates: (agent, thread, reason, question) => `🚨 ${agent} эскалирует ${thread}\nПричина: ${reason}\nВопрос: ${question}`,
    approved: (who, what) => `✅ ${who} разрешил: ${what}.`,
    approvedThread: (thread) => `работу в треде ${thread}`,
    held: (who, thread) => `✋ ${who} остановил тред ${thread}. Агенты молчат до «дальше».`,
    holdNote: 'стоп из группы',
    taken: (who, thread) => `🙋 ${who} забрал ${thread} себе. Агенты его не трогают.`,
    takenReason: (who) => `${who} забрал тред себе`,
    released: (who, thread) => `▶️ ${who} снял стоп с треда ${thread}.`,
    status: (thread, state, hops, max) => `${thread}: ${state}, обменов ${hops}/${max}.`,
    state: { frozen: 'заморожен', hold: 'на стопе', open: 'открыт' },
    whichThread: 'Не понял, к какому треду это относится - ответь на строку письма или назови тред.',
    proposalTitle: (from, to) => `🧩 <b>${from} предлагает настройку</b> для ${to}`,
    proposalWhat: 'Что делает',
    proposalWhy: 'Чем полезно',
    proposalFiles: 'Файлы (целиком - ниже)',
    proposalAsk: 'Применить у себя?',
    decides: 'решать тебе',
    apply: '✅ Применить',
    decline: '✖️ Нет',
    noSuchProposal: 'Такого предложения нет.',
    notYours: 'Решает только тот, чей Клод получает настройку.',
    alreadyDecided: 'Уже решено.',
    willApply: 'Поставится при следующем запуске сессии.',
    declined: 'Отклонено.',
    verdictApply: '✅ применится при следующем запуске сессии',
    verdictDecline: '✖️ отклонено',
  },
};

export const t = STRINGS[process.env.BUS_LANG] || STRINGS.en;

const labels = new Map(
  (process.env.BUS_LABELS || '')
    .split(',')
    .map((pair) => {
      const at = pair.indexOf(':');
      return [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
    })
    .filter(([agent, text]) => agent && text),
);

const DEFAULT_LABELS = { front: '🔵 <b>front</b>', back: '🟢 <b>back</b>' };

export const label = (agent) => labels.get(agent) || DEFAULT_LABELS[agent] || agent;
