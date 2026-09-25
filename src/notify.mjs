import { config } from './config.mjs';
import { label, t } from './i18n.mjs';

const esc = (value) =>
  String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const line = (message) => {
  // One bot publishes the whole feed, so the sender has to be legible at a glance.
  const who = `${label(message.from)} → ${label(message.to)}`;
  const head = `${who}   <i>${esc(message.thread)} · ${t.kind[message.kind] || message.kind}</i>`;
  const flag = message.requiresApproval ? `\n\n${t.needsApproval}` : '';
  const facts = (message.facts || []).length
    ? `\n\n${message.facts.map((fact) => `· <code>${esc(fact)}</code>`).join('\n')}`
    : '';
  const body = esc(message.body || '').slice(0, 500);
  return `${head}\n\n<b>${esc(message.subject)}</b>\n${body}${facts}${flag}`;
};

export const notify = async (text) => {
  const { token, chat } = config.telegram;
  if (!token || !chat) return { sent: false, reason: 'telegram not configured' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const payload = await response.json().catch(() => ({}));
    return { sent: response.ok, messageId: payload?.result?.message_id ?? null };
  } catch (error) {
    return { sent: false, reason: String(error) };
  }
};

export const notifyMessage = (message) => notify(line(message));

export const mirrorId = async (message) => (await notify(line(message))).messageId;
