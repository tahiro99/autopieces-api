import express from "express";
import crypto from "crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import {
  hashPassword, verifyPassword, signAccessToken,
  issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllSessions,
  requireAuth, createAuthToken, consumeAuthToken,
  tooManyAttempts, logAttempt,
} from "../auth.js";
import { OAuth2Client } from "google-auth-library";
const router = express.Router();

// Limite globale par IP, en plus de la limite par compte
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives, réessayez dans quelques minutes" },
});

// ── Validation ──
const registerSchema = z.object({
  email:       z.string().email().max(255),
  password:    z.string().min(8).max(128),
  displayName: z.string().min(2).max(80),
  phone:       z.string().max(20).optional(),
  wilaya:      z.string().max(60).optional(),
});

const loginSchema = z.object({
  email:    z.string().email().max(255),
  password: z.string().min(1).max(128),
});

// Objet utilisateur renvoyé au client — jamais le hash
const publicUser = (u) => ({
  id: u.id,
  uid: u.id,          // ← alias pour compatibilité avec l'app
  email: u.email,
  displayName: u.display_name,
  phone: u.phone,
  wilaya: u.wilaya,
  role: u.role,
  photoURL: u.photo_url,
  verified: u.verified,
  emailVerified: u.email_verified,
  blockedUsers: u.blocked_users || [],
});

// ══ INSCRIPTION ══
router.post("/register", authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données invalides", details: parsed.error.issues });
  }

  const { email, password, displayName, phone, wilaya } = parsed.data;
  const mail = email.toLowerCase().trim();

  try {
    const exists = await pool.query("SELECT 1 FROM users WHERE email = $1", [mail]);
    if (exists.rows.length) {
      return res.status(409).json({ error: "Cet e-mail est déjà utilisé" });
    }

    const id   = crypto.randomUUID();
    const hash = await hashPassword(password);

    const r = await pool.query(`
      INSERT INTO users (id, email, password_hash, display_name, phone, wilaya, role)
      VALUES ($1,$2,$3,$4,$5,$6,NULL)
      RETURNING *
    `, [id, mail, hash, displayName.trim(), phone || "", wilaya || ""]);

    const user = r.rows[0];
    const accessToken  = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id, req);

    // Jeton de vérification — l'envoi d'e-mail viendra plus tard
    const verifyToken = await createAuthToken(user.id, "verify_email", 48);
    console.log(`[verify] ${mail} → ${verifyToken}`);

    res.status(201).json({ user: publicUser(user), accessToken, refreshToken });
  } catch (e) {
    console.error("[register]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ CONNEXION ══
router.post("/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Données invalides" });

  const mail = parsed.data.email.toLowerCase().trim();

  try {
    if (await tooManyAttempts(mail)) {
      return res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });
    }

    const r = await pool.query("SELECT * FROM users WHERE email = $1", [mail]);
    const user = r.rows[0];

    // Message identique si le compte n'existe pas ou si le mot de passe est faux :
    // sinon on révèle quels e-mails sont inscrits.
    if (!user || !user.password_hash) {
      await logAttempt(mail, req.ip, false);
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect" });
    }

    const ok = await verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      await logAttempt(mail, req.ip, false);
      return res.status(401).json({ error: "E-mail ou mot de passe incorrect" });
    }

    await logAttempt(mail, req.ip, true);
    await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);

    const accessToken  = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id, req);

    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (e) {
    console.error("[login]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ RAFRAÎCHISSEMENT ══
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "Jeton manquant" });

  try {
    const tokens = await rotateRefreshToken(refreshToken, req);
    if (!tokens) return res.status(401).json({ error: "Session expirée" });
    res.json(tokens);
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ DÉCONNEXION ══
router.post("/logout", async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) await revokeRefreshToken(refreshToken).catch(() => {});
  res.json({ ok: true });
});

// ══ PROFIL COURANT ══
router.get("/me", requireAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Introuvable" });
    res.json(publicUser(r.rows[0]));
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ CHANGER LE MOT DE PASSE ══
router.post("/change-password", requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!current || !next || next.length < 8) {
    return res.status(400).json({ error: "Mot de passe invalide (8 caractères minimum)" });
  }

  try {
    const r = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const hash = r.rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(current, hash))) {
      return res.status(401).json({ error: "Mot de passe actuel incorrect" });
    }

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2",
      [await hashPassword(next), req.user.id]);

    // Toutes les autres sessions sont fermées
    await revokeAllSessions(req.user.id);
    const refreshToken = await issueRefreshToken(req.user.id, req);

    res.json({ ok: true, refreshToken });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ══ MOT DE PASSE OUBLIÉ ══
router.post("/forgot-password", authLimiter, async (req, res) => {
  const mail = String(req.body?.email || "").toLowerCase().trim();

  try {
    const r = await pool.query("SELECT id FROM users WHERE email = $1", [mail]);
    if (r.rows.length) {
      const token = await createAuthToken(r.rows[0].id, "reset_password", 2);
      console.log(`[reset] ${mail} → ${token}`);
    }
    // Réponse identique dans tous les cas : on ne révèle pas si l'e-mail existe
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true });
  }
});

