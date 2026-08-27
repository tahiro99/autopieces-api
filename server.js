import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { pool } from "./db.js";
import authRoutes from "./routes/auth.routes.js";
import listingRoutes from "./routes/listings.routes.js";

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

// ── 404 ──
app.use((req, res) => res.status(404).json({ error: "Route inconnue" }));

// ── Erreurs non gérées ──
app.use((err, req, res, next) => {
  console.error("[erreur]", err.message);
  res.status(500).json({ error: "Erreur serveur" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API sur http://localhost:${PORT}`));