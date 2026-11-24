import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Download, ExternalLink, IdCard, KeyRound, Link2, LogOut, Mic, Palette, Search, Upload, UserRound, X, type LucideIcon } from "lucide-react";
import type { BannerColor, DiscordStatus, User } from "@disc-voice/shared";
import { DeviceSettings } from "../DeviceSettings";
import { api, message } from "../lib/api";
import { maskEmail } from "../lib/display";
import { openExternal } from "../lib/external";
import type { Realtime } from "../lib/realtime";
import { requestDesktopPermission, useNotificationPrefs } from "../lib/notifications";
import { useTraySupported, useWindowPrefs } from "../lib/tray";
import { useShowCallOnDiscord } from "../lib/discordPresence";
import {
  addTheme, fetchTheme, MAX_THEME_BYTES, parseTheme, removeTheme, resolveTheme, THEME_EXAMPLE, THEME_TOKENS, ThemeError,
  themeById, useAppearance, useThemes, type Appearance, type CustomTheme,
} from "../lib/theme";
import { BANNER_COLORS, bannerColor, ProfileSummary } from "./ProfileCard";
import { Avatar, RadioCards, SoonTag, Switch } from "./ui";

export type SettingsPage = "overview" | "voice" | "profile" | "connections" | "themes";

const pages: { id: SettingsPage; label: string; icon: LucideIcon; keywords: string }[] = [
  { id: "overview", label: "Visão geral", icon: UserRound, keywords: "conta e-mail login aparência idioma notificações janela bandeja segundo plano fechar excluir" },
  { id: "profile", label: "Perfil", icon: IdCard, keywords: "nome pronomes avatar banner sobre mim" },
  { id: "connections", label: "Conexões", icon: Link2, keywords: "discord conta vincular atividade jogo jogando música presença privacidade" },
  { id: "voice", label: "Voz e vídeo", icon: Mic, keywords: "microfone saída áudio câmera webcam tela compartilhar" },
  { id: "themes", label: "Temas", icon: Palette, keywords: "cores claro escuro sistema importar aparência" },
];

const appearanceOptions: { value: Appearance; label: string }[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
  { value: "system", label: "Igual ao sistema" },
];

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");