router.post("/reset-password", authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: "Données invalides" });
  }

  try {
    const userId = await consumeAuthToken(token, "reset_password");
    if (!userId) return res.status(400).json({ error: "Lien invalide ou expiré" });

    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2",
      [await hashPassword(password), userId]);
    await revokeAllSessions(userId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erreur serveur" });
  }
});
// ══ CONNEXION GOOGLE ══
// L'app envoie l'idToken reçu de Google, le serveur le vérifie auprès de Google
const GOOGLE_CLIENT_IDS = (process.env.GOOGLE_CLIENT_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const googleClient = new OAuth2Client();

router.post("/google", authLimiter, async (req, res) => {
  const idToken = String(req.body?.idToken || "");
  if (!idToken) return res.status(400).json({ error: "Jeton manquant" });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_IDS.length ? GOOGLE_CLIENT_IDS : undefined,
    });
    payload = ticket.getPayload();
  } catch (e) {
    console.error("[google]", e.message);
    return res.status(401).json({ error: "Jeton Google invalide" });
  }

  const email = (payload?.email || "").toLowerCase();
  if (!email || !payload.email_verified) {
    return res.status(400).json({ error: "Compte Google sans e-mail vérifié" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Compte existant par google_id, sinon par e-mail
    let r = await client.query("SELECT * FROM users WHERE google_id = $1", [payload.sub]);

    if (!r.rows.length) {
      r = await client.query("SELECT * FROM users WHERE email = $1", [email]);

      if (r.rows.length) {
        // Compte e-mail existant → on y rattache Google
        await client.query("UPDATE users SET google_id = $1, email_verified = true WHERE id = $2",
          [payload.sub, r.rows[0].id]);
      } else {
        // Nouveau compte, sans mot de passe
        r = await client.query(`
          INSERT INTO users (id, email, google_id, display_name, photo_url, email_verified)
          VALUES ($1,$2,$3,$4,$5,true)
          RETURNING *
        `, [
          crypto.randomUUID(), email, payload.sub,
          payload.name || email.split("@")[0],
          payload.picture || null,
        ]);
      }
    }

    const user = r.rows[0];
    await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await client.query("COMMIT");

    const accessToken  = signAccessToken(user);
    const refreshToken = await issueRefreshToken(user.id, req);

    res.json({ user: publicUser(user), accessToken, refreshToken });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[google auth]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});
// ══ CONNEXION FACEBOOK ══
// L'app envoie l'access_token, le serveur le vérifie auprès de Facebook
router.post("/facebook", authLimiter, async (req, res) => {
  const accessToken = String(req.body?.accessToken || "");
  if (!accessToken) return res.status(400).json({ error: "Jeton manquant" });

  let fb;
  try {
    // Vérifie que le jeton appartient bien à NOTRE application
    const appId     = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;

    if (appId && appSecret) {
      const dbg = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}` +
        `&access_token=${appId}|${appSecret}`
      ).then((r) => r.json());

      if (!dbg?.data?.is_valid || String(dbg.data.app_id) !== String(appId)) {
        return res.status(401).json({ error: "Jeton Facebook invalide" });
      }
    }

    fb = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture.type(large)` +
      `&access_token=${encodeURIComponent(accessToken)}`
    ).then((r) => r.json());

    if (!fb?.id) return res.status(401).json({ error: "Jeton Facebook invalide" });
  } catch (e) {
    console.error("[facebook]", e.message);
    return res.status(401).json({ error: "Jeton Facebook invalide" });
  }

  // Facebook ne fournit pas toujours l'e-mail
  const email = (fb.email || "").toLowerCase() || `fb_${fb.id}@facebook.local`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let r = await client.query("SELECT * FROM users WHERE facebook_id = $1", [fb.id]);

    if (!r.rows.length) {
      r = await client.query("SELECT * FROM users WHERE email = $1", [email]);

      if (r.rows.length) {
        await client.query("UPDATE users SET facebook_id = $1 WHERE id = $2",
          [fb.id, r.rows[0].id]);
      } else {
        r = await client.query(`
          INSERT INTO users (id, email, facebook_id, display_name, photo_url, email_verified)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING *
        `, [
          crypto.randomUUID(), email, fb.id,
          fb.name || email.split("@")[0],
          fb.picture?.data?.url || null,
          !!fb.email,
        ]);
      }
    }

    const user = r.rows[0];
    await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    await client.query("COMMIT");

    const accessJwt   = signAccessToken(user);
    const refreshJwt  = await issueRefreshToken(user.id, req);

    res.json({ user: publicUser(user), accessToken: accessJwt, refreshToken: refreshJwt });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[facebook auth]", e.message);
    res.status(500).json({ error: "Erreur serveur" });
  } finally {
    client.release();
  }
});
export default router;