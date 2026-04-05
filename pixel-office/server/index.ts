import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";
import { handleSSE } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PIXEL_OFFICE_PORT ?? "3847");

const app = express();
app.use(cors());
app.use(express.json());

// API routes
app.use("/api", createRouter());

// SSE stream
app.get("/api/stream", handleSSE);

// Serve built client in production
const clientDist = path.join(__dirname, "..", "client");
app.use(express.static(clientDist));
app.get("*", (_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[PixelOffice] API server running at http://0.0.0.0:${PORT}`);
  console.log(`[PixelOffice] Open http://localhost:3848 for dev client (vite)`);
});
