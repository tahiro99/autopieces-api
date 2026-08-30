import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { pool } from "./db.js";

const key = JSON.parse(readFileSync("./firebase-key.json", "utf8"));
const app = initializeApp({ credential: cert(key) });
const fs  = getFirestore(app, "tahar2");   // ⚠️ base nommée, pas (default)

const ts = (v) => {
  if (!v) return null;
  if (v.toDate) return v.toDate();
  if (v.seconds) return new Date(v.seconds * 1000);
  if (typeof v === "string") return new Date(v);
  return null;
};

const cond = (c) => {
  if (c === "Neuf" || c === "جديد") return "new";
  if (c === "Occasion" || c === "مستعمل") return "used";
  return null;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

(async () => {
  console.log("── Migration Firestore → PostgreSQL ──\n");

  // 1. Les vendeurs qui ont des annonces
  const listSnap = await fs.collection("listings").get();
  const sellerIds = [...new Set(listSnap.docs.map(d => d.data().sellerId).filter(Boolean))];
  console.log(`${listSnap.size} annonce(s), ${sellerIds.length} vendeur(s)`);

  // 2. Créer ces vendeurs
  let users = 0;
  for (const id of sellerIds) {
    const u = await fs.collection("users").doc(id).get();
    const d = u.exists ? u.data() : {};
    const mail = (d.email || d.firebaseEmail || `${id}@migre.local`).toLowerCase();

    try {
      await pool.query(`
        INSERT INTO users (id, email, display_name, phone, wilaya, role, verified, created_at)
        VALUES ($1,$2,$3,$4,$5,'vendeur',$6,$7)
        ON CONFLICT (id) DO NOTHING
      `, [
        id, mail, d.displayName || "Vendeur", d.phone || "", d.wilaya || "",
        !!d.verified, ts(d.createdAt) || new Date(),
      ]);

      // Essai de 30 jours pour repartir proprement
      await pool.query(`
        INSERT INTO subscriptions (user_id, status, plan, current_period_end)
        VALUES ($1,'trial','monthly', now() + interval '30 days')
      `, [id]);

      users++;
    } catch (e) {
      console.error(`  ✗ vendeur ${id}: ${e.message}`);
    }
  }
  console.log(`✓ ${users} vendeur(s) migré(s)`);

  // 3. Les annonces
  let ok = 0, skip = 0;
  for (const doc of listSnap.docs) {
    const l = doc.data();
    if (!l.sellerId || !sellerIds.includes(l.sellerId)) { skip++; continue; }

    const photos = Array.isArray(l.photos) && l.photos.length
      ? l.photos
      : (typeof l.img === "string" && l.img.startsWith("http") ? [l.img] : []);

    try {
      const r = await pool.query(`
        INSERT INTO listings (seller_id, title, description, price, stock, condition,
                              category, brand, model, year, gearbox, fuel, wilaya,
                              lat, lng, photos, views, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active',$18)
        RETURNING id
      `, [
        l.sellerId, l.title || "Sans titre", l.description || "",
        num(l.price), num(l.stock) || 1, cond(l.condition),
        l.category || null, l.brand || null, l.model || null,
        l.year ? num(l.year) : null, l.gearbox || null, l.fuel || null,
        l.wilaya || null,
        l.lat != null ? Math.round(l.lat * 1000) / 1000 : null,
        l.lng != null ? Math.round(l.lng * 1000) / 1000 : null,
        photos, num(l.views), ts(l.createdAt) || new Date(),
      ]);

      for (const v of (l.compatibleVehicles || [])) {
        if (v?.brand) {
          await pool.query(
            "INSERT INTO listing_vehicles (listing_id, brand, model) VALUES ($1,$2,$3)",
            [r.rows[0].id, v.brand, v.model || ""]
          );
        }
      }
      ok++;
    } catch (e) {
      console.error(`  ✗ annonce ${doc.id}: ${e.message}`);
    }
  }

  console.log(`✓ ${ok} annonce(s) migrée(s)${skip ? `, ${skip} ignorée(s)` : ""}`);
  console.log("\n✅ Terminé");

  await pool.end();
  process.exit(0);
})();