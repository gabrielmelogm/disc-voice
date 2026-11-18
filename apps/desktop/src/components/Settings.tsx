import { useState, type ReactNode } from "react";
import { KeyRound, LogOut, Upload, X } from "lucide-react";
import type { User } from "@disc-voice/shared";
import { DeviceSettings } from "../DeviceSettings";
import { maskEmail } from "../lib/display";
import { useAppearance, type Appearance } from "../lib/theme";
import { Avatar, RadioCards, SoonTag, Switch } from "./ui";

export type SettingsPage = "overview" | "voice" | "profile" | "themes";

const pages: { id: SettingsPage; label: string }[] = [
  { id: "overview", label: "Visão geral" },
  { id: "voice", label: "Voz e vídeo" },
  { id: "profile", label: "Perfil" },
  { id: "themes", label: "Temas" },
];

const appearanceOptions: { value: Appearance; label: string }[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
  { value: "system", label: "Igual ao sistema" },
];

export function Settings({ user, page, onPage, onClose, onLogout, leaving, error, inCall, callDevices }: {
  user: User;
  page: SettingsPage;
  onPage: (page: SettingsPage) => void;
  onClose: () => void;
  onLogout: () => void;
  leaving: boolean;
  error: string;
  inCall: boolean;
  callDevices: ReactNode;
}) {
  const title = pages.find(item => item.id === page)!.label;
  return <div className="settings-shell" onKeyDown={event => { if (event.key === "Escape") onClose(); }}>
    <nav className="settings-nav" aria-label="Configurações">
      <h2 className="eyebrow">Configurações de usuário</h2>
      {pages.map(item => <button key={item.id} className={`settings-link ${page === item.id ? "selected" : ""}`} aria-current={page === item.id ? "page" : undefined} onClick={() => onPage(item.id)}>{item.label}</button>)}
      <hr />
      <button className="settings-link danger" disabled={leaving} onClick={onLogout}><LogOut size={16} />{leaving ? "Saindo…" : "Sair da conta"}</button>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </nav>
    <main className="settings-main">
      <div className={`settings-content ${page === "profile" || page === "themes" ? "wide" : ""}`}>
        <header className="settings-header">
          <div><h1>{title}</h1>{page === "themes" && <p className="lede">Escolha como o Disc Voice aparece. O tema muda só as cores; fontes e tamanhos continuam os mesmos.</p>}</div>
          <button className="close-button" aria-label="Fechar configurações" title="Fechar (Esc)" onClick={onClose}><X size={20} /></button>
        </header>
        {page === "overview" && <Overview user={user} onEditProfile={() => onPage("profile")} />}
        {page === "voice" && <DeviceSettings inCall={inCall} callDevices={callDevices} userName={user.name} />}
        {page === "profile" && <Profile user={user} />}
        {page === "themes" && <Themes />}
      </div>
    </main>
  </div>;
}

function Overview({ user, onEditProfile }: { user: User; onEditProfile: () => void }) {
  const [appearance, setAppearance] = useAppearance();
  const [showEmail, setShowEmail] = useState(false);
  return <>
    <section className="account-card">
      <div className="profile-banner" />
      <div className="account-identity">
        <Avatar name={user.name} size="xl" status="online" className="profile-avatar" />
        <div><strong>{user.name}</strong><span>{user.email}</span></div>
        <button className="button primary small" onClick={onEditProfile}>Editar perfil</button>
      </div>
      <dl className="account-fields">
        <div><dt>Nome de exibição</dt><dd>{user.name}</dd><button className="button secondary small" disabled title="Edição do nome em breve">Editar</button></div>
        <div><dt>E-mail</dt><dd>{showEmail ? user.email : maskEmail(user.email)}</dd><button className="link-button" onClick={() => setShowEmail(!showEmail)}>{showEmail ? "Ocultar" : "Mostrar"}</button></div>
        <div className="with-icon"><KeyRound size={20} /><dt>Login</dt><dd>E-mail e senha</dd><span className="status-chip">Conectada</span></div>
      </dl>
    </section>

    <section aria-labelledby="appearance-title">
      <h2 id="appearance-title" className="settings-section-title">Aparência</h2>
      <RadioCards name="appearance" value={appearance} options={appearanceOptions} onChange={setAppearance} />
      <div className="field narrow"><label htmlFor="language">Idioma <SoonTag /></label>
        <select id="language" disabled defaultValue="pt-BR"><option value="pt-BR">Português (Brasil)</option><option value="en">English</option><option value="es">Español</option></select>
      </div>
    </section>

    {/* Notification preferences: issue #12. */}
    <section aria-labelledby="notifications-title">
      <h2 id="notifications-title" className="settings-section-title">Notificações <SoonTag /></h2>
      <div className="switch-list">
        <Switch id="desktop-notifications" disabled checked label="Notificações na área de trabalho" description="Avisos de menções e mensagens diretas fora do app" />
        <Switch id="message-sounds" disabled checked label="Sons de mensagem" description="Toca um som curto quando chega mensagem" />
        <Switch id="voice-join" disabled checked={false} label="Avisar quando alguém entra na sala de voz" description="Só para as salas em que você estiver" />
      </div>
    </section>

    <section className="danger-zone">
      <div><h2>Excluir conta</h2><p>Suas mensagens ficam, mas seu nome vira “Usuário removido”. Não dá para desfazer.</p></div>
      <button className="button danger" disabled title="Exclusão de conta em breve">Excluir conta</button>
    </section>
  </>;
}

const bannerColors = [
  { name: "Roxo", value: "var(--brand)" },
  { name: "Verde", value: "#157a3f" },
  { name: "Âmbar", value: "#8a5a00" },
  { name: "Vermelho", value: "#c11f2d" },
  { name: "Grafite", value: "#4f4b5c" },
];

