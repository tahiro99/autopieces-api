import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "path";
import { createServer } from "http";
import { pool } from "./db.js";
import { initSocket } from "./socket.js";
import { startJobs } from "./jobs.js";
import authRoutes from "./routes/auth.routes.js";
import listingRoutes from "./routes/listings.routes.js";
import marketRoutes from "./routes/market.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import userRoutes from "./routes/user.routes.js";

dotenv.config();
const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);

// Limite globale par IP
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health",  
  message: { error: "Trop de requêtes, patientez un instant" },
}));
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT now()");
    res.json({ ok: true, time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use("/uploads", express.static(path.resolve("uploads"), { maxAge: "30d" }));

app.use("/auth", authRoutes);
app.use("/listings", listingRoutes);
app.use("/", marketRoutes);
app.use("/", chatRoutes);
app.use("/", userRoutes);
app.use((req, res) => res.status(404).json({ error: "Route inconnue" }));

app.use((err, req, res, next) => {
  console.error("[erreur]", err.message);
  res.status(500).json({ error: "Erreur serveur" });
});

const httpServer = createServer(app);
const io = initSocket(httpServer);
app.set("io", io);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`API + WebSocket sur http://localhost:${PORT}`);
  startJobs();
});
