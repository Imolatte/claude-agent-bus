import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const state = { events: [], messages: new Map(), threads: new Map(), mirrors: new Map(), proposals: new Map(), requests: new Map() };

const blankThread = (id) => ({
  id,
  hops: 0,
  hold: null,
  frozen: null,
  participants: new Set(),
  lastAt: null,
});

const thread = (id) => {
  if (!state.threads.has(id)) state.threads.set(id, blankThread(id));
  return state.threads.get(id);
};

// Proposals live outside threads: they are not a conversation and must not spend a budget.
const applyProposal = (event) => {
  if (event.type === 'proposal') state.proposals.set(event.id, { ...event, status: 'pending' });
  const proposal = state.proposals.get(event.id);
  if (!proposal) return;
  if (event.type === 'proposal_mirror') proposal.tgMessageId = event.tgMessageId;
  if (event.type === 'proposal_decision') Object.assign(proposal, { status: event.decision, decidedBy: event.by, decidedAt: event.at });
  if (event.type === 'proposal_applied') Object.assign(proposal, { status: event.ok ? 'applied' : 'failed', note: event.note, appliedAt: event.at });
};

// Work requests: an agent asks its human before pushing, deploying or changing a server.
const applyRequest = (event) => {
  if (event.type === 'request') state.requests.set(event.id, { ...event, status: 'pending', reviews: [] });
  const request = state.requests.get(event.id);
  if (!request) return;
  if (event.type === 'request_mirror') request.tgMessageId = event.tgMessageId;
  if (event.type === 'request_decision') Object.assign(request, { status: event.decision, decidedBy: event.by, expiresAt: event.expiresAt ?? null });
  if (event.type === 'request_review_asked') Object.assign(request, { reviewer: event.reviewer, reviewStatus: 'asked' });
  if (event.type === 'request_review') {
    request.reviews.push({ by: event.by, verdict: event.verdict, findings: event.findings, at: event.at });
    request.reviewStatus = 'done';
  }
  if (event.type === 'request_done') request.status = 'done';
};

const apply = (event) => {
  if (event.type.startsWith('proposal')) return applyProposal(event);
  if (event.type.startsWith('role_')) return undefined;
  if (event.type.startsWith('request')) return applyRequest(event);
  const t = thread(event.thread);
  t.lastAt = event.at;
  if (event.type === 'message') {
    state.messages.set(event.id, event);
    // A human stepping in is steering, not an exchange: it spends no budget.
    if (event.kind !== 'human') {
      t.hops += 1;
      t.participants.add(event.from);
    }
  }
  // Per reader, because a letter to everyone is read by each teammate separately.
  if (event.type === 'read' || event.type === 'ack') {
    const message = state.messages.get(event.id);
    const field = event.type === 'read' ? 'readBy' : 'ackedBy';
    if (message) message[field] = { ...message[field], [event.by || message.to]: event.at };
  }
  if (event.type === 'hold') t.hold = { by: event.by, note: event.note, at: event.at };
  // Release is the human's way back in, so it lifts both states: a freeze that only the
  // server could set would otherwise leave the thread dead forever.
  if (event.type === 'release') {
    t.hold = null;
    t.frozen = null;
  }
  if (event.type === 'freeze') t.frozen = { reason: event.reason, at: event.at };
  if (event.type === 'approve') {
    const message = state.messages.get(event.id);
    if (message) message.approvedAt = event.at;
  }
  // A Telegram mirror line is the handle humans reply to; this is how a reply finds its thread.
  if (event.type === 'mirror') state.mirrors.set(String(event.tgMessageId), { thread: event.thread, id: event.id });
};

export const init = () => {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  if (!fs.existsSync(config.dataFile)) fs.writeFileSync(config.dataFile, '');
  const lines = fs.readFileSync(config.dataFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      state.events.push(event);
      apply(event);
    } catch {
      // a corrupt line must not take the bus down - it is skipped and stays in the file
    }
  }
  return { events: state.events.length, threads: state.threads.size };
};

export const append = (event) => {
  const stamped = { at: new Date().toISOString(), ...event };
  fs.appendFileSync(config.dataFile, `${JSON.stringify(stamped)}\n`);
  state.events.push(stamped);
  apply(stamped);
  return stamped;
};

export const threadState = (id) => {
  const t = state.threads.get(id);
  if (!t) return { ...blankThread(id), participants: [] };
  return { ...t, participants: [...t.participants] };
};

export const listThread = (id) =>
  state.events.filter((event) => event.type === 'message' && event.thread === id);

export const inbox = (agent, { unreadOnly = true, thread: threadId = null, limit = 20 } = {}) =>
  state.events
    .filter((event) => event.type === 'message' && (event.to === agent || (event.to === 'all' && event.from !== agent)))
    .filter((event) => (threadId ? event.thread === threadId : true))
    .filter((event) => (unreadOnly ? !event.readBy?.[agent] : true))
    .slice(-limit);

export const markRead = (messages, agent) =>
  messages.filter((message) => !message.readBy?.[agent]).map((message) => append({ type: 'read', id: message.id, thread: message.thread, by: agent }));

export const getMessage = (id) => state.messages.get(id) ?? null;

export const mirrorTarget = (tgMessageId) => state.mirrors.get(String(tgMessageId)) ?? null;

export const lastThread = () => {
  const open = [...state.threads.values()].filter((t) => t.lastAt);
  if (open.length === 0) return null;
  return open.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt))).at(-1).id;
};

export const openThreads = () =>
  [...state.threads.values()].map((t) => ({ ...t, participants: [...t.participants] }));

export const getProposal = (id) => state.proposals.get(id) ?? null;

export const proposalsFor = (agent, status) =>
  [...state.proposals.values()].filter((proposal) => proposal.to === agent && (!status || proposal.status === status));

export const eventsOf = (types) => state.events.filter((event) => types.includes(event.type));

export const getRequest = (id) => state.requests.get(id) ?? null;

export const requestsBy = (agent) => [...state.requests.values()].filter((request) => request.from === agent);

export const reviewsFor = (agent) =>
  [...state.requests.values()].filter((request) => request.reviewer === agent && request.reviewStatus === 'asked');
