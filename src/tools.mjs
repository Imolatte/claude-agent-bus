import { z } from 'zod';
import { config, newId } from './config.mjs';
import { defaultRecipient, EVERYONE, ownerOf, teammates } from './roles.mjs';
import { append, getMessage, inbox, listThread, markRead, openThreads, proposalsFor, threadState } from './store.mjs';
import { announce, validateProposal } from './proposals.mjs';
import { KINDS, validateSend } from './rules.mjs';
import { mirrorId, notify } from './notify.mjs';
import { t } from './i18n.mjs';

const text = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const fail = (payload) => ({ ...text(payload), isError: true });


const brief = (message) => ({
  id: message.id,
  thread: message.thread,
  from: message.from,
  kind: message.kind,
  subject: message.subject,
  body: message.body,
  facts: message.facts,
  requiresApproval: message.requiresApproval || false,
  // A write request stays a request until its owner approves it in the group chat.
  approved: message.requiresApproval ? Boolean(message.approvedAt) : true,
  at: message.at,
  ...(message.kind === 'human' && { fromHuman: message.author, note: 'Written by a person in the group chat. It outranks the agents in this thread.' }),
});

const resolveRecipient = (agent, to, { allowEveryone }) => {
  const others = teammates(agent);
  const target = to || defaultRecipient(agent);
  if (target === EVERYONE && allowEveryone) return { to: target };
  if (target && others.includes(target)) return { to: target };
  const options = allowEveryone ? [...others, EVERYONE] : others;
  return { error: `Say who this is for: to must be one of ${options.join(', ')}.` };
};

export const send = async (agent, input) => {
  const recipient = resolveRecipient(agent, input.to, { allowEveryone: true });
  if (recipient.error) return fail({ rejected: 'no_recipient', message: recipient.error });
  const payload = { ...input, from: agent, to: recipient.to };
  const verdict = validateSend(payload);

  if (!verdict.ok) {
    // A spent budget must not freeze the thread on the spot: the rejection tells the agent to
    // escalate, and freezing here made that impossible - the advice bounced off thread_frozen.
    // The freeze happens once the escalation is through, below.
    if (verdict.freeze) {
      await notify(t.budgetSpent(payload.thread, verdict.freeze));
    }
    return fail({ rejected: verdict.code, message: verdict.message });
  }

  const message = append({
    type: 'message',
    id: newId('msg'),
    ...payload,
    facts: payload.facts || [],
    requiresApproval: verdict.requiresApproval,
  });
  const tgMessageId = await mirrorId(message);
  if (tgMessageId) append({ type: 'mirror', thread: payload.thread, id: message.id, tgMessageId });

  const state = threadState(payload.thread);
  // The escalation is the last word in a thread that ran out of budget: it lands, humans read it,
  // and only then does the thread close so the agents cannot keep circling.
  if (payload.kind === 'escalation' && state.hops > config.maxHops) {
    append({ type: 'freeze', thread: payload.thread, reason: t.escalationReason });
    await notify(t.closedAfterEscalation(payload.thread));
  }

  return text({
    sent: message.id,
    thread: payload.thread,
    exchangesUsed: `${state.hops}/${config.maxHops}`,
    note: verdict.requiresApproval
      ? 'Marked as needing a write: the receiving side must get its owner\'s approval before doing it.'
      : undefined,
  });
};

