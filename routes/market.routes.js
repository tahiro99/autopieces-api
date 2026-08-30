import express from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";
import { notify } from "../push.js";

const router = express.Router();

// ════════════════ FAVORIS ════════════════

router.get("/favorites", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT f.listing_id, f.created_at,
             l.title, l.price, l.photos, l.wilaya, l.condition, l.status,
             u.display_name AS seller_name
      FROM favorites f
      JOIN listings l ON l.id = f.listing_id
      LEFT JOIN users u ON u.id = l.seller_id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
      LIMIT 300
    `, [req.user.id]);

    res.json(r.rows.map((f) => ({
      id: f.listing_id,
      listingId: f.listing_id,
      listingTitle: f.title,
      listingPrice: f.price,
      listingImg: (f.photos && f.photos[0]) || "",
      wilaya: f.wilaya,
      condition: f.condition,
      sellerName: f.seller_name || "",
      available: f.status === "active",
    })));
  } catch (e) {
    console.error("[favorites]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/favorites/:listingId", requireAuth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO favorites (user_id, listing_id) VALUES ($1,$2)
      ON CONFLICT DO NOTHING
    `, [req.user.id, req.params.listingId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: "Annonce introuvable" });
  }
});

router.delete("/favorites/:listingId", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM favorites WHERE user_id = $1 AND listing_id = $2",
      [req.user.id, req.params.listingId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ════════════════ COMMANDES ════════════════

const orderSchema = z.object({
  listingId:   z.string().uuid(),
  qty:         z.number().int().min(1).max(99).optional().default(1),
  address:     z.string().min(5).max(500),
  wilaya:      z.string().min(2).max(60),
  buyerPhone:  z.string().min(9).max(20),
  deliveryFee: z.number().int().min(0).max(100000).optional().default(0),
});

const toOrder = (o) => ({
  id: o.id,
  buyerId: o.buyer_id,
  sellerId: o.seller_id,
  listingId: o.listing_id,
  listingTitle: o.listing_title,
  price: o.price,
  qty: o.qty,
  deliveryFee: o.delivery_fee,
  sellerName: o.seller_name,
  buyerName: o.buyer_name,
  buyerPhone: o.buyer_phone,
  buyerEmail: o.buyer_email,
  address: o.address,
  wilaya: o.wilaya,
  paymentMethod: o.payment_method,
  status: o.status,
  rated: o.rated,
  createdAt: o.created_at,
});

router.get("/orders", requireAuth, async (req, res) => {
  const asSeller = req.query.as === "seller";
  try {
    const r = await pool.query(`
      SELECT * FROM orders
      WHERE ${asSeller ? "seller_id" : "buyer_id"} = $1
      ORDER BY created_at DESC LIMIT 200
    `, [req.user.id]);
    res.json(r.rows.map(toOrder));
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── PASSER COMMANDE ──
router.post("/orders", requireAuth, async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données invalides", details: parsed.error.issues });
  }

  const d = parsed.data;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Verrou sur la ligne : deux commandes simultanées ne peuvent pas
    // vider le même stock.
    const l = await client.query(
      "SELECT * FROM listings WHERE id = $1 AND status = 'active' FOR UPDATE",
      [d.listingId]
    );
    if (!l.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Annonce indisponible" });
    }

    const listing = l.rows[0];

    if (listing.seller_id === req.user.id) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Vous ne pouvez pas commander votre propre annonce" });
    }
    if (listing.stock < d.qty) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Stock insuffisant", available: listing.stock });
    }

    const buyer  = await client.query("SELECT display_name, email FROM users WHERE id = $1", [req.user.id]);
    const seller = await client.query("SELECT display_name FROM users WHERE id = $1", [listing.seller_id]);

    // Le prix vient de la BASE, jamais du client
    const r = await client.query(`
      INSERT INTO orders (buyer_id, seller_id, listing_id, listing_title, price, qty,
                          delivery_fee, seller_name, buyer_name, buyer_phone, buyer_email,
                          address, wilaya, payment_method, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'cash','pending')
      RETURNING *
    `, [
      req.user.id, listing.seller_id, listing.id, listing.title,
      listing.price, d.qty, d.deliveryFee,
      seller.rows[0]?.display_name || "", buyer.rows[0]?.display_name || "",
      d.buyerPhone, buyer.rows[0]?.email || "", d.address, d.wilaya,
    ]);

    await client.query("UPDATE listings SET stock = stock - $1 WHERE id = $2", [d.qty, listing.id]);

    await client.query("COMMIT");

    // Hors transaction : notify ouvre sa propre connexion
    notify(listing.seller_id, {
      type: "commande",
      title: "Nouvelle commande 📦",
      body: `"${listing.title}" — ${listing.price.toLocaleString()} DA`,
      data: { screen: "SellerDashboard", orderId: r.rows[0].id },
    }).catch(() => {});

    res.status(201).json(toOrder(r.rows[0]));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[order]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// ── CHANGER LE STATUT ──
const FLOW = {
  pending:   ["confirmed", "cancelled"],
  confirmed: ["shipping", "cancelled"],
  shipping:  ["delivered"],
  delivered: ["archived"],
  cancelled: [],
  archived:  [],
};

const NOTIF = {
  confirmed: "Votre commande a été confirmée ✅",
  shipping:  "Votre commande est en route ! 🚚",
  delivered: "Votre commande a été livrée ! 🎉",
  cancelled: "Votre commande a été annulée",
};

router.patch("/orders/:id/status", requireAuth, async (req, res) => {
  const { status } = req.body || {};
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const r = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Commande introuvable" });
    }

    const o = r.rows[0];
    const isSeller = o.seller_id === req.user.id;
    const isBuyer  = o.buyer_id === req.user.id;

    if (!isSeller && !isBuyer) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Accès refusé" });
    }

    // L'acheteur ne peut qu'annuler, et seulement avant expédition
    if (isBuyer && !isSeller) {
      if (status !== "cancelled" || !["pending", "confirmed"].includes(o.status)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Action non autorisée" });
      }
    }

    if (!FLOW[o.status]?.includes(status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Transition ${o.status} → ${status} impossible` });
    }

    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, o.id]);

    // Annulation : le stock revient
    if (status === "cancelled" && o.listing_id) {
      await client.query("UPDATE listings SET stock = stock + $1 WHERE id = $2", [o.qty, o.listing_id]);
    }

    await client.query("COMMIT");

    if (NOTIF[status]) {
      notify(isSeller ? o.buyer_id : o.seller_id, {
        type: "livraison",
        title: "Commande mise à jour",
        body: NOTIF[status],
        data: { screen: isSeller ? "Orders" : "SellerDashboard", orderId: o.id },
      }).catch(() => {});
    }

    res.json({ ok: true, status });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// ════════════════ NOTES ════════════════

router.post("/orders/:id/rate", requireAuth, async (req, res) => {
  const stars   = Number(req.body?.stars);
  const comment = String(req.body?.comment || "").slice(0, 500);

  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: "Note invalide (1 à 5)" });
  }

  try {
    const r = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
    const o = r.rows[0];

    if (!o) return res.status(404).json({ error: "Commande introuvable" });
    if (o.buyer_id !== req.user.id) return res.status(403).json({ error: "Accès refusé" });
    if (o.status !== "delivered" && o.status !== "archived") {
      return res.status(400).json({ error: "Seule une commande livrée peut être notée" });
    }
    if (o.rated) return res.status(409).json({ error: "Commande déjà notée" });

    await pool.query(`
      INSERT INTO ratings (order_id, seller_id, buyer_id, stars, comment)
      VALUES ($1,$2,$3,$4,$5)
    `, [o.id, o.seller_id, req.user.id, stars, comment]);

    await pool.query("UPDATE orders SET rated = true WHERE id = $1", [o.id]);

    notify(o.seller_id, {
      type: "rating",
      title: `⭐ Nouvelle évaluation : ${stars}/5`,
      body: comment || "Vous avez reçu une nouvelle note.",
      data: { screen: "SellerDashboard" },
    }).catch(() => {});

    res.status(201).json({ ok: true });
  } catch (e) {
    console.error("[rate]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/sellers/:id/ratings", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.stars, r.comment, r.created_at, u.display_name AS buyer_name
      FROM ratings r LEFT JOIN users u ON u.id = r.buyer_id
      WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 50
    `, [req.params.id]);

    const avg = r.rows.length
      ? (r.rows.reduce((s, x) => s + x.stars, 0) / r.rows.length).toFixed(1)
      : null;

    res.json({ average: avg, count: r.rows.length, items: r.rows });
  } catch (e) {
    res.json({ average: null, count: 0, items: [] });
  }
});

export default router;