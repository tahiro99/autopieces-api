import express from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = express.Router();

const toConv = (c, uid) => {
  const iAmSeller = c.seller_id === uid;
  return {
    id: c.id,
    buyerId: c.buyer_id,
    sellerId: c.seller_id,
    listingId: c.listing_id,
    listingTitle: c.listing_title,
    listingPrice: c.listing_price,
    lastMessage: c.last_message,
    lastMessageAt: c.last_message_at,
    // Le nom affiché dépend de qui regarde
    otherName: iAmSeller ? (c.buyer_name || "Client") : (c.seller_name || "Vendeur"),
    otherId:   iAmSeller ? c.buyer_id : c.seller_id,
    unread: Number(c.unread) || 0,
  };
};

const toMsg = (m) => ({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  text: m.text,
  imageUrl: m.image_url,
  type: m.type,
  read: m.read,
  createdAt: m.created_at,
});

// ══ MES CONVERSATIONS ══
router.get("/conversations", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*,
             b.display_name AS buyer_name,
             s.display_name AS seller_name,
             (SELECT count(*) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.sender_id <> $1
                AND m.read = false) AS unread
      FROM conversations c
      LEFT JOIN users b ON b.id = c.buyer_id
      LEFT JOIN users s ON s.id = c.seller_id
      WHERE (c.buyer_id = $1 OR c.seller_id = $1)
        AND c.buyer_id  <> ALL(COALESCE((SELECT blocked_users FROM users WHERE id=$1),'{}'))
        AND c.seller_id <> ALL(COALESCE((SELECT blocked_users FROM users WHERE id=$1),'{}'))
      ORDER BY c.last_message_at DESC
      LIMIT 100
    `, [req.user.id]);

    res.json(r.rows.map((c) => toConv(c, req.user.id)));
  } catch (e) {
    console.error("[conversations]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ OUVRIR / CRÉER UNE CONVERSATION ══
router.post("/conversations", requireAuth, async (req, res) => {
  const listingId = String(req.body?.listingId || "");
  if (!listingId) return res.status(400).json({ error: "Annonce manquante" });

  try {
    const l = await pool.query("SELECT * FROM listings WHERE id = $1", [listingId]);
    if (!l.rows.length) return res.status(404).json({ error: "Annonce introuvable" });

    const listing = l.rows[0];
    if (listing.seller_id === req.user.id) {
      return res.status(400).json({ error: "C'est votre propre annonce" });
    }

    // UNIQUE (buyer_id, listing_id) garantit une seule conversation par couple
    const r = await pool.query(`
      INSERT INTO conversations (buyer_id, seller_id, listing_id, listing_title, listing_price)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (buyer_id, listing_id) DO UPDATE SET listing_title = EXCLUDED.listing_title
      RETURNING *
    `, [req.user.id, listing.seller_id, listing.id, listing.title, listing.price]);

    res.json(toConv({ ...r.rows[0], seller_name: "", buyer_name: "" }, req.user.id));
  } catch (e) {
    console.error("[create conv]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ MESSAGES D'UNE CONVERSATION ══
router.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  try {
    const c = await pool.query(
      "SELECT buyer_id, seller_id FROM conversations WHERE id = $1", [req.params.id]
    );
    if (!c.rows.length) return res.status(404).json({ error: "Introuvable" });
    if (![c.rows[0].buyer_id, c.rows[0].seller_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const r = await pool.query(`
      SELECT * FROM messages WHERE conversation_id = $1
      ORDER BY created_at ASC LIMIT 500
    `, [req.params.id]);

    // Marquer comme lus les messages de l'autre
    await pool.query(`
      UPDATE messages SET read = true
      WHERE conversation_id = $1 AND sender_id <> $2 AND read = false
    `, [req.params.id, req.user.id]);

    res.json(r.rows.map(toMsg));
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ ENVOYER UN MESSAGE ══
const msgSchema = z.object({
  text:     z.string().max(2000).optional().default(""),
  imageUrl: z.string().url().optional().nullable(),
});

router.post("/conversations/:id/messages", requireAuth, async (req, res) => {
  const parsed = msgSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Message invalide" });
  if (!parsed.data.text.trim() && !parsed.data.imageUrl) {
    return res.status(400).json({ error: "Message vide" });
  }

  const client = await pool.connect();
  try {
    const c = await client.query("SELECT * FROM conversations WHERE id = $1", [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: "Introuvable" });

    const conv  = c.rows[0];
    const other = conv.buyer_id === req.user.id ? conv.seller_id : conv.buyer_id;

    if (![conv.buyer_id, conv.seller_id].includes(req.user.id)) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    // Blocage dans les deux sens
    const b = await client.query(`
      SELECT
        $2 = ANY(COALESCE((SELECT blocked_users FROM users WHERE id=$1),'{}')) AS i_blocked,
        $1 = ANY(COALESCE((SELECT blocked_users FROM users WHERE id=$2),'{}')) AS they_blocked
    `, [req.user.id, other]);

    if (b.rows[0].i_blocked || b.rows[0].they_blocked) {
      return res.status(403).json({ error: "Conversation indisponible" });
    }

    // Anti-spam : 30 messages par minute
    const rate = await client.query(`
      SELECT count(*)::int AS n FROM messages
      WHERE sender_id = $1 AND created_at > now() - interval '1 minute'
    `, [req.user.id]);
    if (rate.rows[0].n >= 30) {
      return res.status(429).json({ error: "Trop de messages, ralentissez" });
    }

    await client.query("BEGIN");

    const isImg = !!parsed.data.imageUrl;
    const m = await client.query(`
      INSERT INTO messages (conversation_id, sender_id, text, image_url, type)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [conv.id, req.user.id, parsed.data.text.trim(), parsed.data.imageUrl || null,
        isImg ? "image" : "text"]);

    await client.query(`
      UPDATE conversations SET last_message = $1, last_message_at = now() WHERE id = $2
    `, [isImg ? "📷 Image" : parsed.data.text.trim().slice(0, 100), conv.id]);

    await client.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1,'message','Nouveau message 💬',$2,$3)
    `, [other, isImg ? "Vous a envoyé une image" : parsed.data.text.trim().slice(0, 80),
        JSON.stringify({ screen: "Chat", conversationId: conv.id })]);

    await client.query("COMMIT");

    const msg = toMsg(m.rows[0]);

    // Diffusion temps réel aux deux participants
    req.app.get("io")?.to(`conv:${conv.id}`).emit("message", msg);
    req.app.get("io")?.to(`user:${other}`).emit("conversation_updated", { conversationId: conv.id });

    res.status(201).json(msg);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[send message]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// ══ BLOQUER / DÉBLOQUER ══
router.post("/users/:id/block", requireAuth, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "Action impossible" });
  }
  try {
    await pool.query(
      "UPDATE users SET blocked_users = array_append(blocked_users, $1) WHERE id = $2 AND NOT ($1 = ANY(blocked_users))",
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/users/:id/block", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET blocked_users = array_remove(blocked_users, $1) WHERE id = $2",
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ SIGNALER ══
router.post("/reports", requireAuth, async (req, res) => {
  const { targetUserId, targetListingId, reason } = req.body || {};
  if (!reason || (!targetUserId && !targetListingId)) {
    return res.status(400).json({ error: "Données invalides" });
  }
  try {
    await pool.query(`
      INSERT INTO reports (reporter_id, target_user_id, target_listing_id, reason)
      VALUES ($1,$2,$3,$4)
    `, [req.user.id, targetUserId || null, targetListingId || null, String(reason).slice(0, 500)]);
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;