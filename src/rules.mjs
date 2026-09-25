import { config } from './config.mjs';
import { listThread, threadState } from './store.mjs';

export const KINDS = ['question', 'answer', 'request', 'fyi', 'escalation'];
const NEEDS_FACTS = new Set(['question', 'answer', 'request']);
const MAX_BODY = 16000;

const normalizeFact = (fact) => String(fact).trim().toLowerCase().replace(/\s+/g, ' ');

const knownFacts = (threadId) =>
  new Set(listThread(threadId).flatMap((message) => (message.facts || []).map(normalizeFact)));

const reject = (code, message) => ({ ok: false, code, message });

/**
 * The whole point of the bus: these limits live on the server, so neither agent
 * can talk its way past them. Every rejection names what the caller must do instead.
 */
export const validateSend = (input) => {
  const { from, to, thread, kind, subject, body, facts = [], needs = null } = input;

  if (from === to) return reject('self_send', 'An agent cannot write to itself.');
  if (!KINDS.includes(kind)) return reject('bad_kind', `kind must be one of: ${KINDS.join(', ')}`);
  if (!subject?.trim()) return reject('no_subject', 'subject is required.');
  if (!body?.trim()) return reject('no_body', 'body is required.');
  if (body.length > MAX_BODY) return reject('body_too_long', `body must be under ${MAX_BODY} characters - link to a file or a log instead of pasting it.`);

  const state = threadState(thread);

  if (state.frozen) {
    return reject('thread_frozen', `Thread ${thread} is frozen (${state.frozen.reason}). A human must release it before the agents continue.`);
  }
  if (state.hold) {
    return reject('human_hold', `A human stepped into thread ${thread} and it is on hold. Wait for an explicit "continue" - do not answer around them.`);
  }
  if (kind !== 'escalation' && state.hops >= config.maxHops) {
    return {
      ok: false,
      code: 'budget_exhausted',
      message: `Thread ${thread} used its budget of ${config.maxHops} exchanges. Send kind:"escalation" summarising where you are stuck, or freeze it.`,
      freeze: `budget of ${config.maxHops} exchanges used up`,
    };
  }

  if (NEEDS_FACTS.has(kind)) {
    const cleaned = facts.map((fact) => String(fact).trim()).filter(Boolean);
    if (cleaned.length === 0) {
      return reject('no_new_fact', 'Every question, answer and request must carry at least one fact: a command output, file:line, a log line, a SHA, a field from an API response. An opinion is not a fact.');
    }
    const seen = knownFacts(thread);
    if (cleaned.every((fact) => seen.has(normalizeFact(fact)))) {
      return reject('no_progress', `All facts in this message already appear in thread ${thread}. Repeating them is how two agents loop forever - bring a new observation or escalate.`);
    }
  }

  return { ok: true, requiresApproval: needs === 'write' };
};
