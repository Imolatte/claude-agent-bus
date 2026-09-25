import { config } from './config.mjs';
import { label, t } from './i18n.mjs';

// What one Claude may hand another: its working knowledge, never its permissions.
// settings.json, MCP configs and anything holding credentials stay out by construction.
const ALLOWED = [
  /^skills\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._/-]+$/,
  /^agents\/[a-z0-9][a-z0-9-]*\.md$/,
  /^rules\/[a-z0-9][a-z0-9-]*\.md$/,
  /^hooks\/[a-z0-9][a-z0-9-]*\.(mjs|js|sh|py)$/,
];

const SECRETS = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gl(pat|dt)-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  /bearer\s+[A-Za-z0-9._-]{24,}/i,
  /(token|secret|password|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._-]{16,}/i,
];

const MAX_FILES = 10;
const MAX_FILE = 60_000;

export const validateProposal = ({ files }) => {
  if (!files?.length) return 'Attach at least one file.';
  if (files.length > MAX_FILES) return `At most ${MAX_FILES} files per proposal.`;
  for (const { path, content } of files) {
    if (path.includes('..') || !ALLOWED.some((rule) => rule.test(path))) {
      return `Path "${path}" is not shareable. Allowed, relative to ~/.claude: skills/<name>/..., agents/<name>.md, rules/<name>.md, hooks/<name>.(mjs|js|sh|py).`;
    }
    if (content.length > MAX_FILE) return `"${path}" is over ${MAX_FILE} characters.`;
    if (SECRETS.some((rule) => rule.test(content))) {
      return `"${path}" looks like it contains a credential. Remove it and send again - secrets never travel on the bus.`;
    }
  }
  return null;
};

// Only the human behind the receiving agent can let a change into that agent's setup.
const owners = new Map(
  (process.env.BUS_OWNERS || '')
    .split(',')
    .map((pair) => pair.trim().split(':'))
    .filter(([agent, id]) => agent && id),
);

export const ownerOf = (agent) => owners.get(agent) ?? null;

const esc = (value) =>
  String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const tg = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({}));
};

const sendFile = async (replyTo, { path, content }) => {
  const form = new FormData();
  form.append('chat_id', config.telegram.chat);
  form.append('reply_to_message_id', String(replyTo));
  form.append('document', new Blob([content], { type: 'text/plain' }), path.split('/').at(-1));
  form.append('caption', `~/.claude/${path}`);
  await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendDocument`, { method: 'POST', body: form });
};

export const announce = async (proposal) => {
  if (!config.telegram.token || !config.telegram.chat) return null;
  const files = proposal.files.map(({ path }) => `· <code>~/.claude/${esc(path)}</code>`).join('\n');
  const text =
    `${t.proposalTitle(label(proposal.from), label(proposal.to))}\n\n` +
    `<b>${esc(proposal.title)}</b>\n\n<b>${t.proposalWhat}:</b> ${esc(proposal.what)}\n<b>${t.proposalWhy}:</b> ${esc(proposal.why)}\n\n` +
    `${t.proposalFiles}:\n${files}\n\n${t.proposalAsk}`;
  const sent = await tg('sendMessage', {
    chat_id: config.telegram.chat,
    text,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: t.apply, callback_data: `prop:approve:${proposal.id}` },
        { text: t.decline, callback_data: `prop:reject:${proposal.id}` },
      ]],
    },
  });
  const messageId = sent?.result?.message_id ?? null;
  if (messageId) for (const file of proposal.files) await sendFile(messageId, file);
  return messageId;
};

export const answerCallback = (id, text) => tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: true });

export const markDecided = (messageId, text) =>
  tg('editMessageReplyMarkup', { chat_id: config.telegram.chat, message_id: messageId, reply_markup: { inline_keyboard: [] } })
    .then(() => tg('sendMessage', { chat_id: config.telegram.chat, text, reply_to_message_id: messageId }));
