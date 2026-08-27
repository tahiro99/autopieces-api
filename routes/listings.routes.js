import express from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth, optionalAuth } from "../auth.js";

const router = express.Router();

// ── Validation ──
const listingSchema = z.object({
  title:       z.string().min(3).max(200),
  description: z.string().max(5000).optional().default(""),
  price:       z.number().int().min(0).max(100_000_000),
  stock:       z.number().int().min(0).max(9999).optional().default(1),
  condition:   z.enum(["new", "used"]),
  category:    z.string().max(60).optional().nullable(),
  brand:       z.string().max(60).optional().nullable(),
  model:       z.string().max(60).optional().nullable(),
  year:        z.number().int().min(1950).max(2100).optional().nullable(),
  gearbox:     z.string().max(30).optional().nullable(),
  fuel:        z.string().max(30).optional().nullable(),
  wilaya:      z.string().max(60).optional().nullable(),
  lat:         z.number().min(-90).max(90).optional().nullable(),
  lng:         z.number().min(-180).max(180).optional().nullable(),
  photos:      z.array(z.string().url()).max(6).optional().default([]),
  compatibleVehicles: z.array(z.object({
    brand: z.string().max(60),
    model: z.string().max(60).optional().default(""),
  })).max(20).optional().default([]),
});

// Forme identique à ce que l'app attend aujourd'hui de Firestore
const toApi = (r) => ({
  id: r.id,
  sellerId: r.seller_id,
  sellerName: r.seller_name || "",
  title: r.title,
  description: r.description,
  price: r.price,
  stock: r.stock,
  condition: r.condition,
  category: r.category,
  brand: r.brand,
  model: r.model,
  year: r.year,
  gearbox: r.gearbox,
  fuel: r.fuel,
  wilaya: r.wilaya,
  lat: r.lat != null ? Number(r.lat) : null,
  lng: r.lng != null ? Number(r.lng) : null,
  photos: r.photos || [],
  img: (r.photos && r.photos[0]) || "",
  views: r.views,
  status: r.status,
  createdAt: r.created_at,
});

// Arrondi ~100 m : le vendeur n'expose pas son domicile exact
const blur = (v) => (v == null ? null : Math.round(Number(v) * 1000) / 1000);

// ── Abonnement actif ? ──
async function hasActiveSubscription(userId) {
  const r = await pool.query(`
    SELECT 1 FROM subscriptions
    WHERE user_id = $1 AND status IN ('trial','active') AND current_period_end > now()
    LIMIT 1
  `, [userId]);
  return r.rows.length > 0;
}

