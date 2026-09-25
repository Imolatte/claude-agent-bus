import { config } from './config.mjs';
import { append, getMessage, getProposal, lastThread, mirrorTarget, threadState } from './store.mjs';
import { notify } from './notify.mjs';
import { t } from './i18n.mjs';
import { answerCallback, markDecided, ownerOf } from './proposals.mjs';

// Humans steer the bus from the group chat with one word, so the commands are words
// people actually type - not slash syntax nobody remembers on a phone.
// No \b here: JavaScript decides word boundaries by ASCII, so /^статус\b/ never matches
// a Cyrillic word - every command would silently fail to parse.
const END = '(?=$|[\\s.,!:;])';
const COMMANDS = [
  { verb: 'approve', match: new RegExp(`^(делай|давай|ок|go|approve)${END}`, 'i') },
  { verb: 'hold', match: new RegExp(`^(стоп|стой|подожди|hold)${END}`, 'i') },
  { verb: 'take', match: new RegExp(`^(сам|сама|беру|забираю|mine)${END}`, 'i') },
  { verb: 'release', match: new RegExp(`^(дальше|продолжай|release|continue)${END}`, 'i') },
  { verb: 'status', match: new RegExp(`^(статус|status)${END}`, 'i') },
];

const api = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
};

const parse = (text) => {
  const trimmed = (text || '').trim();
  for (const { verb, match } of COMMANDS) {
    if (match.test(trimmed)) return { verb, rest: trimmed.replace(match, '').trim() };
  }
  return null;
};

// A reply points at the mirrored letter; a bare command falls back to the thread that
// moved last, and an explicit key ("hold ABC-123") always wins.
const resolveTarget = (update, rest) => {
  if (rest) return { thread: rest.split(/\s+/)[0], id: null };
  const replied = update.message?.reply_to_message?.message_id;
  if (replied) {
    const target = mirrorTarget(replied);
    if (target) return target;
  }
  const fallback = lastThread();
  return fallback ? { thread: fallback, id: null } : null;
};

const applyCommand = async (verb, target, who) => {
  const { thread, id } = target;
  if (verb === 'approve') {
    const message = id ? getMessage(id) : null;
    append({ type: 'approve', thread, id, by: who });
    return t.approved(who, message ? message.subject : t.approvedThread(thread));
  }
  if (verb === 'hold') {
    append({ type: 'hold', thread, by: who, note: t.holdNote });
    return t.held(who, thread);
  }
  if (verb === 'take') {
    append({ type: 'freeze', thread, reason: t.takenReason(who) });
    return t.taken(who, thread);
  }
  if (verb === 'release') {
    append({ type: 'release', thread, by: who });
    return t.released(who, thread);
  }
  const state = threadState(thread);
  const flag = (state.frozen && t.state.frozen) || (state.hold && t.state.hold) || t.state.open;
  return t.status(thread, flag, state.hops, config.maxHops);
};

const handleProposalTap = async (query) => {
  const [, decision, id] = String(query.data || '').split(':');
  const proposal = getProposal(id);
  if (!proposal) return answerCallback(query.id, t.noSuchProposal);
  if (String(query.from?.id) !== String(ownerOf(proposal.to))) {
    return answerCallback(query.id, t.notYours);
  }
  if (proposal.status !== 'pending') return answerCallback(query.id, t.alreadyDecided);
  const who = query.from?.username || query.from?.first_name || 'someone';
  append({ type: 'proposal_decision', id, decision, by: who });
  const isApproved = decision === 'approve';
  await answerCallback(query.id, isApproved ? t.willApply : t.declined);
  const verdict = isApproved ? t.verdictApply : t.verdictDecline;
  return markDecided(proposal.tgMessageId, `${who}: ${verdict}`);
};

const handle = async (update) => {
  if (update.callback_query?.data?.startsWith('prop:')) {
    if (String(update.callback_query.message?.chat?.id) === String(config.telegram.chat)) await handleProposalTap(update.callback_query);
    return;
  }
  const message = update.message;
  if (!message?.text) return;
  console.log(`update from ${message.chat?.id}: ${JSON.stringify(message.text).slice(0, 60)}`);
  if (String(message.chat?.id) !== String(config.telegram.chat)) {
    // Loud on purpose: a wrong chat id is the usual reason commands look ignored,
    // and the id is otherwise invisible once polling has consumed the update.
    console.log(`ignored message from chat ${message.chat?.id} (${message.chat?.title || message.chat?.type}) - configured: ${config.telegram.chat}`);
    return;
  }
  const command = parse(message.text);
  if (!command) return;
  const who = message.from?.username || message.from?.first_name || 'someone';
  const target = resolveTarget(update, command.rest);
  if (!target) {
    await notify(t.whichThread);
    return;
  }
  await notify(await applyCommand(command.verb, target, who));
};

export const startTelegram = () => {
  const { token, chat } = config.telegram;
  if (!token || !chat) return { polling: false };
  let offset = 0;
  let stopped = false;

  const loop = async () => {
    while (!stopped) {
      try {
        const data = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const update of data?.result || []) {
          offset = update.update_id + 1;
          await handle(update);
        }
      } catch (error) {
        // A network blip must not kill the listener - back off and keep polling.
        console.log(`telegram poll error: ${error?.message || error}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };

  loop();
  return { polling: true, stop: () => { stopped = true; } };
};
