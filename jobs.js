import cron from "node-cron";
import { pool } from "./db.js";
import { notify } from "./push.js";

async function expireSubscriptions() {
  try {
    const r = await pool.query(`
      UPDATE subscriptions SET status = 'expired'
      WHERE status IN ('trial','active') AND current_period_end < now()
      RETURNING user_id, status
    `);

    for (const s of r.rows) {
      await notify(s.user_id, {
        type: "abonnement",
        title: "Abonnement expiré",
        body: "Renouvelez pour continuer à publier vos annonces.",
        data: { screen: "Subscription" },
      });
    }

    if (r.rows.length) console.log(`[cron] ${r.rows.length} abonnement(s) expiré(s)`);
  } catch (e) {
    console.error("[cron expire]", e.message);
  }
}

async function remindSubscriptions() {
  try {
    for (const days of [7, 2]) {
      const r = await pool.query(`
        SELECT user_id FROM subscriptions
        WHERE status IN ('trial','active')
          AND current_period_end::date = (now() + ($1 || ' days')::interval)::date
      `, [days]);

      for (const s of r.rows) {
        await notify(s.user_id, {
          type: "subscription_warning",
          title: `Abonnement : ${days} jour${days > 1 ? "s" : ""} restant${days > 1 ? "s" : ""}`,
          body: "Pensez à renouveler pour ne pas interrompre vos ventes.",
          data: { screen: "Subscription" },
        });
      }
    }
  } catch (e) {
    console.error("[cron remind]", e.message);
  }
}

async function cleanup() {
  try {
    const s = await pool.query(`
      DELETE FROM sessions
      WHERE expires_at < now() - interval '30 days'
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')
    `);

    const t = await pool.query(`
      DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'
    `);

    const a = await pool.query(`
      DELETE FROM login_attempts WHERE created_at < now() - interval '7 days'
    `);

    const n = await pool.query(`
      DELETE FROM notifications WHERE read = true AND created_at < now() - interval '60 days'
    `);

    console.log(`[cron] nettoyage — sessions:${s.rowCount} jetons:${t.rowCount} tentatives:${a.rowCount} notifs:${n.rowCount}`);
  } catch (e) {
    console.error("[cron cleanup]", e.message);
  }
}

async function remindPendingOrders() {
  try {
    const r = await pool.query(`
      SELECT id, seller_id, listing_title FROM orders
      WHERE status = 'pending' AND created_at < now() - interval '24 hours'
        AND created_at > now() - interval '48 hours'
    `);

    for (const o of r.rows) {
      await notify(o.seller_id, {
        type: "commande",
        title: "Commande en attente ⏰",
        body: `"${o.listing_title}" attend votre confirmation depuis 24h.`,
        data: { screen: "SellerDashboard", orderId: o.id },
      });
    }
  } catch (e) {
    console.error("[cron pending]", e.message);
  }
}

export function startJobs() {
  const tz = { timezone: "Africa/Algiers" };

  // Chaque heure : expiration des abonnements
  cron.schedule("0 * * * *", expireSubscriptions, tz);

  // Tous les jours à 10h : rappels
  cron.schedule("0 10 * * *", remindSubscriptions, tz);

  // Tous les jours à 11h : commandes en attente
  cron.schedule("0 11 * * *", remindPendingOrders, tz);

  // Tous les jours à 4h du matin : nettoyage
  cron.schedule("0 4 * * *", cleanup, tz);

  console.log("[cron] tâches planifiées démarrées (Africa/Algiers)");
}

if (process.argv[2]) {
  const tasks = { expire: expireSubscriptions, remind: remindSubscriptions,
                  cleanup, pending: remindPendingOrders };
  const fn = tasks[process.argv[2]];
  if (fn) {
    console.log(`Exécution manuelle : ${process.argv[2]}`);
    fn().then(() => pool.end()).then(() => process.exit(0));
  } else {
    console.log("Tâches : expire | remind | cleanup | pending");
    process.exit(1);
  }
}
