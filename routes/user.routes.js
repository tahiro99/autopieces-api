import express from "express";
import multer from "multer";
import sharp from "sharp";
import crypto from "crypto";
import path from "path";
import { z } from "zod";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = express.Router();
const UPLOAD_DIR = path.resolve("uploads");
const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";

// ══ PROFIL ══
const profileSchema = z.object({
  displayName: z.string().min(2).max(80).optional(),
  phone:       z.string().max(20).optional(),
  wilaya:      z.string().max(60).optional(),
  photoURL:    z.string().url().max(500).optional().nullable(),
});

router.patch("/me", requireAuth, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Données invalides" });

  const map = { displayName: "display_name", phone: "phone", wilaya: "wilaya", photoURL: "photo_url" };
  const sets = [], vals = [];

  for (const [k, col] of Object.entries(map)) {
    if (parsed.data[k] !== undefined) {
      vals.push(parsed.data[k]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: "Rien à modifier" });

  try {
    vals.push(req.user.id);
    const r = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`, vals
    );
    const u = r.rows[0];
    res.json({
      id: u.id, email: u.email, displayName: u.display_name,
      phone: u.phone, wilaya: u.wilaya, role: u.role,
      photoURL: u.photo_url, verified: u.verified,
      blockedUsers: u.blocked_users || [],
    });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Choisir son rôle (une seule fois) ──
router.post("/me/role", requireAuth, async (req, res) => {
  const role = req.body?.role;
  if (!["client", "vendeur"].includes(role)) {
    return res.status(400).json({ error: "Rôle invalide" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const u = await client.query("SELECT role FROM users WHERE id = $1 FOR UPDATE", [req.user.id]);
    // On ne change pas un rôle déjà défini : sinon un client se ferait vendeur gratuitement
    if (u.rows[0]?.role) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Rôle déjà défini" });
    }

    await client.query("UPDATE users SET role = $1 WHERE id = $2", [role, req.user.id]);

    // Essai gratuit de 14 jours pour les vendeurs
    if (role === "vendeur") {
      await client.query(`
        INSERT INTO subscriptions (user_id, status, plan, current_period_end)
        VALUES ($1,'trial','monthly', now() + interval '14 days')
      `, [req.user.id]);
    }

    await client.query("COMMIT");
    res.json({ ok: true, role });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});

// ── Mon abonnement ──
router.get("/me/subscription", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT status, plan, current_period_end FROM subscriptions
      WHERE user_id = $1 ORDER BY current_period_end DESC LIMIT 1
    `, [req.user.id]);

    if (!r.rows.length) return res.json({ status: "none", isExpired: true, daysLeft: 0 });

    const s = r.rows[0];
    const end = new Date(s.current_period_end);
    const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / 86400_000));

    res.json({
      status: s.status,
      plan: s.plan,
      currentPeriodEnd: s.current_period_end,
      isExpired: end < new Date(),
      isTrial: s.status === "trial",
      daysLeft,
    });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ── Jeton FCM (notifications push) ──
router.post("/me/fcm-token", requireAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "Jeton manquant" });
  try {
    await pool.query(`
      UPDATE users SET fcm_tokens = array_append(fcm_tokens, $1)
      WHERE id = $2 AND NOT ($1 = ANY(fcm_tokens))
    `, [token, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.delete("/me/fcm-token", requireAuth, async (req, res) => {
  const token = String(req.body?.token || "").trim();
  try {
    await pool.query(
      "UPDATE users SET fcm_tokens = array_remove(fcm_tokens, $1) WHERE id = $2",
      [token, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ NOTIFICATIONS ══
router.get("/notifications", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT * FROM notifications WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 100
    `, [req.user.id]);

    res.json(r.rows.map((n) => ({
      id: n.id, type: n.type, title: n.title, body: n.body,
      data: n.data, read: n.read, createdAt: n.created_at,
    })));
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.patch("/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/notifications/read-all", requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE notifications SET read = true WHERE user_id = $1 AND read = false",
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ UPLOAD D'IMAGES ══
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // On ne fait pas confiance à l'extension : sharp validera le contenu réel
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.mimetype)) {
      return cb(new Error("Format non supporté"));
    }
    cb(null, true);
  },
});

router.post("/upload", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Aucun fichier" });

  const kind = ["listing", "chat", "profile"].includes(req.body?.kind)
    ? req.body.kind : "listing";

  const sizes = {
    listing: { w: 1200, thumb: 300 },
    chat:    { w: 1000, thumb: 300 },
    profile: { w: 600,  thumb: 150 },
  }[kind];

  try {
    const name = `${kind}_${req.user.id}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    // sharp lit l'image réelle : un fichier malveillant renommé en .jpg échoue ici
    await sharp(req.file.buffer)
      .rotate()                                  // respecte l'orientation EXIF
      .resize(sizes.w, sizes.w, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(UPLOAD_DIR, `${name}.webp`));

    await sharp(req.file.buffer)
      .rotate()
      .resize(sizes.thumb, sizes.thumb, { fit: "cover" })
      .webp({ quality: 75 })
      .toFile(path.join(UPLOAD_DIR, `${name}_thumb.webp`));

    res.status(201).json({
      url:      `${PUBLIC_URL}/uploads/${name}.webp`,
      thumbUrl: `${PUBLIC_URL}/uploads/${name}_thumb.webp`,
    });
  } catch (e) {
    console.error("[upload]", e.message);
    res.status(400).json({ error: "Image invalide" });
  }
});

export default router;