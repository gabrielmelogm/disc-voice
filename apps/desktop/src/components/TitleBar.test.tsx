import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => tauri);

const win = vi.hoisted(() => ({
  isDecorated: vi.fn(() => Promise.resolve(false)),
  isMaximized: vi.fn(() => Promise.resolve(false)),
  onResized: vi.fn(() => Promise.resolve(() => {})),
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { TitleBar } from "./TitleBar";

beforeEach(() => {
  vi.clearAllMocks();
  tauri.isTauri.mockReturnValue(true);
  win.isDecorated.mockResolvedValue(false);
  win.isMaximized.mockResolvedValue(false);
});

describe("TitleBar", () => {
  it("is not shown outside the desktop app", () => {
    tauri.isTauri.mockReturnValue(false);
    const { container } = render(<TitleBar />);
    expect(container).toBeEmptyDOMElement();
    expect(win.isDecorated).not.toHaveBeenCalled();
  });

  it("is not shown while the native title bar is on", async () => {
    win.isDecorated.mockResolvedValue(true);
    const { container } = render(<TitleBar />);
    await waitFor(() => expect(win.isDecorated).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("controls the window when the native title bar is off", async () => {
    render(<TitleBar />);
    fireEvent.click(await screen.findByRole("button", { name: "Minimizar" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximizar" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(win.minimize).toHaveBeenCalled();
    expect(win.toggleMaximize).toHaveBeenCalled();
    expect(win.close).toHaveBeenCalled();
  });

  it("offers to restore a maximized window", async () => {
    win.isMaximized.mockResolvedValue(true);
    render(<TitleBar />);
    expect(await screen.findByRole("button", { name: "Restaurar" })).toBeInTheDocument();
  });
});
