#!/usr/bin/env node
/**
 * Surfaces unread agent-bus mail without polling by hand.
 * SessionStart: adds pending mail to the session context.
 * Stop: blocks the turn once per new batch, so a letter is never missed mid-work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CONFIG = path.join(CLAUDE_DIR, 'agent-bus.json');
const BACKUPS = path.join(CLAUDE_DIR, 'bus-backups');
// Same list the server enforces; checked again here because this script is what writes to disk.
const ALLOWED = [
  /^skills\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._/-]+$/,
  /^agents\/[a-z0-9][a-z0-9-]*\.md$/,
  /^rules\/[a-z0-9][a-z0-9-]*\.md$/,
  /^hooks\/[a-z0-9][a-z0-9-]*\.(mjs|js|sh|py)$/,
];
const SEEN = path.join(os.tmpdir(), 'agent-bus-seen.json');

const read = (stream) =>
  new Promise((resolve) => {
    let raw = '';
    stream.on('data', (chunk) => (raw += chunk));
    stream.on('end', () => resolve(raw));
  });

const ping = async ({ url, token }) => {
  const response = await fetch(`${url}/api/ping`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  return response.json();
};

const api = (config, route, init = {}) =>
  fetch(`${config.url}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(6000),
  });

const install = (proposal) => {
  for (const { path: rel } of proposal.files) {
    if (rel.includes('..') || !ALLOWED.some((rule) => rule.test(rel))) throw new Error(`path not allowed: ${rel}`);
  }
  for (const { path: rel, content } of proposal.files) {
    const target = path.join(CLAUDE_DIR, rel);
    if (fs.existsSync(target)) {
      const backup = path.join(BACKUPS, proposal.id, rel);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(target, backup);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: rel.endsWith('.sh') ? 0o755 : 0o644 });
  }
};

// Approved setup proposals land here, before the session starts, exactly as the human saw them.
const applyApproved = async (config, text) => {
  const response = await api(config, '/api/proposals');
  if (!response.ok) return [];
  const done = [];
  for (const proposal of await response.json()) {
    let ok = true;
    let note = proposal.files.map((file) => file.path).join(', ');
    try {
      install(proposal);
    } catch (error) {
      ok = false;
      note = String(error.message || error);
    }
    await api(config, `/api/proposals/${proposal.id}/applied`, { method: 'POST', body: JSON.stringify({ ok, note }) });
    done.push(`  · ${ok ? '✅' : '❌'} «${proposal.title}» ${text.from} ${proposal.from}: ${note}`);
  }
  return done;
};

const TEXT = {
  en: {
    installed: (lines) => `Installed from agent-bus (approved in Telegram, backups in ~/.claude/bus-backups):\n${lines}\nA hook does not switch itself on - add it to settings.json.`,
    unread: (count, lines) => `Unread agent-bus mail (${count}):\n${lines}\nRead it with the bus_inbox tool.`,
    from: 'from',
  },
  ru: {
    installed: (lines) => `Поставлено с agent-bus (одобрено в Телеграме, бэкапы в ~/.claude/bus-backups):\n${lines}\nХук сам не включается - его надо прописать в settings.json.`,
    unread: (count, lines) => `Непрочитанные письма на agent-bus (${count}):\n${lines}\nПрочитать: инструмент bus_inbox.`,
    from: 'от',
  },
};

const main = async () => {
  if (!fs.existsSync(CONFIG)) return;
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const text = TEXT[config.lang] || TEXT.en;
  const payload = JSON.parse((await read(process.stdin)) || '{}');
  const event = payload.hook_event_name || '';

  let status;
  let installed = [];
  try {
    if (event === 'SessionStart') installed = await applyApproved(config, text);
    status = await ping(config);
  } catch {
    return; // the bus being down must never block work
  }

  const installedNote = installed.length ? text.installed(installed.join('\n')) : '';
  if (!status?.unread && !installedNote) return;

  const lines = (status?.subjects || []).map((subject) => `  · ${subject}`).join('\n');
  const summary = status?.unread ? text.unread(status.unread, lines) : '';

  if (event === 'SessionStart') {
    const context = [installedNote, summary].filter(Boolean).join('\n\n');
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
    );
    return;
  }
  if (!status?.unread) return;

  if (event === 'Stop') {
    const fingerprint = status.subjects.join('|');
    const seen = fs.existsSync(SEEN) ? JSON.parse(fs.readFileSync(SEEN, 'utf8')) : {};
    if (seen.fingerprint === fingerprint) return; // already raised this batch - do not loop
    fs.writeFileSync(SEEN, JSON.stringify({ fingerprint, at: Date.now() }));
    process.stdout.write(JSON.stringify({ decision: 'block', reason: summary }));
  }
};

main().catch(() => {});
