import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

function getPixelOfficePort(): number {
  if (process.env.PIXEL_OFFICE_PORT) return parseInt(process.env.PIXEL_OFFICE_PORT);
  try {
    const yaml = fs.readFileSync(path.join(__dirname, "..", "config", "office.yaml"), "utf-8");
    const match = yaml.match(/pixel_office:\s*\n\s+port:\s*(\d+)/);
    if (match) return parseInt(match[1]);
  } catch {}
  return 3847;
}

const API_PORT = getPixelOfficePort();

export default defineConfig({
  root: "client",
  server: {
    port: 3848,
    strictPort: false,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