// ══ LISTE (publique) ══
router.get("/", optionalAuth, async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { wilaya, category, condition, sellerId, brand, q,
            priceMin, priceMax, yearFrom, yearTo, gearbox, fuel } = req.query;

    const where = ["l.status = 'active'"];
    const vals  = [];
    const add   = (v) => { vals.push(v); return `$${vals.length}`; };

    if (wilaya)    where.push(`l.wilaya = ${add(wilaya)}`);
    if (category)  where.push(`l.category = ${add(category)}`);
    if (condition) where.push(`l.condition = ${add(condition)}`);
    if (sellerId)  where.push(`l.seller_id = ${add(sellerId)}`);
    if (brand)     where.push(`l.brand = ${add(brand)}`);
    if (gearbox)   where.push(`l.gearbox = ${add(gearbox)}`);
    if (fuel)      where.push(`l.fuel = ${add(fuel)}`);
    if (priceMin)  where.push(`l.price >= ${add(Number(priceMin))}`);
    if (priceMax)  where.push(`l.price <= ${add(Number(priceMax))}`);
    if (yearFrom)  where.push(`l.year >= ${add(Number(yearFrom))}`);
    if (yearTo)    where.push(`l.year <= ${add(Number(yearTo))}`);
    if (q) {
      const p = add(q);
      where.push(`to_tsvector('french', l.title || ' ' || coalesce(l.description,''))
                  @@ plainto_tsquery('french', ${p})`);
    }

    // Masquer les annonces des vendeurs bloqués
    if (req.user) {
      where.push(`l.seller_id <> ALL(
        COALESCE((SELECT blocked_users FROM users WHERE id = ${add(req.user.id)}), '{}')
      )`);
    }

    const lim = add(limit), off = add(offset);

    const r = await pool.query(`
      SELECT l.*, u.display_name AS seller_name
      FROM listings l
      LEFT JOIN users u ON u.id = l.seller_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC
      LIMIT ${lim} OFFSET ${off}
    `, vals);

    res.json({ items: r.rows.map(toApi), hasMore: r.rows.length === limit });
  } catch (e) {
    console.error("[listings]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ DÉTAIL (publique) ══
router.get("/:id", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT l.*, u.display_name AS seller_name
      FROM listings l LEFT JOIN users u ON u.id = l.seller_id
      WHERE l.id = $1
    `, [req.params.id]);

    if (!r.rows.length) return res.status(404).json({ error: "Annonce introuvable" });

    const v = await pool.query(
      "SELECT brand, model FROM listing_vehicles WHERE listing_id = $1", [req.params.id]
    );

    res.json({ ...toApi(r.rows[0]), compatibleVehicles: v.rows });
  } catch (e) {
    res.status(400).json({ error: "Identifiant invalide" });
  }
});

// ══ CRÉER ══
router.post("/", requireAuth, async (req, res) => {
  const parsed = listingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données invalides", details: parsed.error.issues });
  }

  const client = await pool.connect();
  try {
    // Le rôle vendeur et l'abonnement sont vérifiés côté SERVEUR,
    // jamais côté app — le client est modifiable.
    const u = await client.query("SELECT role FROM users WHERE id = $1", [req.user.id]);
    if (u.rows[0]?.role !== "vendeur") {
      return res.status(403).json({ error: "Réservé aux vendeurs" });
    }
    if (!(await hasActiveSubscription(req.user.id))) {
      return res.status(402).json({ error: "Abonnement expiré", code: "subscription_required" });
    }

    // Anti-spam : 5 annonces par heure maximum
    const recent = await client.query(`
      SELECT count(*)::int AS n FROM listings
      WHERE seller_id = $1 AND created_at > now() - interval '1 hour'
    `, [req.user.id]);
    if (recent.rows[0].n >= 5) {
      return res.status(429).json({ error: "Limite de 5 annonces par heure atteinte" });
    }

    const d = parsed.data;
    await client.query("BEGIN");

    const r = await client.query(`
      INSERT INTO listings (seller_id, title, description, price, stock, condition,
                            category, brand, model, year, gearbox, fuel, wilaya,
                            lat, lng, photos)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [
      req.user.id, d.title.trim(), d.description, d.price, d.stock, d.condition,
      d.category, d.brand, d.model, d.year, d.gearbox, d.fuel, d.wilaya,
      blur(d.lat), blur(d.lng), d.photos,
    ]);

    for (const v of d.compatibleVehicles) {
      await client.query(
        "INSERT INTO listing_vehicles (listing_id, brand, model) VALUES ($1,$2,$3)",
        [r.rows[0].id, v.brand, v.model]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(toApi(r.rows[0]));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[create listing]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// ══ MODIFIER ══
router.patch("/:id", requireAuth, async (req, res) => {
  const parsed = listingSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Données invalides" });

  try {
    const own = await pool.query("SELECT seller_id FROM listings WHERE id = $1", [req.params.id]);
    if (!own.rows.length) return res.status(404).json({ error: "Annonce introuvable" });
    if (own.rows[0].seller_id !== req.user.id) {
      return res.status(403).json({ error: "Cette annonce ne vous appartient pas" });
    }

    const map = {
      title: "title", description: "description", price: "price", stock: "stock",
      condition: "condition", category: "category", brand: "brand", model: "model",
      year: "year", gearbox: "gearbox", fuel: "fuel", wilaya: "wilaya", photos: "photos",
    };

    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (parsed.data[k] !== undefined) {
        vals.push(parsed.data[k]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    if (parsed.data.lat !== undefined) { vals.push(blur(parsed.data.lat)); sets.push(`lat = $${vals.length}`); }
    if (parsed.data.lng !== undefined) { vals.push(blur(parsed.data.lng)); sets.push(`lng = $${vals.length}`); }

    if (!sets.length) return res.status(400).json({ error: "Rien à modifier" });

    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE listings SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals
    );

    res.json(toApi(r.rows[0]));
  } catch (e) {
    console.error("[patch listing]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ SUPPRIMER ══
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "DELETE FROM listings WHERE id = $1 AND seller_id = $2 RETURNING id",
      [req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Introuvable ou non autorisé" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ COMPTEUR DE VUES ══
router.post("/:id/view", async (req, res) => {
  try {
    await pool.query("UPDATE listings SET views = views + 1 WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });   // jamais bloquant
  }
});

// ══ STATISTIQUES PUBLIQUES ══
router.get("/stats/counts", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM listings WHERE status = 'active') AS listings,
        (SELECT count(*)::int FROM users WHERE role = 'vendeur')     AS vendeurs
    `);
    res.json(r.rows[0]);
  } catch (e) {
    res.json({ listings: 0, vendeurs: 0 });
  }
});

export default router;