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

  // Start ngrok tunnel if enabled
  if (process.env.NGROK_ENABLED === "true" && process.env.NGROK_AUTHTOKEN) {
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
      // Prefer PROJECT_DIR (set by listener), fall back to HOME.
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
  }
});
