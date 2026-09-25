import { config, newId } from './config.mjs';
import { label, t } from './i18n.mjs';
import { ownerOf, teammates } from './roles.mjs';
import { append, getRequest, requestsBy } from './store.mjs';

// Anything that changes the world outside the agent's own working tree waits for its human:
// a push, a change on a server, a deploy. The agent describes the problem, the plan and the
// reason; the owner approves in Telegram; the local hook lets only that action through.
export const ACTIONS = ['push', 'server', 'deploy'];
export const GRANT_MS = 30 * 60 * 1000;
const MAX_DIFF = 60_000;

export const normalizeTarget = (target) => String(target || '').trim().toLowerCase();

export const validateRequest = ({ action, target, problem, plan, why, diff }) => {
  if (!ACTIONS.includes(action)) return `action must be one of: ${ACTIONS.join(', ')}`;
  if (!normalizeTarget(target)) return 'target is required: "<repo>:<branch>" for push, the host for server, the environment for deploy.';
  if (![problem, plan, why].every((field) => String(field || '').trim())) return 'problem, plan and why are all required - the human decides from them alone.';
  if (diff && diff.length > MAX_DIFF) return `diff is over ${MAX_DIFF} characters - send the key part and name the rest.`;
  return null;
};

// A grant covers one action on one target until it expires; it is not single-use, because
// one approved job often needs several commands.
export const findGrant = (agent, action, target) => {
  const wanted = normalizeTarget(target);
  return (
    requestsBy(agent).find(
      (request) =>
        request.status === 'approve' &&
        request.action === action &&
        normalizeTarget(request.target) === wanted &&
        request.expiresAt > Date.now(),
    ) ?? null
  );
};

const esc = (value) => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const tg = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({}));
};

const buttons = (id) => ({
  inline_keyboard: [[
    { text: t.approveRequest, callback_data: `req:approve:${id}` },
    { text: t.rejectRequest, callback_data: `req:reject:${id}` },
    { text: t.askReview, callback_data: `req:review:${id}` },
  ]],
});

export const announceRequest = async (request) => {
  if (!config.telegram.token || !config.telegram.chat) return null;
  const owner = ownerOf(request.from);
  const text =
    `${t.requestTitle(label(request.from), t.action[request.action] || request.action)} <code>${esc(request.target)}</code>\n\n` +
    `<b>${t.requestProblem}:</b> ${esc(request.problem)}\n\n<b>${t.requestPlan}:</b> ${esc(request.plan)}\n\n` +
    `<b>${t.requestWhy}:</b> ${esc(request.why)}` +
    (request.risk ? `\n\n<b>${t.requestRisk}:</b> ${esc(request.risk)}` : '') +
    (request.commands?.length ? `\n\n<pre>${esc(request.commands.join('\n')).slice(0, 1500)}</pre>` : '') +
    (owner ? `\n\n👤 <a href="tg://user?id=${owner}">${t.decides}</a>` : '');
  const sent = await tg('sendMessage', { chat_id: config.telegram.chat, text: text.slice(0, 4000), parse_mode: 'HTML', reply_markup: buttons(request.id) });
  return sent?.result?.message_id ?? null;
};

export const createRequest = async (agent, input) => {
  const request = append({
    type: 'request',
    id: newId('req'),
    from: agent,
    action: input.action,
    target: input.target,
    problem: input.problem,
    plan: input.plan,
    why: input.why,
    risk: input.risk || '',
    commands: input.commands || [],
    diff: input.diff || '',
  });
  const tgMessageId = await announceRequest(request);
  if (tgMessageId) append({ type: 'request_mirror', id: request.id, tgMessageId });
  return request;
};

const reply = (request, text, extra = {}) =>
  tg('sendMessage', { chat_id: config.telegram.chat, text, parse_mode: 'HTML', reply_to_message_id: request.tgMessageId, ...extra });

export const decide = async (request, decision, who) => {
  const expiresAt = decision === 'approve' ? Date.now() + GRANT_MS : null;
  append({ type: 'request_decision', id: request.id, decision, by: who, expiresAt });
  await tg('editMessageReplyMarkup', { chat_id: config.telegram.chat, message_id: request.tgMessageId, reply_markup: { inline_keyboard: [] } });
  const verdict = decision === 'approve' ? t.requestApproved(who, Math.round(GRANT_MS / 60000)) : t.requestRejected(who);
  await reply(request, verdict);
  // The agent is waiting: tell it in its inbox, not only in the chat.
  append({
    type: 'message', id: newId('msg'), thread: `request-${request.id}`, kind: 'human', from: 'human', author: who, to: request.from,
    subject: verdict.replace(/<[^>]+>/g, ''), body: `${request.action} ${request.target}`, facts: [],
  });
};

// With one teammate the reviewer is obvious; with several the human picks from a keyboard.
export const askReview = async (request, who, reviewer = null) => {
  const candidates = teammates(request.from);
  const chosen = reviewer || (candidates.length === 1 ? candidates[0] : null);
  if (!chosen) {
    await reply(request, t.pickReviewer, {
      reply_markup: { inline_keyboard: [candidates.map((name) => ({ text: name, callback_data: `req:reviewer:${request.id}:${name}` }))] },
    });
    return;
  }
  append({ type: 'request_review_asked', id: request.id, reviewer: chosen, by: who });
  append({
    type: 'message', id: newId('msg'), thread: `request-${request.id}`, kind: 'human', from: 'human', author: who, to: chosen,
    subject: t.reviewLetter(request.from, request.action, request.target),
    body: `${request.problem}\n\n${request.plan}\n\nbus_reviews → bus_review`, facts: [],
  });
  await reply(request, t.reviewAsked(label(chosen)));
};

export const submitReview = async (agent, id, verdict, findings) => {
  const request = getRequest(id);
  if (!request || request.reviewer !== agent) return 'This request is not waiting for your review.';
  append({ type: 'request_review', id, by: agent, verdict, findings });
  await reply(request, `${t.reviewDone(label(agent), t.verdict[verdict] || verdict)}\n\n${esc(findings).slice(0, 3000)}`);
  return null;
};
