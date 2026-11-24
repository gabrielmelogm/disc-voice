import { useEffect, useState } from "react";
import type { AuthSession, Server, User } from "@disc-voice/shared";
import { AuthScreen } from "./components/AuthScreen";
import { InvitePage } from "./components/InvitePage";
import { ServerWorkspace } from "./components/ServerWorkspace";
import { api, ApiError, clearPendingInvite, message, pendingInvite, sessionToken } from "./lib/api";
import { completeDiscordRedirect, isDiscordCallback } from "./lib/discordLogin";
import { completeGoogleRedirect, isGoogleCallback } from "./lib/google";
import { useAppearance } from "./lib/theme";

export function App() {
  useAppearance();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!sessionToken.get());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteCode, setInviteCode] = useState(pendingInvite);
  const [joined, setJoined] = useState<Server | null>(null);
  const [retry, setRetry] = useState(0);
  // Back from Google or Discord in the browser build: finish signing in first.
  const [completing, setCompleting] = useState<"google" | "discord" | null>(() =>
    isGoogleCallback() ? "google" : isDiscordCallback() ? "discord" : null);

  useEffect(() => {
    if (!completing) return;
    let active = true;
    (completing === "discord" ? completeDiscordRedirect() : completeGoogleRedirect())
      .then(session => { if (active) authenticated(session); })
      .catch(cause => { if (active) setNotice(message(cause)); })
      .finally(() => { if (active) setCompleting(null); });
    return () => { active = false; };
  }, [completing]);

  useEffect(() => {
    const expired = () => {
      setUser(null); setLoading(false);
      setNotice("Sua sessão expirou. Entre novamente para continuar.");
    };
    window.addEventListener("discvoice:session-expired", expired);
    return () => window.removeEventListener("discvoice:session-expired", expired);
  }, []);

  useEffect(() => {
    if (!sessionToken.get()) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api.me(controller.signal).then(result => {
      if (!controller.signal.aborted) setUser(result);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (!(cause instanceof ApiError && cause.status === 401)) setError(message(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);

  function authenticated(session: AuthSession) {
    sessionToken.set(session.token);
    setUser(session.user);
    setNotice("");
    setError("");
  }

  function closeInvite(server: Server | null) {
    clearPendingInvite();
    setInviteCode("");
    setJoined(server);
  }

  async function logout() {
    await api.logout();
    sessionToken.clear();
    setUser(null);
    setJoined(null);
  }

  if (completing) return <main className="session-status" role="status">{completing === "discord" ? "Entrando com Discord…" : "Entrando com Google…"}</main>;
  if (loading) return <main className="session-status" role="status">Conectando ao Disc Voice…</main>;
  if (error && !user) return <main className="session-status"><p role="alert">{error}</p><button className="button primary" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button><button className="link-button" onClick={() => { sessionToken.clear(); setError(""); }}>Voltar ao login</button></main>;
  if (!user) return <AuthScreen onAuthenticated={authenticated} hasInvite={!!inviteCode} notice={notice} />;
  if (inviteCode) return <InvitePage code={inviteCode} user={user} onJoined={closeInvite} onDismiss={() => closeInvite(null)} onSwitchAccount={() => {
    // Keep the pending invite so it is offered again to the next account.
    void logout().catch(() => { sessionToken.clear(); setUser(null); });
  }} />;
  return <ServerWorkspace key={user.id} user={user} joinedServer={joined} onLogout={logout} onUserChange={setUser} />;
}
