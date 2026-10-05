import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["@clinicvoice/source"] },
  server: {
    port: 5173,
    // Dev only: the API runs on :3000. In production the dashboard calls VITE_API_BASE_URL.
    proxy: { "/api": "http://localhost:3000", "/healthz": "http://localhost:3000" },
  },
});
