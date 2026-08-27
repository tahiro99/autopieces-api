import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { pool } from "./db.js";
import authRoutes from "./routes/auth.routes.js";
import listingRoutes from "./routes/listings.routes.js";
import marketRoutes from "./routes/market.routes.js";
import { createServer } from "http";
import { initSocket } from "./socket.js";
import chatRoutes from "./routes/chat.routes.js";
import userRoutes from "./routes/user.routes.js";
import path from "path";
dotenv.config();
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);   // nécessaire derrière Nginx pour obtenir la vraie IP

// ── Santé du serveur ──
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT now()");
    res.json({ ok: true, time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Routes ──
app.use("/auth", authRoutes);
app.use("/listings", listingRoutes);
app.use("/", marketRoutes);
app.use("/", chatRoutes);
app.use("/", userRoutes);
app.use("/uploads", express.static(path.resolve("uploads"), { maxAge: "30d" }));
// ── 404 ──
app.use((req, res) => res.status(404).json({ error: "Route inconnue" }));

// ── Erreurs non gérées ──
app.use((err, req, res, next) => {
  console.error("[erreur]", err.message);
  res.status(500).json({ error: "Erreur serveur" });
});


const httpServer = createServer(app);
const io = initSocket(httpServer);
app.set("io", io);   // accessible depuis les routes
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`API + WebSocket sur http://localhost:${PORT}`));