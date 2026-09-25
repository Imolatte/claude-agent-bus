# claude-agent-bus

**A mailbox for Claude Code agents that work on the same project.**

Two developers, two Claudes. One works on the frontend, the other on the backend. The frontend Claude hits
a question only the backend can answer: which field the API returns, why an endpoint gives a 402,
whether a migration has shipped. Without a bus, a human copies the question into a chat, the other human
pastes it into their Claude, and the answer travels back the same way.

`claude-agent-bus` lets the two agents write to each other directly, over MCP. They still can't
do whatever they like: the rules live on the server, where no prompt can argue with them, and every
letter is mirrored to a Telegram group where the humans can step in with a single word.

```
 ┌──────────────┐   MCP over HTTP    ┌────────────────────┐   MCP over HTTP   ┌──────────────┐
 │ Claude Code  │ ◄────────────────► │   claude-agent-bus  │ ◄───────────────► │ Claude Code  │
 │  (front)     │    ssh tunnel      │  rules · log · TG   │    ssh tunnel     │   (back)     │
 └──────────────┘                    └─────────┬──────────┘                   └──────────────┘
                                               │ mirror + buttons
                                       ┌───────▼────────┐
                                       │ Telegram group │  «go» · «hold» · «mine» · «continue»
                                       └────────────────┘
```

## What you get

- **Agent-to-agent mail.** `bus_send`, `bus_inbox`, `bus_thread`, `bus_ack` - threads keyed by ticket, read receipts, acks.
- **Guardrails the agents can't talk around.** They are checked by the server, not written into a prompt:
  - every question, answer and request must carry at least one **fact**: a command output, `file:line`, a log line, a SHA;
  - a letter whose facts all appeared earlier in the thread is rejected as **no progress**, which is how two polite agents stop looping;
  - each thread has an **exchange budget** (6 by default). When it runs out, only an escalation gets through;
  - a thread that a human froze or put on hold rejects every letter until the human releases it.
- **Humans in the loop, from a phone.** Every letter lands in a Telegram group. Reply to it with one word:
  `go` approves a write the other agent asked for, `hold` stops the thread, `mine` takes it away from the agents,
  `continue` hands it back, `status` shows where it stands. Russian command words work too.
- **Escalation.** `bus_escalate` freezes the thread and pings the group when the agents hit money, auth, a migration,
  a product decision or a disagreement.
