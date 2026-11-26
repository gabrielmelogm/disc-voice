import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import type { Channel, ChatMessage, CloudFile, GifChoice, MemberRole, User } from "@disc-voice/shared";
import { FileText, History, MessageSquareText, Plus, SendHorizontal, Smile, Upload, X } from "lucide-react";
import { TYPING_INTERVAL, typingLabel, useTyping } from "../hooks/useTyping";
import { api, message } from "../lib/api";
import { dayLabel, messageTime } from "../lib/display";
import { fileProblem, MAX_FILES_PER_MESSAGE, uploadFile } from "../lib/files";
import type { Realtime } from "../lib/realtime";
import { GifImage, GifPicker } from "./GifPicker";
import { Attachments, fileSize, ImageThumb, imageLinks, MediaViewer, MessageText, type Media } from "./MessageContent";
import { RoleBadge } from "./Members";
import { ProfileButton } from "./ProfileCard";
import { Avatar } from "./ui";

const GROUP_WINDOW = 7 * 60_000;

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const unique = new Map(current.map(item => [item.id, item]));
  incoming.forEach(item => unique.set(item.id, item));
  return [...unique.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
}

interface Pending { clientId: string; content: string; gif?: GifChoice; files?: CloudFile[]; error: string; sending: boolean }

/** A file chosen in the composer: uploads to the user's space right away. */
interface Draft { key: string; name: string; size: number; preview?: string; progress: number; uploaded?: CloudFile; error?: string }

/**
 * Files on the clipboard. A screenshot may come only as a clipboard item, and
 * is always called `image.png`: it gets a name with the date and time.
 */