function Profile({ user }: { user: User }) {
  const [name, setName] = useState(user.name);
  const [pronouns, setPronouns] = useState("");
  const [bio, setBio] = useState("");
  const [banner, setBanner] = useState(bannerColors[0].value);
  const changed = name !== user.name || !!pronouns || !!bio || banner !== bannerColors[0].value;
  const discard = () => { setName(user.name); setPronouns(""); setBio(""); setBanner(bannerColors[0].value); };

  return <div className="profile-layout">
    <form className="stack-form" onSubmit={event => event.preventDefault()}>
      <div className="notice"><p>A edição de perfil chega em breve. Por enquanto, as mudanças aparecem só na prévia e não são salvas.</p></div>
      <div className="field"><label htmlFor="profile-name">Nome de exibição</label><input id="profile-name" maxLength={32} value={name} onChange={e => setName(e.target.value)} /><small>É o nome que aparece nas mensagens e chamadas.</small></div>
      <div className="field"><label htmlFor="profile-pronouns">Pronomes</label><input id="profile-pronouns" maxLength={40} placeholder="ela/dela, ele/dele…" value={pronouns} onChange={e => setPronouns(e.target.value)} /></div>
      <div className="field"><span className="field-label">Avatar <SoonTag /></span><div className="button-row"><button type="button" className="button primary small" disabled>Trocar avatar</button><button type="button" className="link-button" disabled>Remover</button></div></div>
      <fieldset className="field color-field"><legend className="field-label">Cor do banner</legend>
        <div className="color-swatches">{bannerColors.map(color => <label key={color.name} title={color.name} style={{ background: color.value }} className={banner === color.value ? "checked" : ""}>
          <input type="radio" name="banner" className="sr-only" checked={banner === color.value} onChange={() => setBanner(color.value)} /><span className="sr-only">{color.name}</span>
        </label>)}</div>
      </fieldset>
      <div className="field"><label htmlFor="profile-bio">Sobre mim</label><textarea id="profile-bio" rows={4} maxLength={190} value={bio} onChange={e => setBio(e.target.value)} /><small className="counter">{bio.length}/190</small></div>
      <div className="button-row"><button className="button primary" disabled title="Salvar perfil em breve">Salvar alterações</button><button type="button" className="button secondary" disabled={!changed} onClick={discard}>Descartar</button></div>
    </form>
    <aside aria-label="Prévia do perfil">
      <span className="field-label">Prévia</span>
      <div className="profile-preview">
        <div className="profile-banner" style={{ background: banner }} />
        <Avatar name={name || user.name} size="xl" status="online" className="profile-avatar" />
        <strong>{name || user.name}</strong>
        <span>{[user.email, pronouns].filter(Boolean).join(" · ")}</span>
        <div className="detail-card"><h3 className="eyebrow">Sobre mim</h3><p>{bio || "Conte um pouco sobre você."}</p></div>
      </div>
    </aside>
  </div>;
}

const themeExample = `{
  "name": "Aurora",
  "author": "Gabi Nunes",
  "base": "dark",
  "colors": {
    "brand": "#1fb5a3",
    "surface": "#0f1d24",
    "surface-sunken": "#0a151a",
    "fill": "#1b2e36",
    "ink": "#e6f4f2"
  }
}`;

function Themes() {
  const [appearance, setAppearance] = useAppearance();
  const themes: { id: Appearance; name: string; by: string }[] = [
    { id: "light", name: "Claro", by: "Disc Voice · padrão" },
    { id: "dark", name: "Escuro", by: "Disc Voice" },
    { id: "system", name: "Igual ao sistema", by: "Segue o sistema operacional" },
  ];
  return <>
    {/* Importing custom themes is designed but not implemented yet. */}
    <section className="import-card" aria-labelledby="import-title">
      <h2 id="import-title">Importar tema <SoonTag /></h2>
      <div className="dropzone" aria-disabled="true">
        <span className="dropzone-icon"><Upload size={20} /></span>
        <strong>Arraste o arquivo do tema para cá</strong>
        <small>Arquivo .json de até 200 KB</small>
        <button className="button secondary small" disabled>Escolher arquivo</button>
      </div>
      <div className="divider"><span>ou cole um link</span></div>
      <div className="inline-form"><label className="sr-only" htmlFor="theme-url">Link do tema</label><input id="theme-url" disabled placeholder="https://" /><button className="button secondary" disabled>Importar</button></div>
    </section>

    <section aria-labelledby="your-themes-title">
      <h2 id="your-themes-title" className="settings-section-title">Seus temas</h2>
      <div className="theme-grid">
        {themes.map(theme => <article key={theme.id} className={`theme-card ${appearance === theme.id ? "selected" : ""}`}>
          <div className={`theme-preview preview-${theme.id}`} aria-hidden="true"><span /><span /><span /><span /></div>
          <strong>{theme.name}</strong><small>{theme.by}</small>
          {appearance === theme.id ? <span className="status-chip brand">Em uso</span> : <button className="button secondary small" aria-label={`Usar tema ${theme.name}`} onClick={() => setAppearance(theme.id)}>Usar</button>}
        </article>)}
      </div>
    </section>

    <section aria-labelledby="theme-howto-title">
      <h2 id="theme-howto-title" className="settings-section-title">Como montar um tema</h2>
      <p className="field-help">Use os mesmos nomes de cor do Disc Voice. O que faltar vem do tema Claro.</p>
      <pre className="code-block"><code>{themeExample}</code></pre>
    </section>
  </>;
}
