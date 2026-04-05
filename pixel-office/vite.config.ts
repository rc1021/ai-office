import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  server: {
    port: 3848,
    strictPort: false,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3847",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
