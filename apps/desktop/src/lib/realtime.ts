import type { RealtimeCommand, RealtimeEvent } from "@disc-voice/shared";
import { realtimeUrl, sessionToken } from "./api";

export type RealtimeStatus = "connecting" | "connected" | "reconnecting" | "offline";

export class Realtime {
  private socket?: WebSocket;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = true;
  private attempts = 0;
  private watching: string | null = null;
  private lastSeen = 0;
  private listeners = new Set<(event: RealtimeEvent) => void>();
  private changes = new Set<() => void>();
  private snapshot = { status: "connecting" as RealtimeStatus, revision: 0 };
  /** When the unanswered ping left; 0 when none is out. */
  private pingSent = 0;
  private latencyMs: number | null = null;
  private latencyListeners = new Set<(ms: number | null) => void>();

  /**
   * Round trip to the API in milliseconds, from the heartbeat; `null` while
   * disconnected. Kept out of the snapshot so it never re-renders the app.
   */
  get latency() { return this.latencyMs; }
  onLatency = (listener: (ms: number | null) => void) => {
    this.latencyListeners.add(listener);
    return () => { this.latencyListeners.delete(listener); };
  };
  private setLatency(ms: number | null) {
    if (ms === this.latencyMs) return;
    this.latencyMs = ms;
    this.latencyListeners.forEach(listener => listener(ms));
  }
  private ping() {
    this.pingSent = Date.now();
    this.send({ type: "ping" });
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  };
  onEvent = (listener: (event: RealtimeEvent) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private status(status: RealtimeStatus) {
    if (status !== "connected") {
      this.pingSent = 0;
      this.setLatency(null);
    }
    this.snapshot = { status, revision: this.snapshot.revision + (status === "connected" ? 1 : 0) };
    this.changes.forEach(listener => listener());
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.status("offline");
  }

  watch(serverId: string | null) {
    this.watching = serverId;
    if (this.snapshot.status === "connected") this.send({ type: "server.watch", serverId });
  }

  send(command: RealtimeCommand) {
    if (this.socket?.readyState !== WebSocket.OPEN || this.snapshot.status !== "connected") {
      throw new Error("A conexão em tempo real está indisponível. Aguarde a reconexão.");
    }
    this.socket.send(JSON.stringify(command));
  }

  private connect() {
    if (this.stopped || !sessionToken.get()) return;
    this.status(this.attempts ? "reconnecting" : "connecting");
    const socket = new WebSocket(realtimeUrl());
    this.socket = socket;
    this.lastSeen = Date.now();
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: "authenticate", token: sessionToken.get() }));
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      let data: RealtimeEvent;
      try { data = JSON.parse(String(event.data)) as RealtimeEvent; } catch { socket.close(); return; }
      this.lastSeen = Date.now();
      if (data.type === "session.expired") {
        this.stop();
        sessionToken.clear();
        window.dispatchEvent(new Event("discvoice:session-expired"));
        return;
      }
      if (data.type === "pong" && this.pingSent) {
        this.setLatency(Date.now() - this.pingSent);
        this.pingSent = 0;
      }
      if (data.type === "ready") {
        this.attempts = 0;
        this.status("connected");
        this.watch(this.watching);
        // Measure right away instead of after the first heartbeat.
        this.ping();
      }
      if (data.type === "server.snapshot" && data.serverId === this.watching) {
        // Synchronize history after the subscription is acknowledged, closing
        // the gap between an HTTP snapshot and the server starting live events.
        this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
        this.changes.forEach(listener => listener());
      }
      this.listeners.forEach(listener => listener(data));
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = undefined;
      clearInterval(this.heartbeat);
      this.status("reconnecting");
      this.retry = setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.attempts++));
    };
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > (this.snapshot.status === "connected" ? 45_000 : 10_000)) {
        // Detach immediately, even when the browser takes time to close a dead TCP connection.
        socket.close();
        socket.onclose?.(new CloseEvent("close"));
      } else if (this.snapshot.status === "connected") {
        this.ping();
      }
    }, 5_000);
  }
}
