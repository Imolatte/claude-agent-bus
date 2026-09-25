import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { append, eventsOf } from './store.mjs';

// A role is one teammate's Claude: a name, how it shows in the chat, the human who owns it
// and a token. Roles from BUS_TOKENS are static; the rest are issued from the group chat and
// live in the event log, so adding a person never needs a restart.

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const ROLE_NAME = /^[a-z][a-z0-9-]{1,30}$/;
export const EVERYONE = 'all';

const humans = new Set((process.env.BUS_HUMANS || '').split(',').map((name) => name.trim()).filter(Boolean));
const envOwners = new Map(
  (process.env.BUS_OWNERS || '')
    .split(',')
    .map((pair) => pair.trim().split(':'))
    .filter(([agent, id]) => agent && id),
);
const admins = new Set((process.env.BUS_ADMINS || '').split(',').map((id) => id.trim()).filter(Boolean));
const lastSeen = new Map();

const issued = () => {
  const roles = new Map();
  const invites = new Map();
  for (const event of eventsOf(['role_invite', 'role_claim', 'role_remove'])) {
    if (event.type === 'role_invite') invites.set(event.codeHash, { ...event, used: false });
    if (event.type === 'role_claim') {
      const invite = invites.get(event.codeHash);
      if (invite) invite.used = true;
      roles.set(event.role, { role: event.role, label: invite?.label, owner: invite?.owner, tokenHash: event.tokenHash, at: event.at });
    }
    if (event.type === 'role_remove') roles.delete(event.role);
  }
  return { roles, invites };
};

const staticAgents = () => [...new Set(config.tokens.values())].filter((name) => !humans.has(name));

export const isAdmin = (telegramId) => admins.has(String(telegramId));

export const agentFromToken = (token) => {
  if (!token) return null;
  const fromEnv = config.tokens.get(token);
  const tokenHash = hash(token);
  const agent = fromEnv ?? [...issued().roles.values()].find((role) => role.tokenHash === tokenHash)?.role ?? null;
  if (agent) lastSeen.set(agent, Date.now());
  return agent;
};

export const agents = () => [...new Set([...staticAgents(), ...issued().roles.keys()])];

export const teammates = (agent) => agents().filter((name) => name !== agent);

// With a single teammate there is nobody else to mean, so the address can be left out.
export const defaultRecipient = (agent) => {
  const others = teammates(agent);
  return others.length === 1 ? others[0] : null;
};

export const ownerOf = (agent) => issued().roles.get(agent)?.owner ?? envOwners.get(agent) ?? null;

export const roleLabel = (agent) => issued().roles.get(agent)?.label ?? null;

export const listRoles = () =>
  agents().map((name) => ({
    name,
    owner: ownerOf(name),
    isStatic: staticAgents().includes(name),
    lastSeen: lastSeen.get(name) ?? null,
  }));

export const invite = ({ role, label, owner, by }) => {
  if (!ROLE_NAME.test(role)) return { error: 'bad_name' };
  if (agents().includes(role) || humans.has(role)) return { error: 'taken' };
  const code = randomBytes(9).toString('base64url');
  append({ type: 'role_invite', codeHash: hash(code), role, label, owner: String(owner), by, expiresAt: Date.now() + INVITE_TTL_MS });
  return { code };
};

export const claim = (code) => {
  const invite = issued().invites.get(hash(code));
  if (!invite || invite.used || invite.expiresAt < Date.now()) return null;
  if (agents().includes(invite.role)) return null;
  const token = randomBytes(24).toString('hex');
  append({ type: 'role_claim', role: invite.role, codeHash: invite.codeHash, tokenHash: hash(token) });
  return { agent: invite.role, token };
};

export const removeRole = (role) => {
  if (staticAgents().includes(role)) return { error: 'static' };
  if (!issued().roles.has(role)) return { error: 'unknown' };
  append({ type: 'role_remove', role });
  return { removed: role };
};
