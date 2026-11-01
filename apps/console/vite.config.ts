import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { docs } from "./docs/plugin";
import { script } from "./script/plugin";

// The console and the API share one origin in development, so the session cookie works without CORS.
const api = process.env.KAIROS_URL || "http://localhost:8787";

export default defineConfig({
  plugins: [react(), docs(), script()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        docs: fileURLToPath(new URL("./docs/index.html", import.meta.url)),
      },
    },
  },
  server: {
    port: Number(process.env.CONSOLE_PORT ?? 5273),
    proxy: { "^/((v1|auth|app)/|mcp$)": { target: api } },
  },
});
