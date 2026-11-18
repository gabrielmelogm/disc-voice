import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ScreenShareController } from "../hooks/useScreenShare";
import { ScreenShareTest } from "./ScreenShareTest";

vi.mock("../lib/nativeScreen", () => ({
  nativeScreen: { frame: vi.fn(async () => new ArrayBuffer(0)) },
}));

function controller(overrides: Partial<ScreenShareController> = {}): ScreenShareController {
  return {
    status: "idle", info: null, error: null,
    start: vi.fn(async () => {}), stop: vi.fn(), previewFailed: vi.fn(),
    ...overrides,
  };
}

describe("screen share test card", () => {
  it("starts sharing with the chosen resolution, frame rate and cursor", async () => {
    const user = userEvent.setup();
    const screenShare = controller();
    render(<ScreenShareTest screen={screenShare} />);
    await user.selectOptions(screen.getByLabelText("Resolução máxima"), "1080p");
    await user.selectOptions(screen.getByLabelText("Taxa de quadros"), "60");
    await user.click(screen.getByLabelText("Mostrar o cursor do mouse"));
    await user.click(screen.getByRole("button", { name: "Compartilhar tela" }));
    expect(screenShare.start).toHaveBeenCalledWith({ maxWidth: 1920, maxHeight: 1080, frameRate: 60, cursor: false });
  });

  it("offers to cancel while the system picker is open", async () => {
    const user = userEvent.setup();
    const screenShare = controller({ status: "picking" });
    render(<ScreenShareTest screen={screenShare} />);
    expect(screen.getByRole("status")).toHaveTextContent("Aguardando a escolha…");
    expect(screen.getByLabelText("Resolução máxima")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screenShare.stop).toHaveBeenCalled();
  });

  it("shows the shared source while live", async () => {
    const user = userEvent.setup();
    const screenShare = controller({
      status: "live",
      info: { source: "monitor", width: 2560, height: 1440, maxWidth: 1280, maxHeight: 720, frameRate: 30, cursor: true },
    });
    render(<ScreenShareTest screen={screenShare} />);
    expect(screen.getByText("Compartilhando")).toBeVisible();
    expect(screen.getByText("Tela inteira · 2560 × 1440")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Parar compartilhamento" }));
    expect(screenShare.stop).toHaveBeenCalled();
  });

  it("explains that sharing is not available on this platform", () => {
    render(<ScreenShareTest screen={controller({ status: "unavailable" })} />);
    expect(screen.getByText(/disponível somente no aplicativo para Windows e Linux/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Compartilhar tela" })).toBeDisabled();
  });

  it("shows sharing errors", () => {
    render(<ScreenShareTest screen={controller({ error: "O compartilhamento de tela foi encerrado." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("O compartilhamento de tela foi encerrado.");
  });
});