export function clipboardFiles(data: DataTransfer | null, now = new Date()): File[] {
  if (!data) return [];
  let files = Array.from(data.files || []);
  if (!files.length) {
    files = Array.from(data.items || []).filter(item => item.kind === "file")
      .map(item => item.getAsFile()).filter((file): file is File => !!file);
  }
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-")
    + " " + [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join(".");
  return files.map((file, index) => {
    if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
    const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const suffix = files.length > 1 ? ` (${index + 1})` : "";
    return new File([file], `Captura de tela ${stamp}${suffix}.${extension}`, { type: file.type, lastModified: file.lastModified });
  });
}

/** Whether a drag carries files (not text or a link). */
function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

function focused() {
  return typeof document.hasFocus === "function" ? document.hasFocus() : true;
}

/**
 * `focusId`: open the history at this message and highlight it.
 * `onRead`: called with the newest message while the user can see it (window
 * focused and the list scrolled to the bottom).
 * `peer`: the other person, when the channel is a direct conversation.
 * `roles`: server roles by user id, shown as a badge next to the author.
 * `room`: the chat of a voice room, in the narrow panel next to the call.
 */
export function TextChannel({ channel, realtime, revision, self, focusId, onRead, peer, roles, room = false }: {
  channel: Channel; realtime: Realtime; revision: number; self?: User; focusId?: string;
  onRead?: (messageId: string) => void; peer?: User; roles?: Record<string, MemberRole>; room?: boolean;
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
  const [gifOpen, setGifOpen] = useState(false);
  const closeGifs = useCallback(() => setGifOpen(false), []);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [fileError, setFileError] = useState("");
  const [dragging, setDragging] = useState(false);
  const uploads = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());
  // Leaving the channel cancels uploads still running and frees the previews.
  useEffect(() => () => {
    uploads.current.forEach(controller => controller.abort());
    previews.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

  // Ctrl+V with the focus anywhere but a field (after clicking a message,
  // say) still attaches what is on the clipboard, like a screenshot.
  const attachFromClipboard = useRef<((files: File[]) => void) | null>(null);
  useEffect(() => {
    const paste = (event: globalThis.ClipboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const editable = target?.closest("input, textarea, select, [contenteditable='true']");
      if (event.defaultPrevented || editable || document.querySelector("dialog[open]") || !attachFromClipboard.current) return;
      const files = clipboardFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      attachFromClipboard.current(files);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, []);

  function addFiles(files: File[]) {
    if (!files.length) return;
    const problems: string[] = [];
    const room = MAX_FILES_PER_MESSAGE - drafts.length;
    if (files.length > room) problems.push(`Envie no máximo ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`);
    const accepted = files.slice(0, Math.max(0, room)).filter(file => {
      const problem = fileProblem(file);
      if (problem) problems.push(problem);
      return !problem;
    });
    setFileError(problems.join(" "));
    const added = accepted.map(file => {
      const preview = /^image\/(png|jpeg|gif|webp|avif)$/.test(file.type) ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      return { draft: { key: crypto.randomUUID(), name: file.name, size: file.size, preview, progress: 0 } as Draft, file };
    });
    setDrafts(current => [...current, ...added.map(item => item.draft)]);
    for (const { draft, file } of added) {
      const controller = new AbortController();
      uploads.current.set(draft.key, controller);
      const update = (changes: Partial<Draft>) => setDrafts(current => current.map(d => d.key === draft.key ? { ...d, ...changes } : d));
      uploadFile(file, progress => update({ progress }), controller.signal)
        .then(uploaded => update({ uploaded, progress: 1 }))
        .catch(cause => { if (!controller.signal.aborted) update({ error: message(cause) }); })
        .finally(() => uploads.current.delete(draft.key));
    }
    textarea.current?.focus();
  }

  function removeDraft(draft: Draft) {
    uploads.current.get(draft.key)?.abort();
    if (draft.preview) { URL.revokeObjectURL(draft.preview); previews.current.delete(draft.preview); }
    setDrafts(current => current.filter(d => d.key !== draft.key));
    setFileError("");
  }

  const uploading = drafts.some(d => !d.uploaded && !d.error);
  const failed = drafts.some(d => d.error);
  const ready = drafts.length > 0 && !uploading && !failed;
  const canSend = !uploading && !failed && (!!content.trim() || ready);
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
    try {
      const sent = item.files?.length ? api.sendMessage(channel.id, item.clientId, item.content, undefined, item.files.map(file => file.id))
        : item.gif ? api.sendMessage(channel.id, item.clientId, item.content, item.gif) : api.sendMessage(channel.id, item.clientId, item.content);
      accept([await sent]);
    }
    catch (cause) {
      setPending(current => current.map(p => p.clientId === item.clientId ? { ...p, sending: false, error: message(cause) } : p));
    } finally { inFlight.current.delete(item.clientId); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    const files = drafts.flatMap(d => d.uploaded ? [d.uploaded] : []);
    const item: Pending = { clientId: crypto.randomUUID(), content: content.trim(), ...(files.length ? { files } : {}), sending: true, error: "" };
    setPending(current => [...current, item]);
    setContent("");
    drafts.forEach(d => { if (d.preview) { URL.revokeObjectURL(d.preview); previews.current.delete(d.preview); } });
    setDrafts([]);
    setFileError("");
    pinBottom.current = true;
    // The next message starts a new announcement right away.
    lastTyping.current = 0;
    void send(item);
  }

  /** Sends the GIF chosen in the picker on its own; the text being typed stays. */
  function sendGif(gif: GifChoice) {
    setGifOpen(false);
    const item: Pending = { clientId: crypto.randomUUID(), content: "", gif, sending: true, error: "" };
    setPending(current => [...current, item]);
    pinBottom.current = true;
    void send(item);
    textarea.current?.focus();
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
  const typingIndicator = typingText && <span className="typing-indicator"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingText}</span>;
  const enterToSend = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault(); event.currentTarget.form?.requestSubmit();
    }
  };
  const gifButton = <button type="button" className={`icon-button gif-button ${gifOpen ? "active" : ""}`} aria-label="Enviar um GIF" title="GIFs"
    aria-haspopup="dialog" aria-expanded={gifOpen} onPointerDown={event => { if (gifOpen) event.stopPropagation(); }}
    onClick={() => setGifOpen(open => !open)}>GIF</button>;
  const gifPicker = gifOpen && <GifPicker className={room ? "narrow" : ""} label="Enviar um GIF" onPick={sendGif} onClose={closeGifs} />;
  const attachButton = <button type="button" className={`icon-button ${room ? "attach-button" : ""}`} aria-label="Anexar arquivos" title="Anexar arquivos (até 15 MB cada)"
    disabled={drafts.length >= MAX_FILES_PER_MESSAGE} onClick={() => picker.current?.click()}><Plus size={18} /></button>;
  const fileInput = <input ref={picker} type="file" multiple hidden data-testid="file-input" tabIndex={-1} aria-hidden="true"
    onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = ""; }} />;
  const draftList = (drafts.length > 0 || fileError) && <div className="composer-files">
    {fileError && <p className="composer-file-error" role="alert">{fileError}</p>}
    {drafts.length > 0 && <ul aria-label="Arquivos para enviar">
      {drafts.map(draft => {
        const sending = !draft.uploaded && !draft.error;
        const percent = Math.round(draft.progress * 100);
        return <li key={draft.key} className={`draft-file ${draft.error ? "failed" : ""} ${sending ? "sending" : ""}`}>
        <span className="draft-media">
          {draft.preview ? <img src={draft.preview} alt="" /> : <span className="draft-icon"><FileText size={20} aria-hidden="true" /></span>}
          {sending && <span className="draft-percent" aria-hidden="true">{percent}%</span>}
        </span>
        <span className="draft-text">
          <strong title={draft.name}>{draft.name}</strong>
          <small>{draft.error || (draft.uploaded ? `${fileSize(draft.size)} · pronto` : `Enviando… ${percent}% de ${fileSize(draft.size)}`)}</small>
          {sending && <span className="upload-bar" role="progressbar" aria-label={`Enviando ${draft.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${Math.max(percent, 2)}%` }} />
          </span>}
        </span>
        <button type="button" className="icon-button" aria-label={sending ? `Cancelar envio de ${draft.name}` : `Remover ${draft.name}`} title={sending ? "Cancelar envio" : "Remover"} onClick={() => removeDraft(draft)}><X size={16} /></button>
      </li>;
      })}
    </ul>}
  </div>;
  const canAttach = !importing;
  const dragProps = canAttach ? {
    onDragEnter: (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); setDragging(true); } },
    onDragOver: (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      addFiles(Array.from(event.dataTransfer.files));
    },
  } : {};
  const pasteFiles = (event: ClipboardEvent) => {
    const files = clipboardFiles(event.clipboardData);
    if (files.length) { event.preventDefault(); addFiles(files); }
  };
  attachFromClipboard.current = canAttach ? addFiles : null;
  return <section className={`text-chat ${room ? "room" : ""}`} aria-label={room ? `Mensagens da sala ${channel.name}` : peer ? `Conversa com ${peer.name}` : `Chat de texto ${channel.name}`} {...dragProps}>
    {dragging && <div className="drop-overlay" aria-hidden="true"><Upload size={32} /><strong>Solte para anexar</strong><span>Até {MAX_FILES_PER_MESSAGE} arquivos de 15 MB cada</span></div>}
    {error && <div className="chat-error" role="alert">{error} <button className="link-button" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></div>}
    <div ref={list} className="message-list" role="log" aria-label="Mensagens" aria-live="polite" onScroll={() => {
      const element = list.current!;
      pinBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      reportRead();
    }}>
      {hasMore && <button className="button secondary history-button" disabled={older} onClick={() => void loadOlder()}>{older ? "Carregando…" : "Carregar mensagens anteriores"}</button>}
      {loading && <p className="chat-status" role="status">Sincronizando mensagens…</p>}
      {welcome && (room
        ? <div className="chat-welcome room-welcome"><MessageSquareText size={26} /><p>Compartilhe links e converse sem microfone. As mensagens ficam na sala para quem entrar depois.</p></div>
        : importing
        ? <div className="chat-welcome"><span className="welcome-icon"><History size={28} /></span><h2>#{channel.name} vem do Discord</h2><p>As mensagens aparecem aqui conforme a importação avança.</p></div>
        : peer ? <div className="chat-welcome"><Avatar name={peer.name} src={peer.avatar} still={peer.avatarStill} size="xl" /><h2>{peer.name}</h2><p>Esse é o começo da sua conversa com {peer.name}.</p></div>
        : <div className="chat-welcome"><span className="welcome-icon"><MessageSquareText size={28} /></span><h2>Bem-vindo a #{channel.name}</h2><p>Esse é o começo da conversa. Diga oi para sua comunidade.</p></div>)}
      {messages.map((item, index) => {
        const previous = messages[index - 1];
        const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(item.createdAt).toDateString();
        const grouped = !!previous && !newDay && previous.author.id === item.author.id
          && new Date(item.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUP_WINDOW;
        return <Fragment key={item.id}>
          {newDay && <div className="day-divider" role="separator"><span>{dayLabel(item.createdAt)}</span></div>}
          <article data-message-id={item.id} className={`chat-message ${grouped ? "grouped" : ""} ${item.id === focusId ? "is-focused" : ""}`}>
            {grouped ? <span className="message-gutter" /> : <ProfileButton user={item.author} className="avatar-trigger" title={`Perfil de ${item.author.name}`}><Avatar name={item.author.name} src={item.author.avatar} still={item.author.avatarStill} /></ProfileButton>}
            <div className="message-body">
              {!grouped && <div className="message-meta"><strong><ProfileButton user={item.author} /></strong><RoleBadge role={roles?.[item.author.id]} />{item.discordId && <span className="source-tag" title="Mensagem importada do Discord">Discord</span>}<time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString("pt-BR")}>{messageTime(item.createdAt)}</time></div>}
              {item.content ? <MessageText text={item.content} /> : !item.attachments?.length && <p className="muted"><em>Mensagem sem texto</em></p>}
              {item.content && imageLinks(item.content).map(url => <ImageThumb key={url} url={url} name={url.split("/").pop() || "imagem"} onView={setViewing} />)}
              {!!item.attachments?.length && <Attachments files={item.attachments} onView={setViewing} />}
            </div>
          </article>
        </Fragment>;
      })}
      {pending.map(item => <article className="chat-message pending-message" key={item.clientId}>
        <Avatar name={self?.name || "Você"} src={self?.avatar} still={self?.avatarStill} />
        <div className="message-body">
          <div className="message-meta"><strong>Você</strong><span>{item.sending ? "Enviando…" : "Não enviada"}</span></div>
          {item.content && <MessageText text={item.content} />}
          {item.gif && <figure className="message-gif"><GifImage url={item.gif.url} still={item.gif.still} alt={item.gif.title || "GIF"} /></figure>}
          {item.files && <ul className="pending-files">{item.files.map(file => <li key={file.id}><FileText size={14} aria-hidden="true" />{file.name}</li>)}</ul>}
          {item.error && <div className="message-error" role="alert">{item.error} <button className="link-button" onClick={() => void send(item)}>Reenviar</button></div>}
        </div>
      </article>)}
    </div>
    {viewing && <MediaViewer media={viewing} onClose={() => setViewing(null)} />}
    {room ? <form className="composer room-composer" onSubmit={submit}>
      {gifPicker}
      {fileInput}
      {draftList}
      {/* Who is typing shows above the field, which stays a single line. */}
      <span className="composer-hint" aria-live="polite">{typingIndicator}</span>
      <label className="sr-only" htmlFor="room-message">Mensagem para o chat da sala</label>
      <div className="room-input">
        {attachButton}
        <textarea ref={textarea} id="room-message" placeholder={`Escrever em ${channel.name}`} maxLength={4000} value={content} rows={1}
          onChange={event => type(event.target.value)} onKeyDown={enterToSend} onPaste={pasteFiles} />
        {gifButton}
      </div>
      <button className="sr-only" type="submit" disabled={!canSend}>Enviar mensagem</button>
    </form>
    : importing ? <p className="composer read-only-notice" role="note"><History size={16} aria-hidden="true" />Importando o histórico do Discord. Você poderá enviar mensagens aqui quando a importação terminar.</p> : <form className="composer" onSubmit={submit}>
      {gifPicker}
      {fileInput}
      {draftList}
      <label className="sr-only" htmlFor="message-content">{peer ? `Mensagem para ${peer.name}` : `Mensagem em #${channel.name}`}</label>
      <textarea ref={textarea} id="message-content" placeholder={peer ? `Conversar com ${peer.name}` : `Escrever em ${channel.name}`} maxLength={4000} value={content} rows={1}
        onChange={event => type(event.target.value)} onKeyDown={enterToSend} onPaste={pasteFiles} />
      <div className="composer-actions">
        {attachButton}
        {/* Emoji is designed but not implemented yet. */}
        <button type="button" className="icon-button" disabled aria-label="Inserir emoji (em breve)" title="Emojis em breve"><Smile size={18} /></button>
        {gifButton}
        {/* Who is typing takes the hint's place, so the composer never jumps. */}
        <span className="composer-hint" aria-live="polite">{typingIndicator || (uploading ? "Aguardando o envio dos arquivos…" : "Enter para enviar · Shift+Enter para nova linha")}</span>
        <button className="button primary small" type="submit" disabled={!canSend} aria-label="Enviar mensagem"><SendHorizontal size={16} />Enviar</button>
      </div>
    </form>}
  </section>;
}
