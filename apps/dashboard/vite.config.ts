import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["@clinicvoice/source"] },
  server: {
    port: 5173,
    // Dev only: same-origin /api, like the Vercel rewrite in production, so the session cookie works.
    // Override with API_PROXY_TARGET when the server runs on another port.
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://localhost:3000" },
  },
});
