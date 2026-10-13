import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@bellgrave/combat": path.resolve(__dirname, "../../packages/combat/src/index.ts"),
      "@bellgrave/config": path.resolve(__dirname, "../../packages/config/src/index.ts"),
      "@bellgrave/protocol": path.resolve(__dirname, "../../packages/protocol/src/index.ts"),
    },
  },
  server: {
    // 0.0.0.0 so Cursor can forward the site. 127.0.0.1 alone is invisible
    // outside this machine, which shows up as a black page on localhost:5173.
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
});
