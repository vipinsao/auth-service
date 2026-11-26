import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the UI runs on :3000 and the API on :5501. Proxying the API
// paths keeps the browser on one origin, exactly like production (where the
// API serves this build itself), so the strict same-site cookies just work.
const api = "http://localhost:5501";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: { "/auth": api, "/users": api, "/health": api, "/api-docs": api },
  },
});
