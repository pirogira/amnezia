import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@amnesia-veb/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    /**
     * На Windows браузер часто ходит на localhost → ::1 (IPv6), а дефолтный Vite слушает только IPv4 —
     * в Opera/Chrome это даёт ERR_CONNECTION_REFUSED. host: true слушает и :: и 0.0.0.0.
     */
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
