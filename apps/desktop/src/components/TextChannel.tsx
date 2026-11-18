import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Channel, ChatMessage, User } from "@disc-voice/shared";
import { MessageSquareText, Plus, SendHorizontal, Smile } from "lucide-react";
import { api, message } from "../lib/api";
import { dayLabel, messageTime } from "../lib/display";
import type { Realtime } from "../lib/realtime";
import { Avatar } from "./ui";

const GROUP_WINDOW = 7 * 60_000;

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const unique = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => unique.set(item.id, item));
  return [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

interface Pending { clientId: string; content: string; error: string; sending: boolean }

export function TextChannel({ channel, realtime, revision, self }: { channel: Channel; realtime: Realtime; revision: number; self?: User }) {
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

  const accept = (incoming: ChatMessage[]) => {
    setMessages(current => mergeMessages(current, incoming));
    const ids = new Set(incoming.map(item => item.clientId));
    setPending(current => current.filter(item => !ids.has(item.clientId)));
  };

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "message.created" && event.message.channelId === channel.id) accept([event.message]);
  }), [realtime, channel.id]);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoading(true);
    void (async () => {
      // The REST watermark is deliberately independent of live events. On
      // reconnect, replay from this point so a missed event cannot be skipped.
      if (!cursor.current) {
        const page = await api.messages(channel.id, {}, controller.signal);
        if (controller.signal.aborted) return;
        accept(page.messages);
        setHasMore(page.hasMore);
        cursor.current = page.messages.at(-1)?.id || "0";
      } else {
        let more = true;
        while (more && !controller.signal.aborted) {
          const page = await api.messages(channel.id, { after: cursor.current }, controller.signal);
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
    if (preserve.current) {
      element.scrollTop = preserve.current.top + element.scrollHeight - preserve.current.height;
      preserve.current = null;
    } else if (pinBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, pending]);

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
    void send(item);
  }

  const welcome = !messages.length && !loading && !hasMore;
  return <section className="text-chat" aria-label={`Chat de texto ${channel.name}`}>
    {error && <div className="chat-error" role="alert">{error} <button className="link-button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>}
    <div ref={list} className="message-list" role="log" aria-label="Mensagens" aria-live="polite" onScroll={() => {
      const element = list.current!;
      pinBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
      {hasMore && <button className="button secondary history-button" disabled={older} onClick={() => void loadOlder()}>{older ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {loading && <p className="chat-status" role="status">Sincronizando mensagens…</p>}
      {welcome && <div className="chat-welcome"><span className="welcome-icon"><MessageSquareText size={28} /></span><h2>Bem-vindo a #{channel.name}</h2><p>Esse é o começo da conversa. Diga oi para sua comunidade.</p></div>}
      {messages.map((item, index) => {
        const previous = messages[index - 1];
        const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
        const grouped = !!previous && !newDay && previous.author.id === item.author.id
          && new Date(item.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW;
        return <Fragment key={item.id}>
          {newDay && <div className="day-divider" role="separator"><span>{dayLabel(item.createdAt)}</span></div>}
          <article className={`chat-message ${grouped ? "grouped" : ""}`}>
            {grouped ? <span className="message-gutter" /> : <Avatar name={item.author.name} />}
            <div className="message-body">
              {!grouped && <div className="message-meta"><strong title={item.author.email}>{item.author.name}</strong><time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString("pt-BR")}>{messageTime(item.createdAt)}</time></div>}
              <p>{item.content}</p>
            </div>
          </article>
        </Fragment>;
      })}
      {pending.map(item => <article className="chat-message pending-message" key={item.clientId}>
        <Avatar name={self?.name || "Você"} />
        <div className="message-body">
          <div className="message-meta"><strong>Você</strong><span>{item.sending ? "Enviando…" : "Não enviada"}</span></div><p>{item.content}</p>
          {item.error && <div className="message-error" role="alert">{item.error} <button className="link-button" onClick={() => void send(item)}>Reenviar</button></div>}
        </div>
      </article>)}
    </div>
    <form className="composer" onSubmit={submit}>
      <label className="sr-only" htmlFor="message-content">Mensagem em #{channel.name}</label>
      <textarea id="message-content" placeholder={`Escrever em ${channel.name}`} maxLength={4000} value={content} rows={1}
        onChange={event => setContent(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-actions">
        {/* Attachments and emoji are designed but not implemented yet. */}
        <button type="button" className="icon-button" disabled aria-label="Anexar arquivo (em breve)" title="Anexos em breve"><Plus size={18} /></button>
        <button type="button" className="icon-button" disabled aria-label="Inserir emoji (em breve)" title="Emojis em breve"><Smile size={18} /></button>
        <span className="composer-hint">Enter para enviar · Shift+Enter para nova linha</span>
        <button className="button primary small" type="submit" disabled={!content.trim()} aria-label="Enviar mensagem"><SendHorizontal size={16} />Enviar</button>
      </div>
    </form>
  </section>;
}
