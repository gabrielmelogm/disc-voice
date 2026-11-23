import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Hash, Import, RefreshCw, X } from "lucide-react";
import type { DiscordImport, DiscordServer, Server } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { openExternal } from "../lib/external";
import type { Realtime } from "../lib/realtime";
import { Avatar } from "./ui";

const count = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "mensagem" : "mensagens"}`;

/** Human status of an import. */
export function importStatus(item: DiscordImport): { text: string; tone: "busy" | "ok" | "error" } {
  if (item.status === "error") return { text: item.error || "A importação falhou.", tone: "error" };
  if (item.phase === "history") {
    return item.status === "running" || item.imported > 0
      ? { text: `Importando histórico… ${count(item.imported)}`, tone: "busy" }
      : { text: "Na fila para importar", tone: "busy" };
  }
  return { text: `Importado · ${count(item.imported)}`, tone: "ok" };
}

/** Replaces an import wherever it appears in the server view. */
function withImport(view: DiscordServer, item: DiscordImport): DiscordServer {
  return {
    ...view,
    imports: view.imports.some(i => i.channelId === item.channelId)
      ? view.imports.map(i => i.channelId === item.channelId ? item : i)
      : [...view.imports, item],
    guilds: view.guilds.map(guild => guild.id !== item.guildId ? guild : {
      ...guild,
      channels: guild.channels.map(c => c.id === item.discordChannelId ? { ...c, import: item } : c),
    }),
  };
}

/**
 * Connects Discord servers (by installing the bot) and imports their text
 * channels into read-only channels of this server.
 */
export function DiscordImportDialog({ server, realtime, onClose, onOpenChannel }: {
  server: Server;
  realtime: Realtime;
  onClose: () => void;
  onOpenChannel: (channelId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<DiscordServer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    return api.serverDiscord(server.id, signal)
      .then(result => { if (!signal?.aborted) { setView(result); setError(""); } })
      .catch(cause => { if (!signal?.aborted) setError(message(cause)); })
      .finally(() => { if (!signal?.aborted) setLoading(false); });
  }, [server.id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => realtime.onEvent(event => {
    if (event.type === "discord.import" && event.serverId === server.id) setView(current => current && withImport(current, event.import));
    if (event.type === "discord.updated" && event.serverId === server.id) { setWaiting(false); void load(); }
  }), [realtime, server.id, load]);

  // Back from the browser after installing the bot.
  useEffect(() => {
    if (!waiting) return;
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [waiting, load]);

  async function act(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError("");
    try { await action(); }
    catch (cause) { setError(message(cause)); }
    finally { setBusy(null); }
  }

  const connect = () => act("connect", async () => {
    const { url } = await api.installDiscord(server.id);
    await openExternal(url);
    setWaiting(true);
  });

  const listed = new Set(view?.guilds.flatMap(g => g.channels.map(c => c.id)) || []);
  const orphans = view?.imports.filter(i => !listed.has(i.discordChannelId)) || [];

  return <dialog ref={ref} className="action-dialog discord-dialog" aria-labelledby="discord-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id="discord-title">Importar do Discord</h2><button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><X size={20} /></button></div>
    <p className="lede">Instale o bot do Disc Voice em um servidor do Discord e escolha os canais de texto. O histórico de cada um vira um canal em <strong>{server.name}</strong>, com as imagens e vídeos. Depois disso, a conversa continua só no Disc Voice.</p>

    {view?.messageContent === false && <div className="notice warning" role="note"><AlertTriangle size={18} /><p><strong>O bot está sem acesso ao conteúdo das mensagens.</strong>Ative o “Message Content Intent” no Discord Developer Portal; sem ele as mensagens chegam sem texto.</p></div>}
    {waiting && <p className="notice" role="status">Conclua a instalação no navegador. Esta janela atualiza sozinha quando você voltar.</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading && !view && <p className="muted" role="status">Carregando…</p>}

    {view?.guilds.map(guild => <section key={guild.id} className="discord-guild" aria-label={`Servidor do Discord ${guild.name}`}>
      <header>
        <Avatar name={guild.name} src={guild.icon} size="sm" square />
        <strong>{guild.name}</strong>
        {confirm === guild.id
          ? <span className="button-row"><button className="button danger small" disabled={!!busy} onClick={() => void act(`unlink:${guild.id}`, async () => { await api.unlinkGuild(server.id, guild.id); setConfirm(null); await load(); })}>Desconectar</button><button className="link-button" onClick={() => setConfirm(null)}>Cancelar</button></span>
          : <button className="link-button subtle" onClick={() => setConfirm(guild.id)}>Desconectar</button>}
      </header>
      {confirm === guild.id && <p className="field-help">Os canais já importados continuam aqui com as mensagens. Importações em andamento param.</p>}
      {guild.error && <p className="inline-error">{guild.error}</p>}
      {guild.available && !guild.channels.length && <p className="muted">Nenhum canal de texto encontrado.</p>}
      <ul className="discord-channels">
        {guild.channels.map(channel => {
          const item = channel.import;
          const state = item && importStatus(item);
          return <li key={channel.id}>
            <div className="discord-channel-name"><Hash size={16} aria-hidden="true" /><span>{channel.name}</span>{channel.category && <small>{channel.category}</small>}</div>
            {item && state ? <>
              <small className={`import-status ${state.tone}`} role={state.tone === "error" ? "alert" : undefined}>{state.text}</small>
              <div className="button-row">
                {item.status === "error" && item.phase === "history" && <>
                  <button className="link-button" disabled={!!busy} onClick={() => void act(`retry:${item.channelId}`, async () => { await api.retryDiscord(item.channelId); })}>
                    <RefreshCw size={14} />Tentar de novo
                  </button>
                  <button className="link-button subtle" disabled={!!busy} title="O canal fica com as mensagens já importadas e passa a aceitar mensagens novas."
                    onClick={() => void act(`finish:${item.channelId}`, async () => { await api.finishDiscord(item.channelId); })}>
                    Concluir com o que já foi importado
                  </button>
                </>}
                <button className="link-button" onClick={() => onOpenChannel(item.channelId)}>Abrir</button>
              </div>
            </> : channel.readable
              ? <button className="button secondary small" disabled={!!busy} onClick={() => void act(`import:${channel.id}`, async () => {
                const created = await api.importDiscord(server.id, guild.id, channel.id);
                setView(current => current && withImport(current, created));
              })}><Import size={14} />{busy === `import:${channel.id}` ? "Importando…" : "Importar"}</button>
              : <small className="import-status error" title="Dê ao bot as permissões Ver canal e Ler histórico de mensagens neste canal.">Sem permissão para ler</small>}
          </li>;
        })}
      </ul>
    </section>)}

    {orphans.length > 0 && <section className="discord-guild" aria-label="Outras importações">
      <header><strong>Outras importações</strong></header>
      <ul className="discord-channels">{orphans.map(item => {
        const state = importStatus(item);
        return <li key={item.channelId}>
          <div className="discord-channel-name"><Hash size={16} aria-hidden="true" /><span>{item.discordChannelName}</span></div>
          <small className={`import-status ${state.tone}`}>{state.text}</small>
          <button className="link-button" onClick={() => onOpenChannel(item.channelId)}>Abrir</button>
        </li>;
      })}</ul>
    </section>}

    {view && !view.guilds.length && <p className="dialog-empty">Nenhum servidor do Discord conectado ainda. Você precisa da permissão “Gerenciar servidor” no Discord para instalar o bot.</p>}
    {(view || !error) && <button className="button primary full" disabled={busy === "connect"} onClick={() => void connect()}><ExternalLink size={16} />{view?.guilds.length ? "Conectar outro servidor do Discord" : "Conectar servidor do Discord"}</button>}
  </dialog>;
}
