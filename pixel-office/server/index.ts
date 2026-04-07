import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";
import { handleSSE } from "./sse.js";
import { seedActiveRoles } from "./seed.js";
import { resolveDbPath } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PIXEL_OFFICE_PORT ?? "3847");

// Load .env if present (for ngrok config)
// Try pixel-office/.env (one level up from server/) then two levels up (from dist/server/)
const envCandidates = [
  path.join(__dirname, "..", ".env"),       // tsx: server/ → pixel-office/
  path.join(__dirname, "..", "..", ".env"),  // compiled: dist/server/ → pixel-office/
];
const envPath = envCandidates.find((p) => fs.existsSync(p)) ?? "";
if (envPath) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

// Seed active roles into coordination DB before starting
try {
  seedActiveRoles(resolveDbPath());
} catch {
  console.log("[Seed] Could not locate DB, skipping seed");
}

const app = express();
app.use(cors());
app.use(express.json());

// API routes
app.use("/api", createRouter());

// SSE stream
app.get("/api/stream", handleSSE);

// Serve built client — check tsx and compiled paths
const clientCandidates = [
  path.join(__dirname, "..", "client", "dist"),   // tsx: server/ → pixel-office/client/dist/
  path.join(__dirname, "..", "client"),            // compiled: dist/server/ → dist/client/ (legacy)
];
const clientDist = clientCandidates.find((p) => fs.existsSync(path.join(p, "index.html"))) ?? clientCandidates[0];
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  const indexPath = path.join(clientDist, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(503).send("Pixel Office client not built. Run: cd pixel-office && npm run build:client");
  }
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[PixelOffice] API server running at http://0.0.0.0:${PORT}`);
  console.log(`[PixelOffice] Open http://localhost:3848 for dev client (vite)`);

  // Remote access based on NGROK_MODE
  const ngrokMode = process.env.NGROK_MODE ?? "disabled";

  if (ngrokMode === "internal" && process.env.NGROK_AUTHTOKEN) {
    try {
      const ngrok = await import("@ngrok/ngrok");
      const authUser = process.env.PIXEL_AUTH_USER ?? "";
      const authPass = process.env.PIXEL_AUTH_PASS ?? "";
      const basicAuth = authUser && authPass ? `${authUser}:${authPass}` : undefined;

      const listener = await ngrok.default.forward({
        addr: PORT,
        authtoken: process.env.NGROK_AUTHTOKEN,
        basic_auth: basicAuth,
      });

      const publicUrl = listener.url();
      console.log(`[PixelOffice] 🌐 Public URL: ${publicUrl}`);
      if (basicAuth) {
        console.log(`[PixelOffice] 🔒 Protected with Basic Auth (user: ${authUser})`);
      }

      // Write URL to state file so the listener daemon can share it on Discord.
      try {
        const baseDir = process.env.PROJECT_DIR ?? process.env.HOME ?? "";
        const stateDir = path.join(baseDir, ".ai-office", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, "ngrok-url.txt"), publicUrl ?? "", "utf-8");
      } catch { /* non-critical */ }
    } catch (err) {
      console.error(`[PixelOffice] ngrok failed:`, (err as Error).message);
      console.log(`[PixelOffice] Pixel Office is still running locally at http://localhost:${PORT}`);
    }
  } else if (ngrokMode === "external") {
    // User runs ngrok externally — auto-detect URL from ngrok local API
    let publicUrl = process.env.PIXEL_PUBLIC_URL ?? "";
    if (!publicUrl) {
      // Poll ngrok API (localhost:4040) to find the tunnel URL for our port
      const ngrokApi = process.env.NGROK_API_URL ?? "http://localhost:4040";
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const res = await fetch(`${ngrokApi}/api/tunnels`);
          const data = await res.json() as { tunnels: { public_url: string; config: { addr: string } }[] };
          const tunnel = data.tunnels.find(t => t.config.addr.includes(String(PORT)));
          if (tunnel) {
            publicUrl = tunnel.public_url;
            break;
          }
        } catch { /* ngrok may not be ready yet */ }
        await new Promise(r => setTimeout(r, 2000)); // retry every 2s
      }
    }
    if (publicUrl) {
      console.log(`[PixelOffice] 🌐 Public URL (external ngrok): ${publicUrl}`);
      try {
        const baseDir = process.env.PROJECT_DIR ?? process.env.HOME ?? "";
        const stateDir = path.join(baseDir, ".ai-office", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, "ngrok-url.txt"), publicUrl, "utf-8");
      } catch { /* non-critical */ }
    } else {
      console.log(`[PixelOffice] ⚠️ external ngrok mode but could not detect tunnel URL (is ngrok running?)`);
    }
  } else if (ngrokMode === "custom") {
    const publicUrl = process.env.PIXEL_PUBLIC_URL ?? "";
    if (publicUrl) {
      console.log(`[PixelOffice] 🌐 Public URL (custom): ${publicUrl}`);
      try {
        const baseDir = process.env.PROJECT_DIR ?? process.env.HOME ?? "";
        const stateDir = path.join(baseDir, ".ai-office", "state");
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, "ngrok-url.txt"), publicUrl, "utf-8");
      } catch { /* non-critical */ }
    } else {
      console.log(`[PixelOffice] ⚠️ custom mode but PIXEL_PUBLIC_URL not set in .env`);
    }
  } else {
    console.log(`[PixelOffice] Running locally at http://localhost:${PORT} (no remote access)`);
  }
});
