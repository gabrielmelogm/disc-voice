import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Channel, ChatMessage, User } from "@disc-voice/shared";
import { History, MessageSquareText, Plus, SendHorizontal, Smile } from "lucide-react";
import { TYPING_INTERVAL, typingLabel, useTyping } from "../hooks/useTyping";
import { api, message } from "../lib/api";
import { dayLabel, messageTime } from "../lib/display";
import type { Realtime } from "../lib/realtime";
import { Attachments, ImageThumb, imageLinks, MediaViewer, MessageText, type Media } from "./MessageContent";
import { ProfileButton } from "./ProfileCard";
import { Avatar } from "./ui";

const GROUP_WINDOW = 7 * 60_000;

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const unique = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => unique.set(item.id, item));
  return [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

interface Pending { clientId: string; content: string; error: string; sending: boolean }

function focused() {
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/**
 * `focusId`: open the history at this message and highlight it.
 * `onRead`: called with the newest message while the user can see it (window
 * focused and the list scrolled to the bottom).
 * `peer`: the other person, when the channel is a direct conversation.
 */
export function TextChannel({ channel, realtime, revision, self, focusId, onRead, peer }: {
  channel: Channel; realtime: Realtime; revision: number; self?: User; focusId?: string;
  onRead?: (messageId: string) => void; peer?: User;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [older, setOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const cursor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pinBottom = useRef(true);
  const preserve = useRef<{ height: number; top: number } | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const inFlight = useRef(new Set<string>());
  // Scroll to the focused message once it is rendered.
  const scrollToFocus = useRef(!!focusId);
  const typing = useTyping(realtime, channel.id, self?.id);
  const lastTyping = useRef(0);
  const newest = useRef<string | undefined>(undefined);
  const reader = useRef(onRead);
  reader.current = onRead;

  /** Reports the newest message as read when the user can actually see it. */
  const reportRead = useRef(() => {
    const id = newest.current;
    if (id && pinBottom.current && document.visibilityState !== "hidden" && focused()) reader.current?.(id);
  }).current;

  useEffect(() => {
    const visible = () => reportRead();
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [reportRead]);

  const accept = (incoming: ChatMessage[]) => {
    setMessages(current => mergeMessages(current, incoming));
    const ids = new Set(incoming.map(item => item.clientId));
    setPending(current => current.filter(item => !ids.has(item.clientId)));
  };

  const [viewing, setViewing] = useState<Media | null>(null);
  // Imported from Discord: messages arrive in batches as the import advances.
  const importedCount = useRef<number | null>(null);
  useEffect(() => realtime.onEvent(event => {
    if (event.type === "discord.import" && event.import.channelId === channel.id && event.import.imported !== importedCount.current) {
      importedCount.current = event.import.imported;
      // Still empty: load the latest page instead of replaying everything.
      if (cursor.current === "0") cursor.current = null;
      setRetry(n => n + 1);
    }
    if (event.type === "message.created" && event.message.channelId === channel.id) accept([event.message]);
    // Existing messages show the author's current name.
    if (event.type === "user.updated") {
      setMessages(current => current.some(item => item.author.id === event.user.id)
        ? current.map(item => item.author.id === event.user.id ? { ...item, author: event.user } : item) : current);
    }
  }), [realtime, channel.id]);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
    void (async () => {
      // The REST watermark is deliberately independent of live events. On
      // reconnect, replay from this point so a missed event cannot be skipped.
      const initial = !cursor.current;
      if (initial) {
        // A focused message opens the page that ends with it, then catches up below.
        const page = await api.messages(channel.id, focusId ? { before: (BigInt(focusId) + 1n).toString() } : {}, controller.signal);
        if (controller.signal.aborted) return;
        accept(page.messages);
        setHasMore(page.hasMore);
        cursor.current = page.messages.at(-1)?.id || "0";
      }
      if (!initial || focusId) {
        let more = true;
        while (more && !controller.signal.aborted) {
          const page = await api.messages(channel.id, { after: cursor.current! }, controller.signal);
          if (controller.signal.aborted) return;
          accept(page.messages);
          cursor.current = page.messages.at(-1)?.id || cursor.current;
          more = page.hasMore;
        }
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [channel.id, revision, retry]);

  useEffect(() => () => olderRequest.current?.abort(), []);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const focused = scrollToFocus.current ? element.querySelector<HTMLElement>(`[data-message-id="${focusId}"]`) : null;
    if (focused) {
      scrollToFocus.current = false;
      pinBottom.current = false;
      focused.scrollIntoView?.({ block: "center" });
    } else if (preserve.current) {
      element.scrollTop = preserve.current.top + element.scrollHeight - preserve.current.height;
      preserve.current = null;
    } else if (pinBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, pending]);

  useEffect(() => {
    newest.current = messages.at(-1)?.id;
    reportRead();
  }, [messages, reportRead]);

  async function loadOlder() {
    if (older || !messages[0]) return;
    setOlder(true);
    const controller = new AbortController();
    olderRequest.current = controller;
    try {
      const page = await api.messages(channel.id, { before: messages[0].id }, controller.signal);
      if (controller.signal.aborted) return;
      if (list.current) preserve.current = { height: list.current.scrollHeight, top: list.current.scrollTop };
      accept(page.messages);
      setHasMore(page.hasMore);
      setError("");
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setOlder(false); }
  }

  async function send(item: Pending) {
    if (inFlight.current.has(item.clientId)) return;
    inFlight.current.add(item.clientId);
    setPending(current => current.map(p => p.clientId === item.clientId ? { ...p, sending: true, error: "" } : p));
    try { accept([await api.sendMessage(channel.id, item.clientId, item.content)]); }
    catch (cause) {
      setPending(current => current.map(p => p.clientId === item.clientId ? { ...p, sending: false, error: message(cause) } : p));
    } finally { inFlight.current.delete(item.clientId); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    const item: Pending = { clientId: crypto.randomUUID(), content: content.trim(), sending: true, error: "" };
    setPending(current => [...current, item]);
    setContent("");
    pinBottom.current = true;
    // The next message starts a new announcement right away.
    lastTyping.current = 0;
    void send(item);
  }

  function type(value: string) {
    setContent(value);
    const now = Date.now();
    if (!value.trim() || now - lastTyping.current < TYPING_INTERVAL) return;
    lastTyping.current = now;
    // Offline: nobody would see it anyway.
    try { realtime.send({ type: "typing.start", channelId: channel.id }); } catch { /* not connected */ }
  }

  const welcome = !messages.length && !loading && !hasMore;
  const imported = channel.source === "discord";
  const importing = imported && !!channel.readOnly;
  const typingText = typingLabel(typing);
  return <section className="text-chat" aria-label={peer ? `Conversa com ${peer.name}` : `Chat de texto ${channel.name}`}>
    {error && <div className="chat-error" role="alert">{error} <button className="link-button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>}
    <div ref={list} className="message-list" role="log" aria-label="Mensagens" aria-live="polite" onScroll={() => {
      const element = list.current!;
      pinBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      reportRead();
    }}>
      {hasMore && <button className="button secondary history-button" disabled={older} onClick={() => void loadOlder()}>{older ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {loading && <p className="chat-status" role="status">Sincronizando mensagens…</p>}
      {welcome && (importing
        ? <div className="chat-welcome"><span className="welcome-icon"><History size={28} /></span><h2>#{channel.name} vem do Discord</h2><p>As mensagens aparecem aqui conforme a importação avança.</p></div>
        : peer ? <div className="chat-welcome"><Avatar name={peer.name} src={peer.avatar} size="xl" /><h2>{peer.name}</h2><p>Esse é o começo da sua conversa com {peer.name}.</p></div>
        : <div className="chat-welcome"><span className="welcome-icon"><MessageSquareText size={28} /></span><h2>Bem-vindo a #{channel.name}</h2><p>Esse é o começo da conversa. Diga oi para sua comunidade.</p></div>)}
      {messages.map((item, index) => {
        const previous = messages[index - 1];
        const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
        const grouped = !!previous && !newDay && previous.author.id === item.author.id
          && new Date(item.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW;
        return <Fragment key={item.id}>
          {newDay && <div className="day-divider" role="separator"><span>{dayLabel(item.createdAt)}</span></div>}
          <article data-message-id={item.id} className={`chat-message ${grouped ? "grouped" : ""} ${item.id === focusId ? "is-focused" : ""}`}>
            {grouped ? <span className="message-gutter" /> : <ProfileButton user={item.author} className="avatar-trigger" title={`Perfil de ${item.author.name}`}><Avatar name={item.author.name} src={item.author.avatar} /></ProfileButton>}
            <div className="message-body">
              {!grouped && <div className="message-meta"><strong><ProfileButton user={item.author} /></strong>{item.discordId && <span className="source-tag" title="Mensagem importada do Discord">Discord</span>}<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString("pt-BR")}>{messageTime(item.createdAt)}</time></div>}
              {item.content ? <MessageText text={item.content} /> : !item.attachments?.length && <p className="muted"><em>Mensagem sem texto</em></p>}
              {item.content && imageLinks(item.content).map(url => <ImageThumb key={url} url={url} name={url.split("/").pop() || "imagem"} onView={setViewing} />)}
              {!!item.attachments?.length && <Attachments files={item.attachments} onView={setViewing} />}
            </div>
          </article>
        </Fragment>;
      })}
      {pending.map(item => <article className="chat-message pending-message" key={item.clientId}>
        <Avatar name={self?.name || "Você"} src={self?.avatar} />
        <div className="message-body">
          <div className="message-meta"><strong>Você</strong><span>{item.sending ? "Enviando…" : "Não enviada"}</span></div><MessageText text={item.content} />
          {item.error && <div className="message-error" role="alert">{item.error} <button className="link-button" onClick={() => void send(item)}>Reenviar</button></div>}
        </div>
      </article>)}
    </div>
    {viewing && <MediaViewer media={viewing} onClose={() => setViewing(null)} />}
    {importing ? <p className="composer read-only-notice" role="note"><History size={16} aria-hidden="true" />Importando o histórico do Discord. Você poderá enviar mensagens aqui quando a importação terminar.</p> : <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="message-content">{peer ? `Mensagem para ${peer.name}` : `Mensagem em #${channel.name}`}</label>
      <textarea id="message-content" placeholder={peer ? `Conversar com ${peer.name}` : `Escrever em ${channel.name}`} maxLength={4000} value={content} rows={1}
        onChange={event => type(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-actions">
        {/* Attachments and emoji are designed but not implemented yet. */}
        <button type="button" className="icon-button" disabled aria-label="Anexar arquivo (em breve)" title="Anexos em breve"><Plus size={18} /></button>
        <button type="button" className="icon-button" disabled aria-label="Inserir emoji (em breve)" title="Emojis em breve"><Smile size={18} /></button>
        {/* Who is typing takes the hint's place, so the composer never jumps. */}
        <span className="composer-hint" aria-live="polite">{typingText
          ? <span className="typing-indicator"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingText}</span>
          : "Enter para enviar · Shift+Enter para nova linha"}</span>
        <button className="button primary small" type="submit" disabled={!content.trim()} aria-label="Enviar mensagem"><SendHorizontal size={16} />Enviar</button>
      </div>
    </form>}
  </section>;
}
