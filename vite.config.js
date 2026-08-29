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
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
