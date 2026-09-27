import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forwarded to the Symfony backend (run via `symfony server:start`
      // or `symfony server:start --port=8000` from backend/) — see
      // backend/src/Controller/StateController.php.
      "/api": {
        // LEDGER_API lets a second checkout (e.g. a worktree) point at its
        // own backend without colliding with one already on :8000.
        target: process.env.LEDGER_API ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
