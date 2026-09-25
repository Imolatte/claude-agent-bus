import { randomUUID } from 'node:crypto';

const parseTokens = (raw) =>
  new Map(
    (raw || '')
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [agent, token] = pair.split(':');
        return [token, agent];
      })
      .filter(([token, agent]) => token && agent),
  );

export const config = {
  port: Number(process.env.BUS_PORT || 47830),
  // In a container the process must bind 0.0.0.0 and the port is published on the host's
  // loopback instead; bare-metal keeps the default and stays unreachable from outside.
  host: process.env.BUS_HOST || '127.0.0.1',
  dataFile: process.env.BUS_DATA || new URL('../data/bus.jsonl', import.meta.url).pathname,
  tokens: parseTokens(process.env.BUS_TOKENS),
  maxHops: Number(process.env.BUS_MAX_HOPS || 6),
  telegram: {
    token: process.env.BUS_TG_TOKEN || '',
    chat: process.env.BUS_TG_CHAT || '',
  },
};

export const newId = (prefix) => `${prefix}_${randomUUID().slice(0, 12)}`;
