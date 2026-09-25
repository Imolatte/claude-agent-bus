import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.mjs';
import { agentFromToken, claim } from './roles.mjs';
import { append, getProposal, inbox, init, openThreads, proposalsFor } from './store.mjs';
import { validateProposal } from './proposals.mjs';
import { registerTools } from './tools.mjs';
import { notify } from './notify.mjs';
import { t } from './i18n.mjs';
import { startTelegram } from './telegram.mjs';

const app = express();
app.use(express.json({ limit: '2mb' }));

const auth = (req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const agent = agentFromToken(token);
  if (!agent) return res.status(401).json({ error: 'unknown token' });
  req.agent = agent;
  return next();
};

// The one unauthenticated call: a one-time invite code from the group chat becomes a token.
app.post('/api/claim', (req, res) => {
  const granted = claim(String(req.body?.code || ''));
  if (!granted) return res.status(403).json({ error: 'invite code is unknown, used or expired' });
  return res.json(granted);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, threads: openThreads().length }));

// MCP endpoint - stateless: a fresh server and transport per request.
app.all('/mcp', auth, async (req, res) => {
  const server = new McpServer({ name: 'agent-bus', version: '0.1.0' });
  registerTools(server, req.agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Thin REST surface so shell hooks and cron can poll without an MCP client.
app.get('/api/ping', auth, (req, res) => {
  const messages = inbox(req.agent, { unreadOnly: true, limit: 50 });
  res.json({
    agent: req.agent,
    unread: messages.length,
    subjects: messages.map((message) => `${message.thread}: ${message.subject}`),
  });
});

app.post('/api/hold', auth, async (req, res) => {
  const { thread, note = '' } = req.body || {};
  if (!thread) return res.status(400).json({ error: 'thread required' });
  append({ type: 'hold', thread, by: req.agent, note });
  await notify(t.held(req.agent, thread));
  return res.json({ held: thread });
});

app.post('/api/release', auth, async (req, res) => {
  const { thread } = req.body || {};
  if (!thread) return res.status(400).json({ error: 'thread required' });
  append({ type: 'release', thread, by: req.agent });
  await notify(t.released(req.agent, thread));
  return res.json({ released: thread });
});

// Approved proposals are installed by a plain script on the receiving machine, not by a model:
// the files land exactly as the human saw them in Telegram.
app.get('/api/proposals', auth, (req, res) => {
  const ready = proposalsFor(req.agent, 'approve').filter((proposal) => !validateProposal(proposal));
  res.json(ready.map(({ id, from, title, files }) => ({ id, from, title, files })));
});

app.post('/api/proposals/:id/applied', auth, (req, res) => {
  const proposal = getProposal(req.params.id);
  if (!proposal || proposal.to !== req.agent) return res.status(404).json({ error: 'unknown proposal' });
  const { ok = true, note = '' } = req.body || {};
  append({ type: 'proposal_applied', id: proposal.id, ok: Boolean(ok), note });
  return res.json({ recorded: proposal.id });
});

const loaded = init();
const tg = startTelegram();
app.listen(config.port, config.host, () => {
  console.log(`agent-bus on ${config.host}:${config.port} · ${loaded.events} events, ${loaded.threads} threads · agents: ${[...config.tokens.values()].join(', ')} · telegram: ${tg.polling ? 'on' : 'off'}`);
});
