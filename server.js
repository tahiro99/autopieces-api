import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool } from "./db.js";

import helmet from "helmet";
import authRoutes from "./routes/auth.routes.js";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(helmet());
app.set("trust proxy", 1);   // nécessaire derrière Nginx pour obtenir la vraie IP
app.use("/auth", authRoutes);
// Santé du serveur
app.get("/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT now()");
    res.json({ ok: true, time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Catalogue paginé
app.get("/listings", async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const { wilaya, category, condition, sellerId, q } = req.query;

    const where = ["status = 'active'"];
    const vals  = [];

    if (wilaya)    { vals.push(wilaya);    where.push(`wilaya = $${vals.length}`); }
    if (category)  { vals.push(category);  where.push(`category = $${vals.length}`); }
    if (condition) { vals.push(condition); where.push(`condition = $${vals.length}`); }
    if (sellerId)  { vals.push(sellerId);  where.push(`seller_id = $${vals.length}`); }
    if (q) {
      vals.push(q);
      where.push(`to_tsvector('french', title || ' ' || coalesce(description,''))
                  @@ plainto_tsquery('french', $${vals.length})`);
    }

    vals.push(limit, offset);

    const sql = `
      SELECT * FROM listings
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${vals.length - 1} OFFSET $${vals.length}
    `;

    const r = await pool.query(sql, vals);
    res.json({ items: r.rows, hasMore: r.rows.length === limit });
  } catch (e) {
    console.error("[listings]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Une annonce
app.get("/listings/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM listings WHERE id = $1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Introuvable" });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API sur http://localhost:${PORT}`));