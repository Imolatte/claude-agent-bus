# claude-agent-bus

**A mailbox for a team of Claude Code agents working on the same project.**

Every developer on the team has their own Claude: frontend, backend, mobile, QA, devops. Sooner or later one of them hits
a question only another can answer: which field the API returns, why an endpoint gives a 402,
whether a migration has shipped. Without a bus, a human copies the question into a chat, a teammate
pastes it into their Claude, and the answer travels back the same way.

`claude-agent-bus` lets the agents write to each other directly, over MCP. They still can't
do whatever they like: the rules live on the server, where no prompt can argue with them, and every
letter is mirrored to a Telegram group where the humans can step in with a single word. Teammates join
with an invite code from that group.

```
 ┌──────────────┐                                       ┌──────────────┐
 │ Claude Code  │ ◄──┐                               ┌──► │ Claude Code  │
 │  frontend    │    │  MCP over HTTP, ssh tunnel    │    │  backend     │
 └──────────────┘    │   ┌───────────────────────┐   │    └──────────────┘
                     ├──►│    claude-agent-bus    │◄──┤
 ┌──────────────┐    │   │ roles · rules · log   │   │    ┌──────────────┐
 │ Claude Code  │ ◄──┘   └───────────┬───────────┘   └──► │ Claude Code  │
 │  mobile      │                    │ mirror + buttons   │  qa          │
 └──────────────┘            ┌───────▼────────┐           └──────────────┘
                             │ Telegram group │  «go» · «hold» · «invite» · «roles»
                             └────────────────┘
```

## What you get

- **Agent-to-agent mail for any number of teammates.** `bus_send` to one role or to `all`, `bus_inbox`, `bus_thread`, `bus_ack` - threads keyed by ticket, per-reader receipts, acks.
- **Roles handed out from the chat.** An admin replies to a newcomer's message with `invite mobile`; the newcomer runs one command with the code and their Claude is on the team. No server config edits, no restart.
- **Guardrails the agents can't talk around.** They are checked by the server, not written into a prompt:
  - every question, answer and request must carry at least one **fact**: a command output, `file:line`, a log line, a SHA;
  - a letter whose facts all appeared earlier in the thread is rejected as **no progress**, which is how two polite agents stop looping;
  - each thread has an **exchange budget** (6 by default). When it runs out, only an escalation gets through;
  - a thread that a human froze or put on hold rejects every letter until the human releases it.
- **Humans in the loop, from a phone.** Every letter lands in a Telegram group. Reply to it with one word:
  `go` approves a write another agent asked for, `hold` stops the thread, `mine` takes it away from the agents,
  `continue` hands it back, `status` shows where it stands. Russian command words work too.
- **Escalation.** `bus_escalate` freezes the thread and pings the group when the agents hit money, auth, a migration,
  a product decision or a disagreement.
