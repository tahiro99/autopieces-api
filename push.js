import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { readFileSync, existsSync } from "fs";
import { pool } from "./db.js";

let messaging = null;

try {
  if (existsSync("./firebase-key.json")) {
    const key = JSON.parse(readFileSync("./firebase-key.json", "utf8"));
    const app = initializeApp({ credential: cert(key) });
    messaging = getMessaging(app);
    console.log("[push] FCM initialisé");
  } else {
    console.warn("[push] firebase-key.json absent — notifications push désactivées");
  }
} catch (e) {
  console.error("[push] init:", e.message);
}

export async function sendPush(userId, { title, body, data = {} }) {
  if (!messaging) return;

  try {
    const r = await pool.query("SELECT fcm_tokens FROM users WHERE id = $1", [userId]);
    const tokens = r.rows[0]?.fcm_tokens || [];
    if (!tokens.length) return;

    // FCM n'accepte que des chaînes dans data
    const clean = {};
    for (const [k, v] of Object.entries(data)) {
      if (v != null) clean[k] = String(v);
    }

    const resp = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: clean,
      android: {
        priority: "high",
        notification: { channelId: "default", sound: "default" },
      },
    });

    // Purge des jetons morts : sinon la liste grossit indéfiniment
    const dead = [];
    resp.responses.forEach((res, i) => {
      if (!res.success) {
        const code = res.error?.code || "";
        if (code.includes("registration-token-not-registered") ||
            code.includes("invalid-registration-token") ||
            code.includes("invalid-argument")) {
          dead.push(tokens[i]);
        }
      }
    });

    if (dead.length) {
      await pool.query(
        "UPDATE users SET fcm_tokens = (SELECT COALESCE(array_agg(t), '{}') FROM unnest(fcm_tokens) t WHERE t <> ALL($1)) WHERE id = $2",
        [dead, userId]
      );
      console.log(`[push] ${dead.length} jeton(s) obsolète(s) retiré(s)`);
    }
  } catch (e) {
    console.error("[push]", e.message);
  }
}

// Crée la notification en base ET envoie le push
export async function notify(userId, { type, title, body, data = {} }) {
  try {
    await pool.query(`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES ($1,$2,$3,$4,$5)
    `, [userId, type || "general", title, body || "", JSON.stringify(data)]);

    await sendPush(userId, { title, body, data });
  } catch (e) {
    console.error("[notify]", e.message);
  }
}