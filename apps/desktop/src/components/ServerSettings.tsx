import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Import, Plus, Search, Trash2, X } from "lucide-react";
import type { Ban, Role, Server, ServerMember } from "@disc-voice/shared";
import { api, message, type RoleChanges } from "../lib/api";
import { fileProblem, isImage, uploadFile } from "../lib/files";
import {
  can, canChange, colorHex, hasBit, outranksRole, parseColor, PERMISSION_OPTIONS, ROLE_COLORS, toggleBit, type Access,
} from "../lib/roles";
import { normalize } from "./Members";
import { RoleChip, useServerRoles } from "./ServerRoles";
import { Avatar, Switch } from "./ui";

export type ServerSettingsPage = "overview" | "roles" | "bans";

/** Which settings pages the user can open; none means no settings at all. */
export function settingsPages(access: Access): ServerSettingsPage[] {
  return [
    ...(access.owner || can(access, "manageServer") ? ["overview" as const] : []),
    ...(can(access, "manageRoles") ? ["roles" as const] : []),
    ...(can(access, "banMembers") ? ["bans" as const] : []),
  ];
}

const PAGE_LABELS: Record<ServerSettingsPage, string> = { overview: "Visão geral", roles: "Cargos", bans: "Banimentos" };

/** Server settings: name and description, roles and their permissions, bans. */
export function ServerSettings({ server, members, onClose, onDiscord }: {
  server: Server;
  members: ServerMember[];
  onClose: () => void;
  /** Opens the Discord import; only for the server owner. */
  onDiscord?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { self } = useServerRoles();
  const pages = settingsPages(self);
  const [page, setPage] = useState<ServerSettingsPage>(pages[0] ?? "overview");

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // Losing the permission (e.g. a role changed) closes what it opened.
  useEffect(() => { if (!pages.length) onClose(); }, [pages.length, onClose]);
  const shown = pages.includes(page) ? page : pages[0];

  return <dialog ref={ref} className="action-dialog server-settings" aria-labelledby="server-settings-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="server-settings-title">Configurações de {server.name}</h2>
      <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    {pages.length > 1 && <div className="settings-tabs" role="tablist" aria-label="Seções">
      {pages.map(item => <button key={item} type="button" role="tab" aria-selected={item === shown} className={item === shown ? "active" : ""}
        onClick={() => setPage(item)}>{PAGE_LABELS[item]}</button>)}
    </div>}
    <div role="tabpanel" aria-label={shown ? PAGE_LABELS[shown] : undefined}>
      {shown === "overview" && <Overview server={server} access={self} onDiscord={onDiscord} />}
      {shown === "roles" && <Roles server={server} members={members} access={self} />}
      {shown === "bans" && <Bans server={server} />}
    </div>
  </dialog>;
}

/** A new icon being sent (`id` once it is up), or null to remove the current one. */
type IconChange = { preview: string; progress: number; id?: string } | null;

function Overview({ server, access, onDiscord }: { server: Server; access: Access; onDiscord?: () => void }) {
  const editable = can(access, "manageServer");
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? "");
  // undefined: the icon stays as it is.
  const [icon, setIcon] = useState<IconChange | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const uploading = !!icon && !icon.id;
  const changed = name.trim() !== server.name || description.trim() !== (server.description ?? "") || icon !== undefined;
  const shownIcon = icon === undefined ? server.icon : icon?.preview ?? null;

  useEffect(() => () => upload.current?.abort(), []);
  // Frees the preview once it is replaced, removed or saved.
  const preview = icon?.preview;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function pickIcon(file: File | undefined) {
    if (!file) return;
    const problem = fileProblem(file) ?? (isImage(file.type) ? null : "O ícone deve ser uma imagem (PNG, JPG, GIF ou WebP).");
    setSaved(false);
    if (problem) { setError(problem); return; }
    setError("");
    upload.current?.abort();
    const controller = new AbortController();
    upload.current = controller;
    const url = URL.createObjectURL(file);
    const update = (changes: Partial<NonNullable<IconChange>>) => setIcon(current => current?.preview === url ? { ...current, ...changes } : current);
    setIcon({ preview: url, progress: 0 });
    uploadFile(file, progress => update({ progress }), controller.signal)
      .then(uploaded => update({ id: uploaded.id, progress: 1 }))
      .catch(cause => {
        if (controller.signal.aborted) return;
        setIcon(current => current?.preview === url ? undefined : current);
        setError(message(cause));
      });
  }

  function removeIcon() {
    upload.current?.abort();
    setIcon(server.icon ? null : undefined);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    const changes: { name: string; description: string; icon?: string | null } = { name: name.trim(), description: description.trim() };
    if (icon !== undefined) changes.icon = icon?.id ?? null;
    // Everyone (the user included) gets the new name and icon over the realtime connection.
    try { await api.updateServer(server.id, changes); setIcon(undefined); setSaved(true); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function remove() {
    setDeleting(true);
    setError("");
    // The realtime event takes the server away from every member, the user included.
    try { await api.deleteServer(server.id); }
    catch (cause) { setError(message(cause)); setDeleting(false); }
  }

  return <div className="settings-section">
    {editable && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="field"><span className="field-label" id="server-icon-label">Ícone do servidor</span>
        <div className="server-icon-field" role="group" aria-labelledby="server-icon-label">
          <Avatar name={name.trim() || server.name} src={shownIcon} size="xl" square />
          <div className="server-icon-actions">
            <input ref={picker} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Arquivo do ícone"
              onChange={event => { pickIcon(event.target.files?.[0]); event.target.value = ""; }} />
            <button type="button" className="button secondary small" disabled={busy} onClick={() => picker.current?.click()}><ImagePlus size={16} />Alterar ícone</button>
            {shownIcon && <button type="button" className="button danger-soft small" disabled={busy} onClick={removeIcon}><Trash2 size={16} />Remover ícone</button>}
            <small className="field-help" role="status">{uploading ? `Enviando… ${Math.round((icon?.progress ?? 0) * 100)}%` : "PNG, JPG, GIF ou WebP, até 15 MB."}</small>
          </div>
        </div>
      </div>
      <div className="field"><label htmlFor="server-name">Nome do servidor</label>
        <input id="server-name" required maxLength={100} value={name} disabled={busy} onChange={event => { setName(event.target.value); setSaved(false); }} /></div>
      <div className="field"><label htmlFor="server-description">Descrição</label>
        <textarea id="server-description" maxLength={300} rows={3} value={description} disabled={busy} placeholder="Conte do que se trata este servidor."
          onChange={event => { setDescription(event.target.value); setSaved(false); }} /></div>
      <div className="dialog-actions">
        {saved && <span className="muted" role="status">Alterações salvas.</span>}
        <button type="submit" className="button primary" disabled={busy || uploading || !changed || !name.trim()}>{busy ? "Salvando…" : "Salvar alterações"}</button>
      </div>
    </form>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {access.owner && onDiscord && <section className="server-import" aria-labelledby="import-title">
      <h3 id="import-title">Importar do Discord</h3>
      <p className="muted">Traz canais e mensagens de um servidor do Discord que você gerencia para este servidor.</p>
      <button type="button" className="button secondary" onClick={onDiscord}><Import size={16} />Importar do Discord</button>
    </section>}
    {access.owner && <section className="server-danger" aria-labelledby="danger-title">
      <h3 id="danger-title">Excluir servidor</h3>
      <p className="muted">Apaga o servidor para todo mundo, com canais, mensagens, cargos e convites. Não dá para desfazer.</p>
      {confirming ? <form onSubmit={event => { event.preventDefault(); void remove(); }}>
        <div className="field"><label htmlFor="delete-confirm">Digite <strong>{server.name}</strong> para confirmar</label>
          <input id="delete-confirm" autoFocus value={typed} disabled={deleting} onChange={event => setTyped(event.target.value)} /></div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" onClick={() => { setConfirming(false); setTyped(""); }}>Cancelar</button>
          <button type="submit" className="button danger" disabled={deleting || typed.trim() !== server.name}><Trash2 size={16} />{deleting ? "Excluindo…" : "Excluir servidor"}</button>
        </div>
      </form> : <button type="button" className="button danger" onClick={() => setConfirming(true)}><Trash2 size={16} />Excluir servidor</button>}
    </section>}
  </div>;
}

type RoleTab = "display" | "permissions" | "members";

function Roles({ server, members, access }: { server: Server; members: ServerMember[]; access: Access }) {
  const { roles } = useServerRoles();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const custom = roles.filter(role => !role.everyone);
  const selected = roles.find(role => role.id === selectedId) ?? roles[0];

  async function create() {
    setBusy(true);
    setError("");
    try { const role = await api.createRole(server.id, { name: "novo cargo" }); setSelectedId(role.id); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function move(role: Role, by: -1 | 1) {
    const ids = custom.map(r => r.id);
    const from = ids.indexOf(role.id);
    const to = from + by;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setError("");
    try { await api.reorderRoles(server.id, ids); }
    catch (cause) { setError(message(cause)); }
  }

  const movable = (role: Role, by: -1 | 1) => {
    const other = custom[custom.indexOf(role) + by];
    return !!other && outranksRole(access, role.position) && outranksRole(access, other.position);
  };

  return <div className="roles-settings">
    <div className="roles-list">
      <button type="button" className="button primary small full" disabled={busy} onClick={() => void create()}><Plus size={16} />Criar cargo</button>
      <p className="field-help">Cargos de cima vêm antes na lista de pessoas e mandam nos de baixo.</p>
      <ul aria-label="Cargos do servidor">
        {roles.map(role => <li key={role.id} className={role.id === selected?.id ? "selected" : ""}>
          <button type="button" className="role-pick" aria-pressed={role.id === selected?.id} onClick={() => setSelectedId(role.id)}>
            <RoleChip role={role} /><small>{role.everyone ? "Todos" : `${members.filter(m => m.roles.includes(role.id)).length}`}</small>
          </button>
          {!role.everyone && <span className="role-order">
            <button type="button" className="icon-button small" aria-label={`Subir ${role.name}`} disabled={!movable(role, -1)} onClick={() => void move(role, -1)}><ArrowUp size={14} /></button>
            <button type="button" className="icon-button small" aria-label={`Descer ${role.name}`} disabled={!movable(role, 1)} onClick={() => void move(role, 1)}><ArrowDown size={14} /></button>
          </span>}
        </li>)}
      </ul>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    {selected && <RoleEditor key={selected.id} server={server} role={selected} members={members} access={access} onDeleted={() => setSelectedId(null)} />}
  </div>;
}

function RoleEditor({ server, role, members, access, onDeleted }: {
  server: Server; role: Role; members: ServerMember[]; access: Access; onDeleted: () => void;
}) {
  const editable = role.everyone || outranksRole(access, role.position);
  const [tab, setTab] = useState<RoleTab>(role.everyone ? "permissions" : "display");
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<number | null>(role.color);
  const [permissions, setPermissions] = useState(role.permissions);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState("");
  const holders = members.filter(m => m.roles.includes(role.id));
  const changed = name.trim() !== role.name || color !== role.color || permissions !== role.permissions;

  const options = useMemo(() => {
    const q = normalize(query);
    return PERMISSION_OPTIONS.filter(option => !q || normalize(`${option.label} ${option.description}`).includes(q));
  }, [query]);

  async function save() {
    const changes: RoleChanges = {};
    if (!role.everyone && name.trim() !== role.name) changes.name = name.trim();
    if (color !== role.color) changes.color = color;
    if (permissions !== role.permissions) changes.permissions = permissions;
    setBusy(true);
    setError("");
    try { await api.updateRole(server.id, role.id, changes); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try { await api.deleteRole(server.id, role.id); onDeleted(); }
    catch (cause) { setError(message(cause)); setBusy(false); }
  }

  async function assign(userId: string, give: boolean) {
    setError("");
    try { await api.assignRole(server.id, userId, role.id, give); if (give) setAdding(""); }
    catch (cause) { setError(message(cause)); }
  }

  const tabs: { id: RoleTab; label: string }[] = [
    ...(!role.everyone ? [{ id: "display" as const, label: "Exibição" }] : []),
    { id: "permissions", label: "Permissões" },
    ...(!role.everyone ? [{ id: "members" as const, label: `Gerenciar membros (${holders.length})` }] : []),
  ];

  return <section className="role-editor" aria-label={`Editar ${role.name}`}>
    <div className="settings-tabs" role="tablist" aria-label={`Seções de ${role.name}`}>
      {tabs.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? "active" : ""}
        onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    {!editable && <p className="field-help">Você só pode editar cargos abaixo do seu cargo mais alto.</p>}

    {tab === "display" && <div className="settings-section">
      <div className="field"><label htmlFor="role-name">Nome do cargo</label>
        <input id="role-name" maxLength={100} value={name} disabled={!editable || busy} onChange={event => setName(event.target.value)} /></div>
      <fieldset className="role-colors" disabled={!editable || busy}><legend className="field-label">Cor do cargo</legend>
        <button type="button" className={`role-swatch none ${color === null ? "checked" : ""}`} aria-pressed={color === null} aria-label="Sem cor" onClick={() => setColor(null)} />
        {ROLE_COLORS.map(value => <button key={value} type="button" className={`role-swatch ${color === value ? "checked" : ""}`} aria-pressed={color === value}
          aria-label={`Cor ${colorHex(value)}`} style={{ background: colorHex(value) }} onClick={() => setColor(value)} />)}
        <input type="color" aria-label="Outra cor" value={color === null ? "#99aab5" : colorHex(color)} onChange={event => setColor(parseColor(event.target.value))} />
      </fieldset>
    </div>}

    {tab === "permissions" && <div className="settings-section">
      <div className="search-field"><Search size={16} /><label className="sr-only" htmlFor="permission-search">Buscar permissões</label>
        <input id="permission-search" className="search-input" placeholder="Buscar permissões" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <div className="permissions-heading"><h3>Permissões do servidor</h3>
        <button type="button" className="link-button" disabled={!editable || !permissions || !canChange(access, permissions, 0)} onClick={() => setPermissions(0)}>Limpar permissões</button></div>
      {options.map(option => {
        const on = hasBit(permissions, option.id);
        const next = toggleBit(permissions, option.id, !on);
        return <Switch key={option.id} id={`permission-${option.id}`} label={option.label} description={option.description}
          checked={on} disabled={!editable || busy || !canChange(access, permissions, next)} onChange={value => setPermissions(toggleBit(permissions, option.id, value))} />;
      })}
      {!options.length && <p className="muted">Nenhuma permissão encontrada.</p>}
    </div>}

    {tab === "members" && <div className="settings-section">
      {editable && can(access, "manageRoles") && <div className="inline-form">
        <label className="sr-only" htmlFor="role-add">Adicionar membro ao cargo</label>
        <select id="role-add" value={adding} onChange={event => setAdding(event.target.value)}>
          <option value="">Escolha alguém para adicionar…</option>
          {members.filter(m => !m.roles.includes(role.id)).map(m => <option key={m.user.id} value={m.user.id}>{m.user.name}</option>)}
        </select>
        <button type="button" className="button secondary" disabled={!adding} onClick={() => void assign(adding, true)}><Plus size={16} />Adicionar</button>
      </div>}
      {holders.length ? <ul className="people-list" aria-label={`Pessoas com ${role.name}`}>
        {holders.map(m => <li key={m.user.id}><Avatar name={m.user.name} src={m.user.avatar} still={m.user.avatarStill} size="sm" />
          <div><strong>{m.user.name}</strong></div>
          {editable && <button type="button" className="icon-button small" aria-label={`Remover ${m.user.name} de ${role.name}`} onClick={() => void assign(m.user.id, false)}><X size={16} /></button>}
        </li>)}
      </ul> : <p className="muted">Ninguém tem este cargo ainda.</p>}
    </div>}

    {error && <p className="inline-error" role="alert">{error}</p>}
    {tab !== "members" && editable && <div className="dialog-actions">
      {!role.everyone && <button type="button" className="button danger-soft" disabled={busy} onClick={() => void remove()}><Trash2 size={16} />Excluir cargo</button>}
      <button type="button" className="button secondary" disabled={busy || !changed} onClick={() => { setName(role.name); setColor(role.color); setPermissions(role.permissions); }}>Desfazer</button>
      <button type="button" className="button primary" disabled={busy || !changed || (!role.everyone && !name.trim())} onClick={() => void save()}>{busy ? "Salvando…" : "Salvar alterações"}</button>
    </div>}
  </section>;
}

function Bans({ server }: { server: Server }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.bans(server.id, controller.signal)
      .then(result => { if (!controller.signal.aborted) setBans(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [server.id]);

  async function unban(ban: Ban) {
    setBusy(ban.user.id);
    setError("");
    try { await api.unban(server.id, ban.user.id); setBans(current => current?.filter(b => b.user.id !== ban.user.id) ?? null); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  return <div className="settings-section">
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!bans && !error && <p className="muted" role="status">Carregando banimentos…</p>}
    {bans && !bans.length && <p className="muted">Ninguém foi banido deste servidor.</p>}
    {!!bans?.length && <ul className="people-list" aria-label="Pessoas banidas">
      {bans.map(ban => <li key={ban.user.id}><Avatar name={ban.user.name} src={ban.user.avatar} still={ban.user.avatarStill} size="sm" />
        <div><strong>{ban.user.name}</strong><small>{ban.reason || "Sem motivo informado"} · {new Date(ban.createdAt).toLocaleDateString("pt-BR")}</small></div>
        <button type="button" className="button secondary small" disabled={busy === ban.user.id} onClick={() => void unban(ban)}>Desbanir</button>
      </li>)}
    </ul>}
  </div>;
}
