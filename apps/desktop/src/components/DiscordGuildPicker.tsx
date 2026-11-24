import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Import, LoaderCircle } from "lucide-react";
import type { DiscordGuildOption, Server } from "@disc-voice/shared";
import { api, message } from "../lib/api";
import { openExternal } from "../lib/external";
import type { Realtime } from "../lib/realtime";
import { Avatar } from "./ui";

/** Where the import of one Discord server stands. */
type Progress =
  | { stage: "importing" }
  /** The server exists; the bot is being added on Discord's page. */
  | { stage: "installing"; server: Server }
  | { stage: "done"; server: Server; text: string };

const channelCount = (n: number) => `${n} ${n === 1 ? "canal" : "canais"}`;

/**
 * The Discord servers the user manages. Importing one creates a Disc Voice
 * server with its name and icon, then its text and voice channels (after
 * adding the bot to it when it isn't there yet).
 */
export function DiscordGuildPicker({ realtime, onServer, onOpen }: {
  realtime?: Realtime;
  /** A server was created (its channels may still be on their way). */
  onServer: (server: Server) => void;
  /** Opens a server imported earlier. */
  onOpen?: (serverId: string) => void;
}) {
  const [guilds, setGuilds] = useState<DiscordGuildOption[] | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Record<string, Progress>>({});

  const load = useCallback((signal?: AbortSignal) => api.discordGuilds(signal)
    .then(result => { if (!signal?.aborted) { setGuilds(result); setError(""); } })
    .catch(cause => { if (!signal?.aborted) setError(message(cause)); }), []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The API announces the server's channels once the bot is in.
  useEffect(() => realtime?.onEvent(event => {
    if (event.type !== "discord.updated" || !event.serverId) return;
    setProgress(current => {
      const entry = Object.entries(current).find(([, p]) => p.stage === "installing" && p.server.id === event.serverId);
      if (!entry) return current;
      const [guild, p] = entry as [string, Extract<Progress, { stage: "installing" }>];
      return { ...current, [guild]: { stage: "done", server: p.server, text: "Importado com os canais do Discord." } };
    });
    void load();
  }), [realtime, load]);

  async function importGuild(guild: DiscordGuildOption) {
    setProgress(current => ({ ...current, [guild.id]: { stage: "importing" } }));
    setError("");
    try {
      const result = await api.importDiscordGuild(guild.id);
      const server = result.server.server;
      onServer(server);
      if (result.installUrl) {
        setProgress(current => ({ ...current, [guild.id]: { stage: "installing", server } }));
        await openExternal(result.installUrl);
      } else {
        const text = result.warning || `Importado com ${channelCount(result.channels)}.`;
        setProgress(current => ({ ...current, [guild.id]: { stage: "done", server, text } }));
        void load();
      }
    } catch (cause) {
      setProgress(current => { const next = { ...current }; delete next[guild.id]; return next; });
      setError(message(cause));
    }
  }

  if (!guilds) {
    return <>
      {!error && <p className="muted" role="status">Carregando seus servidores do Discord…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </>;
  }

  return <div className="stack-form">
    {!guilds.length && <p className="dialog-empty">Você não é dono nem gerencia nenhum servidor do Discord. Só dá para importar servidores em que você tem a permissão Gerenciar Servidor.</p>}
    {!!guilds.length && <ul className="guild-options" aria-label="Seus servidores do Discord">
      {guilds.map(guild => {
        const state = progress[guild.id];
        const hint = state?.stage === "installing" ? "Adicione o bot no navegador; os canais aparecem sozinhos."
          : state?.stage === "done" ? state.text
          : guild.importedServerId ? "Já importado"
          : guild.botInstalled ? "Nome, ícone e canais vêm na hora"
          : "O bot do Disc Voice será adicionado para ler os canais";
        return <li key={guild.id}>
          <Avatar name={guild.name} src={guild.icon} size="md" square />
          <span className="guild-option-name"><strong>{guild.name}</strong><small role={state ? "status" : undefined}>{hint}</small></span>
          {state?.stage === "importing" ? <button className="button secondary small" disabled><LoaderCircle size={15} className="spin" />Importando…</button>
            : state?.stage === "installing" ? <button className="button secondary small" disabled><ExternalLink size={15} />No navegador</button>
            : state?.stage === "done" || guild.importedServerId
              ? <button className="button secondary small" disabled={!onOpen} onClick={() => onOpen?.(state?.stage === "done" ? state.server.id : guild.importedServerId!)}><Check size={15} />{onOpen ? "Abrir" : "Importado"}</button>
              : <button className="button primary small" aria-label={`Importar ${guild.name}`} disabled={Object.values(progress).some(p => p.stage === "importing")} onClick={() => void importGuild(guild)}><Import size={15} />Importar</button>}
        </li>;
      })}
    </ul>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
