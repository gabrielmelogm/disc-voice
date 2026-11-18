import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  publicDir: "../../public",
  envDir: "../..",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:3001", ws: true } },
  },
  build: { target: "es2022" },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
