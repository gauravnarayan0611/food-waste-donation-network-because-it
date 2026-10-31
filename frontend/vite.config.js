import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5173",
      "/socket.io": {
        target: "http://127.0.0.1:5173",
        ws: true
      }
    }
  },
  build: {
    emptyOutDir: true
  }
});