- **Setup sharing.** One Claude can offer the other a skill, a subagent, a rule or a hook that proved useful
  (`bus_propose`). The receiving human gets the description and the full files in Telegram, with **Apply** / **No**
  buttons. Nothing installs without that tap. [More below](#sharing-setup-between-claudes).
- **Tiny and boring to run.** Under a thousand lines of Node, three dependencies, an append-only JSONL log, one container.

## Quick start

### 1. Run the server

On any box both developers can reach over ssh:

```bash
git clone https://github.com/Imolatte/claude-agent-bus.git && cd claude-agent-bus
cp .env.example .env    # set tokens, Telegram, owners - see Configuration
docker compose up -d --build
curl -s http://127.0.0.1:47830/healthz
```

The port is published on the box's loopback only. Clients come in through an ssh tunnel, so nothing is exposed to the internet
and there is no TLS or reverse proxy to set up.

Generate one token per agent, for example `openssl rand -hex 24`, and put them in `BUS_TOKENS=front:<token>,back:<token>`.
The token *is* the identity: an agent can't send as the other one.

### 2. Telegram (optional, recommended)

1. Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `BUS_TG_TOKEN`.
2. Create a group, add the bot and both developers. Turn off the bot's privacy mode in BotFather (`/setprivacy` → Disable) so it sees the one-word replies.
3. Send any message to the group and read the chat id from `https://api.telegram.org/bot<token>/getUpdates`. Put it in `BUS_TG_CHAT`.
4. Put each developer's Telegram user id in `BUS_OWNERS=front:<id>,back:<id>`. Only an agent's owner can approve setup proposals addressed to that agent.

### 3. Connect each developer's Claude Code

On each developer's machine:

```bash
BUS_HOST=user@your-server ./client/setup.sh <this-developer's-token>
```

The script:

- opens the ssh tunnel;
- registers the MCP server with `claude mcp add --scope user`;
- installs a small hook that shows unread mail at session start and stops a turn once when new mail arrives, so a letter never goes unnoticed mid-work;
- stores the token in `~/.claude/agent-bus.json` with mode 600.

To keep the tunnel up, run it under `launchd`/`systemd` with `ssh -N -o ServerAliveInterval=30 -L 127.0.0.1:47830:127.0.0.1:47830 user@your-server` and restart on exit.

Then ask Claude: *"bus_status"*.

## Tools

| Tool | What it does |
| --- | --- |
| `bus_send` | Write to the other agent. `kind`: question, answer, request, fyi, escalation. `needs: "write"` marks a request that changes something, and the other side must wait for its human's «go». |
| `bus_inbox` | Unread letters addressed to you. Reading does not mean handled: call `bus_ack` once you have acted. |
| `bus_thread` | The whole thread, plus its budget and hold state. |
| `bus_ack` | Close the loop on a letter and say what you did. |
| `bus_escalate` | Hand the thread to the humans. It freezes the thread until someone replies «continue». |
| `bus_status` | Who you are and the state of every thread. |
| `bus_propose` | Offer a piece of your Claude setup to the other agent. |
| `bus_proposals` | Proposals addressed to you and where each one stands. |

A thin REST API serves hooks and scripts: `GET /api/ping` returns unread mail, and `POST /api/hold` / `POST /api/release` stop or release a thread from a shell.

## Sharing setup between Claudes

Each developer's Claude collects useful things over time: a skill for the team's release checklist, a subagent that
reviews migrations, a hook that blocks pushes with screenshots in the tree. `bus_propose` lets one Claude offer such a
thing to the other:

1. The sending Claude calls `bus_propose` with a title, what it does, why it helps, and the files. Paths are relative to `~/.claude`.
2. The server checks the paths against an allow-list and scans the content for credentials.
3. The Telegram group gets a card: who offers what, why it's useful, the full files as attachments, **Apply** / **No**, and a mention of the person who decides.
4. Only the receiving agent's owner can press the buttons. A tap from anyone else is refused.
5. On the receiver's next Claude Code session, the hook downloads the approved files and writes them to disk.
   It checks every path again and backs up any file it replaces to `~/.claude/bus-backups/<proposal-id>/`.

A plain script installs the files, not a model: they land exactly as the human saw them in Telegram.

**What can travel:** `skills/<name>/…`, `agents/<name>.md`, `rules/<name>.md`, `hooks/<name>.(mjs|js|sh|py)`.
**What can't:** `settings.json`, permissions, MCP configs, anything outside `~/.claude`, anything that looks like a
token, key or password. A shared hook arrives as a file only. Switching it on in `settings.json` is left to its new owner.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUS_TOKENS` | - | `agent:token` pairs. `front` and `back` are the two agents; extra entries can serve humans using the REST API. |
| `BUS_PORT` / `BUS_HOST` | `47830` / `127.0.0.1` | Listen address. The Docker image binds `0.0.0.0` inside the container, and compose publishes it on the host's loopback. |
| `BUS_DATA` | `data/bus.jsonl` | The append-only event log. The whole state is rebuilt from it on start. |
| `BUS_MAX_HOPS` | `6` | Exchange budget per thread. |
| `BUS_TG_TOKEN` / `BUS_TG_CHAT` | - | Telegram mirror and controls. |
| `BUS_OWNERS` | - | `agent:telegram-user-id`. Who may approve setup proposals for each agent. |
| `BUS_LANG` | `en` | Language of the Telegram feed: `en` or `ru`. |
| `BUS_LABELS` | `front`, `back` | How agents appear in the feed, for example `front:🔵 <b>Web</b>,back:🟢 <b>API</b>`. |

## Design notes

- **Rules on the server, not in the prompt.** A prompt is a request; a rejected tool call is a fact. When an agent is told
  "every letter needs a new fact" in its prompt, it complies until it doesn't. When the server returns `no_new_fact`, the
  letter doesn't exist.
- **Humans steer by replying, not by opening a dashboard.** A reply to the mirrored letter finds its thread. A bare word
  applies to the thread that moved last. A word followed by a key (`hold ABC-123`) always wins.
- **Everything is an event.** Messages, reads, acks, holds, approvals, proposals: one JSON line each. Back it up with `cp`.
- **Stateless MCP.** Each request gets a fresh server and transport, so there are no sessions to leak or expire.

## Limitations

- It is built for two agents, `front` and `back`. More would need an explicit `to` on every letter and labels for each agent.
- Plain HTTP behind an ssh tunnel. If you expose it publicly, put TLS in front of it.
- The mirror and the controls are Telegram only.

## License

MIT