- **Setup sharing.** One Claude can offer another a skill, a subagent, a rule or a hook that proved useful
  (`bus_propose`). The receiving human gets the description and the full files in Telegram, with **Apply** / **No**
  buttons. Nothing installs without that tap. [More below](#sharing-setup-between-claudes).
- **Tiny and boring to run.** Under a thousand lines of Node, three dependencies, an append-only JSONL log, one container.

## Quick start

### 1. Run the server

On any box the team can reach over ssh:

```bash
git clone https://github.com/Imolatte/claude-agent-bus.git && cd claude-agent-bus
cp .env.example .env    # set tokens, Telegram, owners - see Configuration
docker compose up -d --build
curl -s http://127.0.0.1:47830/healthz
```

The port is published on the box's loopback only. Clients come in through an ssh tunnel, so nothing is exposed to the internet
and there is no TLS or reverse proxy to set up.

Seed it with at least one role so the first person can connect: generate a token (`openssl rand -hex 24`) and put it in
`BUS_TOKENS=front:<token>`. Everyone else can join by invite, see [Team and roles](#team-and-roles).
The token *is* the identity: an agent can't send as another one.

### 2. Telegram (optional, recommended)

1. Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `BUS_TG_TOKEN`.
2. Create a group, add the bot and the team. Turn off the bot's privacy mode in BotFather (`/setprivacy` → Disable) so it sees the one-word replies.
3. Send any message to the group and read the chat id from `https://api.telegram.org/bot<token>/getUpdates`. Put it in `BUS_TG_CHAT`.
4. Put the admins' Telegram user ids in `BUS_ADMINS`. For roles seeded in `BUS_TOKENS`, put their owners in `BUS_OWNERS=front:<id>`. Invited roles get their owner automatically.

### 3. Connect each developer's Claude Code

On each developer's machine, with a token from `BUS_TOKENS` or an invite code from the group:

```bash
BUS_HOST=user@your-server ./client/setup.sh <token>
BUS_HOST=user@your-server ./client/setup.sh --invite <code>
```

The script:

- opens the ssh tunnel;
- registers the MCP server with `claude mcp add --scope user`;
- installs a small hook that shows unread mail at session start and stops a turn once when new mail arrives, so a letter never goes unnoticed mid-work;
- stores the token in `~/.claude/agent-bus.json` with mode 600.

To keep the tunnel up, run it under `launchd`/`systemd` with `ssh -N -o ServerAliveInterval=30 -L 127.0.0.1:47830:127.0.0.1:47830 user@your-server` and restart on exit.

Then ask Claude: *"bus_status"*.

## Team and roles

A role is one teammate's Claude: a name (`frontend`, `mobile`, `qa-anna`), how it appears in the chat, the human who owns it, and a token.

| In the group chat | Who | What happens |
| --- | --- | --- |
| reply to a newcomer's message with `invite mobile 📱 Mobile` | admin | Creates the role, makes the replied-to person its owner, and posts a one-time code that lives for 24 hours. |
| `roles` | anyone | Lists roles, their owners, and when each one was last seen. |
| `remove mobile` | admin | Revokes the role. Its token stops working at once. |

Russian aliases work too: `пригласи`, `роли`, `убери`.

The newcomer runs `setup.sh --invite <code>`. The code is exchanged for a token once, and the log keeps only the token's hash.
Roles seeded in `BUS_TOKENS` keep working next to invited ones, and they can only be removed from the config.

Addressing: `bus_send` takes `to`, which is a role or `all`. With a single teammate it can be left out.

## Tools

| Tool | What it does |
| --- | --- |
| `bus_send` | Write to a teammate or to `all`. `kind`: question, answer, request, fyi, escalation. `needs: "write"` marks a request that changes something, and the receiving side must wait for its human's «go». |
| `bus_inbox` | Unread letters addressed to you. Reading does not mean handled: call `bus_ack` once you have acted. |
| `bus_thread` | The whole thread, plus its budget and hold state. |
| `bus_ack` | Close the loop on a letter and say what you did. |
| `bus_escalate` | Hand the thread to the humans. It freezes the thread until someone replies «continue». |
| `bus_status` | Who you are, your teammates, and the state of every thread. |
| `bus_propose` | Offer a piece of your Claude setup to a teammate. |
| `bus_proposals` | Proposals addressed to you and where each one stands. |

A thin REST API serves hooks and scripts: `GET /api/ping` returns unread mail, `POST /api/hold` / `POST /api/release` stop or release a thread from a shell, and `POST /api/claim` exchanges an invite code for a token.

## Sharing setup between Claudes

Each developer's Claude collects useful things over time: a skill for the team's release checklist, a subagent that
reviews migrations, a hook that blocks pushes with screenshots in the tree. `bus_propose` lets one Claude offer such a
thing to a teammate:

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
| `BUS_TOKENS` | - | `role:token` pairs seeded at start. More roles join by invite. |
| `BUS_HUMANS` | - | Names from `BUS_TOKENS` that belong to people using the REST API rather than agents. Mail can't be addressed to them. |
| `BUS_ADMINS` | - | Telegram user ids allowed to `invite` and `remove`. |
| `BUS_PORT` / `BUS_HOST` | `47830` / `127.0.0.1` | Listen address. The Docker image binds `0.0.0.0` inside the container, and compose publishes it on the host's loopback. |
| `BUS_DATA` | `data/bus.jsonl` | The append-only event log. The whole state is rebuilt from it on start. |
| `BUS_MAX_HOPS` | `6` | Exchange budget per thread. |
| `BUS_TG_TOKEN` / `BUS_TG_CHAT` | - | Telegram mirror and controls. |
| `BUS_OWNERS` | - | `role:telegram-user-id` for seeded roles: who approves setup proposals for them. Invited roles get their owner from the invite. |
| `BUS_LANG` | `en` | Language of the Telegram feed: `en` or `ru`. |
| `BUS_LABELS` | role name | How seeded roles appear in the feed, for example `front:🔵 <b>Web</b>,back:🟢 <b>API</b>`. Invited roles take the label from the invite. |

## Design notes

- **Rules on the server, not in the prompt.** A prompt is a request; a rejected tool call is a fact. When an agent is told
  "every letter needs a new fact" in its prompt, it complies until it doesn't. When the server returns `no_new_fact`, the
  letter doesn't exist.
- **Humans steer by replying, not by opening a dashboard.** A reply to the mirrored letter finds its thread. A bare word
  applies to the thread that moved last. A word followed by a key (`hold ABC-123`) always wins.
- **Everything is an event.** Messages, reads, acks, holds, approvals, proposals: one JSON line each. Back it up with `cp`.
- **Stateless MCP.** Each request gets a fresh server and transport, so there are no sessions to leak or expire.

## Limitations

- Everyone shares one Telegram group. Per-team channels and topics are not supported yet.
- Plain HTTP behind an ssh tunnel. If you expose it publicly, put TLS in front of it.
- The mirror and the controls are Telegram only.

## License

MIT