export const registerTools = (server, agent) => {
  const toField = z
    .string()
    .nullable()
    .default(null)
    .describe(`Who it is for: ${[...teammates(agent), EVERYONE].join(', ')}. Can be left out when you have a single teammate.`);

  server.registerTool(
    'bus_send',
    {
      title: 'Send a message to a teammate',
      description: `Write to a teammate's Claude (you are "${agent}"). Every question, answer or request must carry at least one new fact - a command output, file:line, a log line, a SHA. Use needs:"write" when you are asking the other side to change something.`,
      inputSchema: {
        to: toField,
        thread: z.string().describe('Ticket key when there is one, otherwise a short stable slug'),
        kind: z.enum(KINDS),
        subject: z.string(),
        body: z.string(),
        facts: z.array(z.string()).default([]),
        needs: z.enum(['read', 'write']).nullable().default(null),
      },
    },
    async (input) => send(agent, input),
  );

  server.registerTool(
    'bus_inbox',
    {
      title: 'Read new messages',
      description: 'Unread messages addressed to you. Reading marks them read but not handled - call bus_ack when you have acted. Letters with fromHuman were written by a person in the group chat and take priority.',
      inputSchema: { thread: z.string().nullable().default(null), limit: z.number().default(20) },
    },
    async ({ thread, limit }) => {
      const messages = inbox(agent, { unreadOnly: true, thread, limit });
      markRead(messages, agent);
      return text({ count: messages.length, messages: messages.map(brief) });
    },
  );

  server.registerTool(
    'bus_thread',
    {
      title: 'Read a whole thread',
      description: 'The full exchange on one thread, plus its budget and hold state.',
      inputSchema: { thread: z.string() },
    },
    async ({ thread }) => {
      const state = threadState(thread);
      return text({
        thread,
        exchangesUsed: `${state.hops}/${config.maxHops}`,
        hold: state.hold,
        frozen: state.frozen,
        messages: listThread(thread).map(brief),
      });
    },
  );

  server.registerTool(
    'bus_ack',
    {
      title: 'Mark a message as handled',
      description: 'Close the loop on a message: say what you did with it.',
      inputSchema: { id: z.string(), note: z.string().default('') },
    },
    async ({ id, note }) => {
      const message = getMessage(id);
      if (!message) return fail({ rejected: 'unknown_message', message: `No message ${id}.` });
      append({ type: 'ack', id, thread: message.thread, by: agent, note });
      return text({ acked: id });
    },
  );

  server.registerTool(
    'bus_escalate',
    {
      title: 'Hand the thread to the humans',
      description: 'Use when the thread hits a contract, money, auth, a migration, a product decision, or when the two of you disagree. Freezes the thread and pings Telegram.',
      inputSchema: { thread: z.string(), reason: z.string(), question: z.string() },
    },
    async ({ thread, reason, question }) => {
      append({ type: 'freeze', thread, reason });
      append({ type: 'message', id: newId('msg'), thread, from: agent, to: defaultRecipient(agent) || EVERYONE, kind: 'escalation', subject: `Escalation: ${reason}`, body: question, facts: [] });
      await notify(t.escalates(agent, thread, reason, question));
      return text({ escalated: thread, note: 'Thread frozen until a human releases it.' });
    },
  );

  server.registerTool(
    'bus_propose',
    {
      title: "Offer a piece of your Claude setup to a teammate's agent",
      description: 'Share a skill, agent, rule or hook that proved useful. The receiving human sees it in Telegram with the full files and decides; nothing is installed without their tap. Paths are relative to ~/.claude. Never include credentials.',
      inputSchema: {
        to: toField,
        title: z.string(),
        what: z.string().describe('What it does, in one or two plain sentences'),
        why: z.string().describe('Why it is useful to the receiving side specifically'),
        files: z.array(z.object({ path: z.string(), content: z.string() })),
      },
    },
    async ({ to: requested, title, what, why, files }) => {
      const recipient = resolveRecipient(agent, requested, { allowEveryone: false });
      if (recipient.error) return fail({ rejected: 'no_recipient', message: recipient.error });
      const { to } = recipient;
      const problem = validateProposal({ files });
      if (problem) return fail({ rejected: 'bad_proposal', message: problem });
      if (!ownerOf(to)) return fail({ rejected: 'no_owner', message: `Nobody is registered to approve changes for "${to}" yet.` });
      const proposal = append({ type: 'proposal', id: newId('prop'), from: agent, to, title, what, why, files });
      const tgMessageId = await announce(proposal);
      if (tgMessageId) append({ type: 'proposal_mirror', id: proposal.id, tgMessageId });
      return text({ proposed: proposal.id, note: 'Waiting for the receiving human in Telegram.' });
    },
  );

  server.registerTool(
    'bus_proposals',
    {
      title: 'Proposals addressed to you',
      description: 'Setup changes offered to you and where each one stands: pending, approve, reject, applied, failed.',
      inputSchema: {},
    },
    async () =>
      text(proposalsFor(agent).map(({ id, from, title, status, files }) => ({ id, from, title, status, files: files.map((file) => file.path) }))),
  );

  server.registerTool(
    'bus_status',
    { title: 'Bus status', description: 'Who you are on this bus, and the state of every thread.', inputSchema: {} },
    async () => text({ you: agent, teammates: teammates(agent), maxHops: config.maxHops, threads: openThreads() }),
  );
};
