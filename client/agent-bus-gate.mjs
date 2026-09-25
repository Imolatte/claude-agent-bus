#!/usr/bin/env node
/**
 * PreToolUse gate for Bash: a push, a write to a remote server or a deploy runs only under
 * an approved agent-bus request. Reading a server (logs, docker ps, cat) passes freely.
 * Exit 2 blocks the command and tells the agent what to do instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CONFIG = process.env.AGENT_BUS_CONFIG || path.join(os.homedir(), '.claude', 'agent-bus.json');

const READ_ONLY = [
  /^(cat|ls|ll|tail|head|grep|egrep|zgrep|zcat|less|wc|stat|du|df|free|uptime|ps|whoami|hostname|date|id|uname|pwd|which|readlink|awk|sort|uniq|cut|tr|jq|echo|printf|nproc|lsof|ss|netstat|ip|dig|nslookup|ping|test|true|file|md5sum|sha256sum|diff|tree)\b/,
  /^find\b(?!.*-(delete|exec))/,
  /^sed\s+-n\b/,
  /^top\s+-b/,
  /^docker\s+(ps|logs|inspect|images|stats|top|port|version|info)\b/,
  /^docker\s+compose\s+(ps|logs|config|images|top)\b/,
  /^systemctl\s+(status|is-active|is-enabled|is-failed|list-units|list-timers|show|cat)\b/,
  /^journalctl\b/,
  /^git\s+(status|log|diff|show|branch|remote|rev-parse|ls-files|fetch)\b/,
  /^curl\b(?!.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|-F\s|--upload))/,
];

const block = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const read = () => {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
};

const unquote = (value) => value.replace(/^['"]|['"]$/g, '');

const words = (segment) => (segment.match(/'[^']*'|"[^"]*"|\S+/g) || []).map(unquote);

const git = (args, cwd) => {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch {
    return '';
  }
};

const expandHome = (value) => value.replace(/^~(?=\/|$)/, os.homedir());

// Where the command runs: the last `cd X` before it, `git -C X`, or the session directory.
const workDir = (command, base) => {
  const cd = [...command.matchAll(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)].at(-1);
  const dashC = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/);
  const raw = dashC?.[1] || cd?.[1];
  if (!raw) return base;
  const dir = expandHome(unquote(raw));
  return path.isAbsolute(dir) ? dir : path.join(base, dir);
};

const pushTargets = (segment, dir) => {
  const args = words(segment.slice(segment.search(/\bpush\b/) + 4)).filter((word) => !word.startsWith('-'));
  const repo = path.basename(git('rev-parse --show-toplevel', dir) || dir);
  const refspecs = args.slice(1);
  const branches = refspecs.length ? refspecs.map((ref) => ref.split(':').at(-1).replace(/^refs\/heads\//, '').replace(/^\+/, '')) : [git('branch --show-current', dir)];
  // An unknown branch still needs a yes: failing open here would wave every push through.
  return branches.map((branch) => `${repo}:${branch || 'unknown-branch'}`);
};

const hostOf = (value) => value.replace(/^[^@]+@/, '').replace(/:.*$/, '');

const isReadOnly = (remote) =>
  remote
    .split(/;|&&|\|\||\|/)
    .map((part) => part.trim().replace(/^sudo\s+(-u\s+\S+\s+)?/, ''))
    .filter(Boolean)
    .every((part) => READ_ONLY.some((rule) => rule.test(part)) && !/[^2]>\s*[^&\s]/.test(part));

const serverTarget = (segment) => {
  const list = words(segment);
  const tool = list[0];
  if (tool === 'ssh') {
    const rest = list.slice(1);
    let index = 0;
    while (index < rest.length && rest[index].startsWith('-')) index += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[index]) ? 2 : 1;
    const host = rest[index];
    if (!host) return null;
    const remote = rest.slice(index + 1).join(' ');
    if (remote && isReadOnly(remote)) return null;
    return hostOf(host);
  }
  // scp / rsync: writing is when the destination - the last argument - is remote.
  const destination = list.filter((word) => !word.startsWith('-')).at(-1) || '';
  return /^[^/\s]+:/.test(destination) ? hostOf(destination) : null;
};

const DEPLOY = [
  [/\bvercel\b(?!\s+(ls|list|logs|inspect|whoami|env\s+ls|pull)\b)/, 'vercel'],
  [/\bglab\s+ci\s+(run|retry|trigger)\b/, 'gitlab-ci'],
  [/\bgh\s+workflow\s+run\b/, 'github-actions'],
  [/\bkubectl\s+(apply|delete|rollout|scale|patch|set|edit|replace)\b/, 'kubernetes'],
  [/\bdocker\s+push\b/, 'docker-registry'],
  [/\bnpm\s+publish\b/, 'npm'],
  [/\bterraform\s+(apply|destroy)\b/, 'terraform'],
];

// Heredoc bodies are data fed to a program, not commands - a note that mentions a push is not a push.
const dropHeredocs = (command) =>
  command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (match) => match.split('\n')[0]);

// Split on ; && || and newlines, but never inside quotes: `ssh host 'ls; rm x'` is one command.
const splitTop = (command) => {
  const parts = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const pair = command.slice(index, index + 2);
    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (pair === '&&' || pair === '||') {
      parts.push(current);
      current = '';
      index += 1;
    } else if (char === ';' || char === '\n') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
};

// Quoted text is an argument, except the remote command of ssh, which serverTarget reads itself.
const unquoted = (segment) => segment.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

// Every action this command would take that needs a human's yes, as [action, target].
export const classify = (command, base) => {
  const dir = workDir(command, base);
  const needs = [];
  for (const raw of splitTop(dropHeredocs(command))) {
    const segment = raw.trim().replace(/^(\w+=\S+\s+)+/, '');
    const bare = unquoted(segment);
    if (/\bgit\b.*\bpush\b/.test(bare) && !/\bstash\s+push\b/.test(bare)) for (const target of pushTargets(segment, dir)) needs.push(['push', target]);
    if (/^(ssh|scp|rsync)\b/.test(segment)) {
      const host = serverTarget(segment);
      if (host) needs.push(['server', host]);
    }
    for (const [rule, target] of DEPLOY) if (rule.test(bare)) needs.push(['deploy', target]);
  }
  return needs;
};

const main = async () => {
  const input = read();
  if ((input.tool_name || input.toolName) !== 'Bash') return;
  if (process.env.BUS_GATE_OFF === '1') return;
  const command = String(input.tool_input?.command || '').trim();
  const needs = classify(command, input.cwd || process.cwd());
  if (!needs.length) return;

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return; // not connected to a bus - nothing to enforce against
  }

  for (const [action, target] of needs) {
    let granted = false;
    try {
      const url = `${config.url}/api/grant?action=${encodeURIComponent(action)}&target=${encodeURIComponent(target)}`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(5000) });
      granted = response.ok && (await response.json()).granted === true;
    } catch {
      block(`BLOCKED by agent-bus: the bus is unreachable, so "${action} ${target}" cannot be checked. Fix the tunnel, or ask your human.`);
    }
    if (!granted) {
      block(
        `BLOCKED by agent-bus: "${action} ${target}" needs your human's approval.\n` +
          `Call bus_request with action "${action}", target "${target}", the problem, exactly what you will do, why, and the risk. ` +
          'Then wait: check bus_request_status and run this only once it says "approve".',
      );
    }
  }
};

main();
