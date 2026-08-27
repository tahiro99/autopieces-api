import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "./db.js";

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ACCESS_TTL     = process.env.ACCESS_TTL || "15m";
const REFRESH_DAYS   = Number(process.env.REFRESH_TTL_DAYS) || 30;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  throw new Error("JWT_ACCESS_SECRET et JWT_REFRESH_SECRET sont obligatoires");
}

export const hashPassword   = (pw) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

// On stocke un SHA-256 du refresh token, jamais le token lui-même :
// une fuite de la base ne donne aucune session utilisable.
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    ACCESS_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

export async function issueRefreshToken(userId, req) {
  const raw = crypto.randomBytes(48).toString("hex");
  const expires = new Date(Date.now() + REFRESH_DAYS * 86400_000);

  await pool.query(`
    INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
    VALUES ($1,$2,$3,$4,$5)
  `, [userId, sha(raw), req?.get("user-agent") || null, req?.ip || null, expires]);

  return raw;
}

export async function rotateRefreshToken(raw, req) {
  const r = await pool.query(`
    SELECT s.id, s.user_id, u.email, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
  `, [sha(raw)]);

  if (!r.rows.length) return null;
  const s = r.rows[0];

  // Rotation : l'ancien token est révoqué à chaque usage
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [s.id]);
  const fresh = await issueRefreshToken(s.user_id, req);

  return {
    accessToken:  signAccessToken({ id: s.user_id, email: s.email, role: s.role }),
    refreshToken: fresh,
  };
}

export async function revokeRefreshToken(raw) {
  await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [sha(raw)]
  );
}

export async function revokeAllSessions(userId) {
  await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

// ── Middleware ──
export function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié" });

  try {
    const p = jwt.verify(token, ACCESS_SECRET);
    req.user = { id: p.sub, email: p.email, role: p.role };
    next();
  } catch (e) {
    const code = e.name === "TokenExpiredError" ? "token_expired" : "token_invalid";
    res.status(401).json({ error: "Non authentifié", code });
  }
}

export function optionalAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (token) {
    try {
      const p = jwt.verify(token, ACCESS_SECRET);
      req.user = { id: p.sub, email: p.email, role: p.role };
    } catch (_) {}
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Accès refusé" });
    }
    next();
  };
}

// ── Jetons à usage unique ──
export async function createAuthToken(userId, purpose, hours = 24) {
  const raw = crypto.randomBytes(32).toString("hex");
  await pool.query(`
    INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at)
    VALUES ($1,$2,$3,$4)
  `, [userId, sha(raw), purpose, new Date(Date.now() + hours * 3600_000)]);
  return raw;
}

export async function consumeAuthToken(raw, purpose) {
  const r = await pool.query(`
    UPDATE auth_tokens SET used_at = now()
    WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
    RETURNING user_id
  `, [sha(raw), purpose]);
  return r.rows[0]?.user_id || null;
}

// ── Anti-force brute ──
export async function tooManyAttempts(email) {
  const r = await pool.query(`
    SELECT count(*)::int AS n FROM login_attempts
    WHERE email = $1 AND success = false AND created_at > now() - interval '15 minutes'
  `, [email]);
  return r.rows[0].n >= 8;
}

export async function logAttempt(email, ip, success) {
  await pool.query(
    "INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,$3)",
    [email, ip, success]
  );
}