import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  publicDir: "../../public",
  // Tests (Vitest runs in "test" mode) skip the developer's .env: they call
  // the API at "/api", whatever the local app is pointed to (src/test has no .env).
  envDir: mode === "test" ? "./src/test" : "../..",
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
}));