/** User settings, in a floating dialog over the app. */
export function Settings({ user, page, onPage, onClose, onLogout, leaving, error, inCall, callDevices, onUserChange, realtime }: {
  user: User;
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onClose: () => void;
  onLogout: () => void;
  leaving: boolean;
  error: string;
  inCall: boolean;
  callDevices: ReactNode;
  onUserChange: (user: User) => void;
  /** Live updates, e.g. when a Discord account finishes linking. */
  realtime?: Realtime;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const main = useRef<HTMLElement>(null);
  const [filter, setFilter] = useState("");
  const title = pages.find(item => item.id === page)!.label;
  const terms = normalize(filter).split(/\s+/).filter(Boolean);
  const visible = pages.filter(item => terms.every(term => normalize(`${item.label} ${item.keywords}`).includes(term)));

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // Each page starts at the top.
  useEffect(() => { main.current?.scrollTo?.(0, 0); }, [page]);

  return <dialog ref={ref} className="settings-dialog" aria-labelledby="settings-title"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onClick={event => { if (event.target === ref.current) onClose(); }}>
    <header className="settings-titlebar">
      <h2 id="settings-title">Configurações</h2>
      <button className="icon-button" aria-label="Fechar configurações" title="Fechar (Esc)" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="settings-shell">
      <nav className="settings-nav" aria-label="Configurações">
        <div className="search-field settings-search">
          <Search size={16} />
          <input className="search-input" type="search" aria-label="Buscar nas configurações" placeholder="Buscar" value={filter}
            onChange={event => setFilter(event.target.value)}
            onKeyDown={event => { if (event.key === "Enter" && visible[0]) onPage(visible[0].id); }} />
        </div>
        {visible.map(item => <button key={item.id} className={`settings-link ${page === item.id ? "selected" : ""}`} aria-current={page === item.id ? "page" : undefined} onClick={() => onPage(item.id)}>
          <item.icon size={18} />{item.label}
        </button>)}
        {!visible.length && <p className="settings-empty">Nada encontrado.</p>}
        <div className="settings-nav-footer">
          {error && <p className="inline-error" role="alert">{error}</p>}
          <button className="settings-link danger" disabled={leaving} onClick={onLogout}><LogOut size={18} />{leaving ? "Saindo…" : "Sair da conta"}</button>
        </div>
      </nav>
      <main ref={main} className="settings-main">
        <div className="settings-content">
          <header className="settings-header">
            <h1>{title}</h1>
            {page === "themes" && <p className="lede">Escolha como o Disc Voice aparece. O tema muda só as cores; fontes e tamanhos continuam os mesmos.</p>}
            {page === "connections" && <p className="lede">Vincule outras contas para trazer o que você já faz nelas para o Disc Voice.</p>}
          </header>
          {page === "overview" && <Overview user={user} onEditProfile={() => onPage("profile")} onThemes={() => onPage("themes")} />}
          {page === "voice" && <DeviceSettings inCall={inCall} callDevices={callDevices} userName={user.name} />}
          {page === "profile" && <Profile key={user.id} user={user} onUserChange={onUserChange} />}
          {page === "connections" && <Connections realtime={realtime} />}
          {page === "themes" && <Themes />}
        </div>
      </main>
    </div>
  </dialog>;
}

function Overview({ user, onEditProfile, onThemes }: { user: User; onEditProfile: () => void; onThemes: () => void }) {
  const [appearance, setAppearance] = useAppearance();
  const custom = themeById(appearance);
  const [showEmail, setShowEmail] = useState(false);
  const [notifications, setNotifications] = useNotificationPrefs();
  const [windowPrefs, setWindowPrefs] = useWindowPrefs();
  const traySupported = useTraySupported();
  return <>
    <section className="account-card">
      <div className="profile-banner" style={{ background: bannerColor(user.banner) }} />
      <div className="account-identity">
        <Avatar name={user.name} src={user.avatar} size="xl" status="online" className="profile-avatar" />
        <div><strong>{user.name}</strong><span>{user.email}</span></div>
        <button className="button primary small" onClick={onEditProfile}>Editar perfil</button>
      </div>
      <dl className="account-fields">
        <div><dt>Nome de exibição</dt><dd>{user.name}</dd><button className="button secondary small" onClick={onEditProfile}>Editar</button></div>
        <div><dt>E-mail</dt><dd>{showEmail ? user.email : maskEmail(user.email)}</dd><button className="link-button" onClick={() => setShowEmail(!showEmail)}>{showEmail ? "Ocultar" : "Mostrar"}</button></div>
        <div className="with-icon"><KeyRound size={20} /><dt>Login</dt><dd>Google</dd><span className="status-chip">Conectada</span></div>
      </dl>
    </section>

    <section aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="settings-section-title">Aparência</h2>
      <RadioCards name="appearance" value={appearance} options={appearanceOptions} onChange={setAppearance} />
      {custom && <p className="field-help">Tema importado em uso: “{custom.name}”. <button className="link-button" onClick={onThemes}>Ver temas</button></p>}
      <div className="field narrow"><label htmlFor="language">Idioma <SoonTag /></label>
        <select id="language" disabled defaultValue="pt-BR"><option value="pt-BR">Português (Brasil)</option><option value="en">English</option><option value="es">Español</option></select>
      </div>
    </section>

    <section aria-labelledby="notifications-title">
      <h2 id="notifications-title" className="settings-section-title">Notificações</h2>
      <div className="switch-list">
        <Switch id="desktop-notifications" checked={notifications.desktop} onChange={desktop => {
          setNotifications({ desktop });
          if (desktop) void requestDesktopPermission();
        }} label="Notificações na área de trabalho" description="Avisos de mensagens e entradas na sala quando o app está em segundo plano" />
        <Switch id="message-sounds" checked={notifications.messageSounds} onChange={messageSounds => setNotifications({ messageSounds })} label="Sons de mensagem" description="Toca um som curto quando chega mensagem" />
        <Switch id="voice-join" checked={notifications.voiceJoin} onChange={voiceJoin => setNotifications({ voiceJoin })} label="Avisar quando alguém entra na sala de voz" description="Fora de chamada, em qualquer servidor seu; em chamada, só um som quando alguém se conecta à sua" />
      </div>
    </section>

    {traySupported && <section aria-labelledby="window-title">
      <h2 id="window-title" className="settings-section-title">Janela</h2>
      <div className="switch-list">
        <Switch id="close-to-tray" checked={windowPrefs.closeToTray} onChange={closeToTray => setWindowPrefs({ closeToTray })}
          label="Fechar para a bandeja do sistema" description="O botão de fechar mantém o Disc Voice rodando em segundo plano. Para sair, use “Sair do Disc Voice” no ícone da bandeja." />
      </div>
    </section>}

    <section className="danger-zone">
      <div><h2>Excluir conta</h2><p>Suas mensagens ficam, mas seu nome vira “Usuário removido”. Não dá para desfazer.</p></div>
      <button className="button danger" disabled title="Exclusão de conta em breve">Excluir conta</button>
    </section>
  </>;
}

function collapse(value: string) {
  return value.split(/\s+/).filter(Boolean).join(" ");
}

/** Same rules as the API, so most mistakes are caught before saving. */
export function profileErrors(name: string, pronouns: string, bio: string) {
  const errors: Partial<Record<"name" | "pronouns" | "bio", string>> = {};
  const display = collapse(name);
  if (!display || [...display].length > 32) errors.name = "O nome deve ter entre 1 e 32 caracteres.";
  if ([...collapse(pronouns)].length > 40) errors.pronouns = "Os pronomes devem ter até 40 caracteres.";
  if ([...bio.trim()].length > 190) errors.bio = "O “Sobre mim” deve ter até 190 caracteres.";
  return errors;
}

function Profile({ user, onUserChange }: { user: User; onUserChange: (user: User) => void }) {
  const saved = { name: user.name, pronouns: user.pronouns || "", bio: user.bio || "", banner: user.banner || "brand" };
  const [name, setName] = useState(saved.name);
  const [pronouns, setPronouns] = useState(saved.pronouns);
  const [bio, setBio] = useState(saved.bio);
  const [banner, setBanner] = useState<BannerColor>(saved.banner);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState(false);
  const errors = profileErrors(name, pronouns, bio);
  const invalid = Object.keys(errors).length > 0;
  const changed = collapse(name) !== saved.name || collapse(pronouns) !== saved.pronouns || bio.trim() !== saved.bio || banner !== saved.banner;
  const discard = () => {
    setName(saved.name); setPronouns(saved.pronouns); setBio(saved.bio); setBanner(saved.banner);
    setError(""); setTouched(false);
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (invalid || !changed || saving) return;
    setSaving(true); setError(""); setDone(false);
    try {
      const next = await api.updateProfile({ name: collapse(name), pronouns: collapse(pronouns), bio: bio.trim(), banner });
      onUserChange(next);
      setName(next.name); setPronouns(next.pronouns || ""); setBio(next.bio || ""); setBanner(next.banner || "brand");
      setTouched(false); setDone(true);
    } catch (cause) { setError(message(cause)); }
    finally { setSaving(false); }
  }

  const show = (field: keyof typeof errors) => (touched || field !== "name") && errors[field];
  const preview: User = { ...user, name: collapse(name) || user.name, pronouns: collapse(pronouns), bio: bio.trim(), banner };
  return <div className="profile-layout">
    <form className="stack-form" noValidate onSubmit={save} onChange={() => setDone(false)}>
      <div className="field"><label htmlFor="profile-name">Nome de exibição</label>
        <input id="profile-name" maxLength={64} value={name} aria-invalid={!!show("name")} aria-describedby="profile-name-help" onChange={e => setName(e.target.value)} onBlur={() => setTouched(true)} />
        {show("name") ? <small id="profile-name-help" className="field-error">{errors.name}</small> : <small id="profile-name-help">É o nome que aparece nas mensagens e chamadas.</small>}
      </div>
      <div className="field"><label htmlFor="profile-pronouns">Pronomes</label>
        <input id="profile-pronouns" maxLength={60} placeholder="ela/dela, ele/dele…" value={pronouns} aria-invalid={!!show("pronouns")} onChange={e => setPronouns(e.target.value)} />
        {show("pronouns") && <small className="field-error">{errors.pronouns}</small>}
      </div>
      {/* Avatar upload and the unique username: issue #7. */}
      <div className="field"><span className="field-label">Avatar <SoonTag /></span><div className="button-row"><button type="button" className="button primary small" disabled>Trocar avatar</button><button type="button" className="link-button" disabled>Remover</button></div></div>
      <fieldset className="field color-field"><legend className="field-label">Cor do banner</legend>
        <div className="color-swatches">{BANNER_COLORS.map(color => <label key={color.id} title={color.name} style={{ background: color.value }} className={banner === color.id ? "checked" : ""}>
          <input type="radio" name="banner" className="sr-only" checked={banner === color.id} onChange={() => setBanner(color.id)} /><span className="sr-only">{color.name}</span>
        </label>)}</div>
      </fieldset>
      <div className="field"><label htmlFor="profile-bio">Sobre mim</label>
        <textarea id="profile-bio" rows={4} maxLength={190} value={bio} aria-invalid={!!show("bio")} onChange={e => setBio(e.target.value)} />
        {show("bio") ? <small className="field-error">{errors.bio}</small> : <small className="counter">{[...bio].length}/190</small>}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      {done && !changed && <p className="field-success" role="status">Perfil salvo.</p>}
      <div className="button-row">
        <button className="button primary" type="submit" disabled={!changed || saving || (touched && invalid)}>{saving ? "Salvando…" : "Salvar alterações"}</button>
        <button type="button" className="button secondary" disabled={!changed || saving} onClick={discard}>Descartar</button>
      </div>
    </form>
    <aside aria-label="Prévia do perfil">
      <span className="field-label">Prévia</span>
      <div className="profile-preview">
        <ProfileSummary user={preview} subtitle={[user.email, preview.pronouns].filter(Boolean).join(" · ")} />
      </div>
    </aside>
  </div>;
}

/** Why the Discord activity is (or isn't) showing up. */
export function presenceHelp(status: DiscordStatus) {
  const account = status.account;
  if (!account?.shareActivity) return "Sua atividade do Discord não aparece para ninguém aqui.";
  if (!status.presence) return "O bot do Disc Voice não está recebendo presenças do Discord agora, então sua atividade não aparece.";
  if (!account.presenceSeen) {
    return "Ainda não vimos sua atividade. O Discord só compartilha o que você está fazendo com bots de servidores em comum: entre em um servidor do Discord que tenha o bot do Disc Voice.";
  }
  return "Sincronizando: quando você joga ou ouve música, quem está nos seus servidores vê isso no seu perfil.";
}

function Connections({ realtime }: { realtime?: Realtime }) {
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [showCall, setShowCall] = useShowCallOnDiscord();

  const load = useCallback(() => api.discord()
    .then(result => { setStatus(result); setError(""); if (result.account) setWaiting(false); })
    .catch(cause => setError(message(cause))), []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => realtime?.onEvent(event => {
    if (event.type === "discord.updated" && !event.serverId) void load();
  }), [realtime, load]);
  // Back from the browser after authorizing.
  useEffect(() => {
    if (!waiting) return;
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [waiting, load]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await load(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  const account = status?.account;
  return <section className="connection-card" aria-labelledby="discord-connection-title">
    <div className="section-row">
      <h2 id="discord-connection-title" className="settings-section-title">Discord</h2>
      {account && <span className="status-chip">Conectada</span>}
    </div>
    {!status && !error && <p className="muted" role="status">Carregando…</p>}
    {status && !status.enabled && <p className="muted">A integração com o Discord não está configurada neste servidor do Disc Voice.</p>}
    {status?.enabled && !account && <>
      <p className="field-help">Mostre aqui o que você está jogando, ouvindo ou assistindo no Discord. Só lemos seu nome de usuário; nunca suas mensagens ou servidores.</p>
      {waiting && <p className="notice" role="status">Conclua a autorização no navegador e volte para cá.</p>}
      <div className="button-row"><button className="button primary" disabled={busy} onClick={() => void act(async () => { await openExternal((await api.linkDiscord()).url); setWaiting(true); })}><ExternalLink size={16} />Conectar conta do Discord</button></div>
    </>}
    {account && status && <>
      <div className="connection-identity">
        <Avatar name={account.displayName || account.username} src={account.avatar} size="lg" />
        <div><strong>{account.displayName || account.username}</strong><span>@{account.username}</span></div>
        <button className="button secondary small" disabled={busy} onClick={() => void act(() => api.unlinkDiscord())}>Desconectar</button>
      </div>
      <div className="switch-list">
        <Switch id="discord-activity" checked={account.shareActivity} disabled={busy} onChange={share => void act(() => api.updateDiscord(share))}
          label="Mostrar minha atividade do Discord" description="Quem está nos seus servidores vê o jogo, a música ou o vídeo do seu status do Discord." />
      </div>
      <p className="field-help" role="status">{presenceHelp(status)}</p>
    </>}
    {status?.enabled && status.clientId && <div className="switch-list">
      <Switch id="discord-call-presence" checked={showCall} onChange={setShowCall}
        label="Mostrar no Discord quando eu estiver em um canal de voz"
        description="Seus amigos do Discord veem o nome do canal e do servidor. Precisa do Discord aberto neste computador." />
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

const builtInThemes: { id: Appearance; name: string; by: string }[] = [
  { id: "light", name: "Claro", by: "Disc Voice · padrão" },
  { id: "dark", name: "Escuro", by: "Disc Voice" },
  { id: "system", name: "Igual ao sistema", by: "Segue o sistema operacional" },
];

const exampleJson = JSON.stringify(THEME_EXAMPLE, null, 2);

function downloadExample() {
  const url = URL.createObjectURL(new Blob([exampleJson + "\n"], { type: "application/json" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: "tema-disc-voice.json" });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ThemeError("Não foi possível ler o arquivo."));
    reader.readAsText(file);
  });
}

function ThemePreview({ theme }: { theme: CustomTheme }) {
  const colors = resolveTheme(theme.base, theme.colors).colors;
  return <div className="theme-preview" aria-hidden="true" style={{ background: colors.surface, borderColor: colors.line }}>
    <span style={{ background: colors["surface-sunken"] }} /><span style={{ background: colors.ink }} /><span style={{ background: colors["ink-muted"] }} /><span style={{ background: colors.brand }} />
  </div>;
}

function Themes() {
  const [appearance, setAppearance] = useAppearance();
  const { themes } = useThemes();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<CustomTheme | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function load(read: () => Promise<CustomTheme>) {
    setBusy(true); setError(""); setImported(null);
    try { setImported(addTheme(await read())); return true; }
    catch (cause) { setError(cause instanceof ThemeError ? cause.message : message(cause)); return false; }
    finally { setBusy(false); }
  }

  function importFile(file: File | undefined) {
    if (!file) return;
    void load(async () => {
      if (file.size > MAX_THEME_BYTES) throw new ThemeError("O tema deve ter até 200 KB.");
      if (!/\.json$/i.test(file.name) && file.type !== "application/json") throw new ThemeError("Escolha um arquivo .json.");
      return parseTheme(await readText(file));
    });
  }

  return <>
    <section className="import-card" aria-labelledby="import-title">
      <h2 id="import-title">Importar tema</h2>
      <div className={`dropzone ${dragging ? "dragging" : ""}`} aria-busy={busy}
        onDragOver={event => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={event => { event.preventDefault(); setDragging(false); importFile(event.dataTransfer.files[0]); }}>
        <span className="dropzone-icon"><Upload size={20} /></span>
        <strong>Arraste o arquivo do tema para cá</strong>
        <small>Arquivo .json de até 200 KB</small>
        <input ref={picker} type="file" accept=".json,application/json" className="sr-only" tabIndex={-1} aria-label="Arquivo do tema"
          onChange={event => { importFile(event.target.files?.[0]); event.target.value = ""; }} />
        <button type="button" className="button secondary small" disabled={busy} onClick={() => picker.current?.click()}>Escolher arquivo</button>
      </div>
      <div className="divider"><span>ou cole um link</span></div>
      <form className="inline-form" onSubmit={event => { event.preventDefault(); if (link.trim()) void load(() => fetchTheme(link)).then(ok => { if (ok) setLink(""); }); }}>
        <label className="sr-only" htmlFor="theme-url">Link do tema</label>
        <input id="theme-url" type="url" placeholder="https://" value={link} onChange={event => setLink(event.target.value)} />
        <button className="button secondary" disabled={busy || !link.trim()}>{busy ? "Importando…" : "Importar"}</button>
      </form>
      {error && <p className="inline-error" role="alert">{error} O tema atual não foi alterado.</p>}
      {imported && <div className="notice" role="status"><p>
        <strong>Tema “{imported.name}” importado.</strong>
        {imported.adjusted.length
          ? <>Ajustamos {imported.adjusted.length === 1 ? "a cor" : "as cores"} {imported.adjusted.map(token => <code key={token}>{token}</code>).reduce<ReactNode[]>((all, item, i) => i ? [...all, ", ", item] : [item], [])} para manter o texto legível (contraste mínimo de 4,5:1).</>
          : "Todas as cores têm contraste suficiente."}
      </p></div>}
    </section>

    <section aria-labelledby="your-themes-title">
      <h2 id="your-themes-title" className="settings-section-title">Seus temas</h2>
      <div className="theme-grid">
        {builtInThemes.map(theme => <article key={theme.id} className={`theme-card ${appearance === theme.id ? "selected" : ""}`}>
          <div className={`theme-preview preview-${theme.id}`} aria-hidden="true"><span /><span /><span /><span /></div>
          <strong>{theme.name}</strong><small>{theme.by}</small>
          {appearance === theme.id ? <span className="status-chip brand">Em uso</span> : <button className="button secondary small" aria-label={`Usar tema ${theme.name}`} onClick={() => setAppearance(theme.id)}>Usar</button>}
        </article>)}
        {themes.map(theme => {
          const id = `theme:${theme.id}` as const;
          return <article key={theme.id} className={`theme-card ${appearance === id ? "selected" : ""}`}>
            <ThemePreview theme={theme} />
            <strong>{theme.name}</strong><small>{[theme.author && `por ${theme.author}`, theme.base === "dark" ? "Base escura" : "Base clara"].filter(Boolean).join(" · ")}</small>
            <div className="button-row">
              {appearance === id ? <span className="status-chip brand">Em uso</span> : <button className="button secondary small" aria-label={`Usar tema ${theme.name}`} onClick={() => setAppearance(id)}>Usar</button>}
              <button className="link-button subtle" aria-label={`Remover tema ${theme.name}`} onClick={() => { removeTheme(theme.id); if (imported?.id === theme.id) setImported(null); }}>Remover</button>
            </div>
          </article>;
        })}
      </div>
    </section>

    <section aria-labelledby="theme-howto-title">
      <div className="section-row">
        <h2 id="theme-howto-title" className="settings-section-title">Como montar um tema</h2>
        <button type="button" className="link-button" onClick={downloadExample}><Download size={16} />Baixar modelo</button>
      </div>
      <p className="field-help">
        Use os mesmos nomes de cor do Disc Voice, em <code>#rrggbb</code>. O que faltar vem do tema da base (<code>light</code> ou <code>dark</code>).
        Cores de texto com pouco contraste são ajustadas automaticamente.
      </p>
      <pre className="code-block"><code>{exampleJson}</code></pre>
      <details className="token-list"><summary>Nomes de cor disponíveis</summary><p>{THEME_TOKENS.map(token => <code key={token}>{token}</code>)}</p></details>
    </section>
  </>;
}
