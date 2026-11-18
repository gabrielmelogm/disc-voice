import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Realtime } from "./realtime";
import { sessionToken } from "./api";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send = vi.fn();
  constructor(public url: string) { Socket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  event(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  sessionToken.set("a".repeat(64));
});
afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); });

it("authenticates in a frame and synchronizes history after the server acknowledges the subscription", () => {
  const client = new Realtime();
  client.watch("server-1");
  client.start();
  const socket = Socket.instances[0];
  socket.open();
  expect(socket.url).not.toContain(sessionToken.get());
  expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({ type: "authenticate", token: sessionToken.get() });
  socket.event({ type: "ready", peerId: "peer" });
  expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual({ type: "server.watch", serverId: "server-1" });
  const revision = client.getSnapshot().revision;
  socket.event({ type: "server.snapshot", serverId: "server-1", channels: {} });
  expect(client.getSnapshot().revision).toBeGreaterThan(revision);
  client.stop();
});

it("reconnects after loss and ignores events from the old socket", async () => {
  const client = new Realtime();
  client.start();
  const first = Socket.instances[0];
  first.open();
  first.event({ type: "ready", peerId: "first" });
  first.close();
  expect(client.getSnapshot().status).toBe("reconnecting");
  await vi.advanceTimersByTimeAsync(500);
  const second = Socket.instances[1];
  first.event({ type: "ready", peerId: "stale" });
  expect(client.getSnapshot().status).toBe("reconnecting");
  second.open();
  second.event({ type: "ready", peerId: "second" });
  expect(client.getSnapshot().status).toBe("connected");
  client.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(Socket.instances).toHaveLength(2);
});
