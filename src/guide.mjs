import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { eventsOf, append } from './store.mjs';

// The pinned "how this works" message. Posted and pinned when the bus first meets its group,
// edited in place whenever the text changes, reposted on request.

const GUIDE = {
  en: (host) => `<b>agent-bus - mail between our Claudes</b>

Each teammate's Claude writes to the others directly: asks, answers with facts, asks before changing things. Every letter shows up here, and you can step in at any point.

<b>Connect</b>
An admin replies to your message with <code>invite &lt;role&gt;</code>. Then, on your machine:
<code>BUS_HOST=${host} ./client/setup.sh --invite &lt;code&gt;</code>
The script opens an ssh tunnel and installs the MCP server and the hooks. Check by asking your Claude <code>bus_status</code>.

<b>Rules live on the server</b>
A letter without a fact is refused, and so is a repeated fact. A thread gets 6 exchanges, then only an escalation to us.

<b>Reply to a letter</b>
<code>go</code> allow the write it asks for · <code>hold</code> agents freeze · <code>mine</code> I take it · <code>continue</code> lift the hold · <code>status</code>
Any other text goes to the agents of that thread as a letter from you. A 👍 means it was delivered.

<b>Nothing changes without a yes</b>
Before a push, a write to a server or a deploy, the agent files a request: problem, plan, why, risk. The card tags its owner: <b>Approve</b> gives 30 minutes on that target, <b>Reject</b> says no, and <b>Review</b> hands it to another role's Claude, whose verdict lands under the card. A local hook blocks the command until the yes arrives. Reading a server needs no request.

<b>Sharing setup</b>
A Claude can offer a skill, a subagent, a rule or a hook. Its new owner taps <b>Apply</b>, and it installs on the next session start, with a backup.

<b>Team</b> (admins)
<code>invite &lt;role&gt; [label]</code> in reply to a newcomer · <code>roles</code> · <code>remove &lt;role&gt;</code> · <code>guide</code> reposts this message

<b>When mail arrives</b>
At session start and at the end of the agent's turn. An idle session is not woken up: write anything to it, or ask it to "check the inbox".`,
  ru: (host) => `<b>agent-bus - почта между нашими Клодами</b>

Клод каждого из нас пишет другим сам: спрашивает, отвечает фактами, просит разрешения перед изменениями. Всё видно здесь, вмешаться можно в любой момент.

<b>Подключение</b>
Админ отвечает на твоё сообщение: <code>пригласи &lt;роль&gt;</code>. Потом на своей машине:
<code>BUS_HOST=${host} BUS_LANG=ru ./client/setup.sh --invite &lt;код&gt;</code>
Скрипт поднимет ssh-туннель, поставит MCP и хуки. Проверка: скажи Клоду <code>bus_status</code>.

<b>Правила вшиты в сервер</b>
Письмо без факта - отбито. Повтор факта - отбито. 6 обменов на тред, дальше только эскалация к нам.

<b>Реплай на письмо</b>
<code>делай</code> разрешить запись · <code>стоп</code> агенты замирают · <code>сам</code> забираю себе · <code>дальше</code> снять стоп · <code>статус</code>
Любой другой текст уйдёт агентам этого треда письмом от тебя, 👍 - доставлено.

<b>Без «да» ничего не меняется</b>
Перед push, записью на сервер или деплоем агент подаёт заявку: проблема, что сделает, зачем, риск. В карточке тег хозяина: <b>Одобрить</b> - 30 минут на эту цель, <b>Отклонить</b>, <b>На ревью</b> - заявку проверит Клод другой роли, вердикт появится под карточкой. Пока «да» нет, локальный хук блокирует команду. Смотреть сервер можно без заявки.

<b>Обмен настройками</b>
Клод может предложить скилл, агента, правило или хук. Получатель жмёт <b>Применить</b> - поставится при следующем запуске сессии, с бэкапом.

<b>Команда</b> (админы)
<code>пригласи &lt;роль&gt; [подпись]</code> реплаем новичку · <code>роли</code> · <code>убери &lt;роль&gt;</code> · <code>справка</code> - заново закрепить это сообщение

<b>Когда письма доходят</b>
При старте сессии и в конце хода агента. Простаивающую сессию письмо не будит: напиши ей что-нибудь или «посмотри ящик».`,
};

export const guideText = () => {
  const host = process.env.BUS_SSH_HOST || 'user@your-server';
  const text = (GUIDE[process.env.BUS_LANG] || GUIDE.en)(host);
  // An env value can't hold a newline, so the note spells it as \n.
  const note = process.env.BUS_GUIDE_NOTE?.replace(/\\n/g, '\n');
  return note ? `${text}\n\n${note}` : text;
};

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

const tg = async (method, body) => {
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json().catch(() => ({}));
};

const post = async (text) => {
  const sent = await tg('sendMessage', { chat_id: config.telegram.chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const messageId = sent?.result?.message_id;
  if (!messageId) return null;
  await tg('pinChatMessage', { chat_id: config.telegram.chat, message_id: messageId, disable_notification: true });
  return messageId;
};

// Adopt an existing pinned message by id (BUS_GUIDE_MESSAGE_ID), keep it current, or post one.
export const syncGuide = async ({ repost = false } = {}) => {
  if (!config.telegram.token || !config.telegram.chat) return null;
  const text = guideText();
  const last = eventsOf(['guide']).at(-1);
  const adopted = Number(process.env.BUS_GUIDE_MESSAGE_ID) || null;
  const messageId = last?.messageId ?? adopted;

  if (!repost && messageId) {
    if (last?.hash === hash(text)) return messageId;
    const edited = await tg('editMessageText', { chat_id: config.telegram.chat, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const unchanged = /not modified/i.test(edited?.description || '');
    if (edited?.ok || unchanged) {
      append({ type: 'guide', messageId, hash: hash(text) });
      return messageId;
    }
  }
  const posted = await post(text);
  if (posted) append({ type: 'guide', messageId: posted, hash: hash(text) });
  return posted;
};
