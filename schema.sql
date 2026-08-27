-- ═══════════════════════════════════════════════
--  AutoPièces DZ — Schéma PostgreSQL
-- ═══════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── UTILISATEURS ──
CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL DEFAULT 'Utilisateur',
  phone           TEXT DEFAULT '',
  wilaya          TEXT DEFAULT '',
  role            TEXT CHECK (role IN ('client','vendeur','livreur','yalidine')),
  photo_url       TEXT,
  verified        BOOLEAN NOT NULL DEFAULT false,
  blocked_users   TEXT[] NOT NULL DEFAULT '{}',
  fcm_tokens      TEXT[] NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ABONNEMENTS ──
CREATE TABLE subscriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'trial'
                        CHECK (status IN ('trial','active','expired','cancelled')),
  plan                TEXT NOT NULL DEFAULT 'monthly',
  current_period_end  TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_subs_user ON subscriptions(user_id);

-- ── ANNONCES ──
CREATE TABLE listings (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  seller_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  price         INTEGER NOT NULL DEFAULT 0,
  stock         INTEGER NOT NULL DEFAULT 1,
  condition     TEXT CHECK (condition IN ('new','used')),
  category      TEXT,
  brand         TEXT,
  model         TEXT,
  year          INTEGER,
  gearbox       TEXT,
  fuel          TEXT,
  wilaya        TEXT,
  lat           NUMERIC(9,6),
  lng           NUMERIC(9,6),
  photos        TEXT[] NOT NULL DEFAULT '{}',
  views         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','sold','hidden','deleted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_listings_seller   ON listings(seller_id, created_at DESC);
CREATE INDEX idx_listings_active   ON listings(created_at DESC) WHERE status = 'active';
CREATE INDEX idx_listings_wilaya   ON listings(wilaya) WHERE status = 'active';
CREATE INDEX idx_listings_category ON listings(category) WHERE status = 'active';
CREATE INDEX idx_listings_search   ON listings
  USING gin(to_tsvector('french', title || ' ' || coalesce(description,'')));

-- ── VÉHICULES COMPATIBLES ──
CREATE TABLE listing_vehicles (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  brand      TEXT NOT NULL,
  model      TEXT NOT NULL
);
CREATE INDEX idx_vehicles_listing ON listing_vehicles(listing_id);

-- ── FAVORIS ──
CREATE TABLE favorites (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX idx_fav_user ON favorites(user_id, created_at DESC);

-- ── COMMANDES ──
CREATE TABLE orders (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_id       TEXT NOT NULL REFERENCES users(id),
  seller_id      TEXT NOT NULL REFERENCES users(id),
  listing_id     UUID REFERENCES listings(id) ON DELETE SET NULL,
  listing_title  TEXT NOT NULL,
  price          INTEGER NOT NULL,
  qty            INTEGER NOT NULL DEFAULT 1,
  delivery_fee   INTEGER NOT NULL DEFAULT 0,
  seller_name    TEXT DEFAULT '',
  buyer_name     TEXT DEFAULT '',
  buyer_phone    TEXT DEFAULT '',
  buyer_email    TEXT DEFAULT '',
  address        TEXT DEFAULT '',
  wilaya         TEXT DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'cash',
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','confirmed','shipping','delivered','cancelled','archived')),
  rated          BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_buyer  ON orders(buyer_id, created_at DESC);
CREATE INDEX idx_orders_seller ON orders(seller_id, created_at DESC);

-- ── CONVERSATIONS ──
CREATE TABLE conversations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id      UUID REFERENCES listings(id) ON DELETE SET NULL,
  listing_title   TEXT DEFAULT '',
  listing_price   INTEGER DEFAULT 0,
  last_message    TEXT DEFAULT '',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (buyer_id, listing_id)
);
CREATE INDEX idx_conv_buyer  ON conversations(buyer_id, last_message_at DESC);
CREATE INDEX idx_conv_seller ON conversations(seller_id, last_message_at DESC);

-- ── MESSAGES ──
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id),
  text            TEXT DEFAULT '',
  image_url       TEXT,
  type            TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','image')),
  read            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_msg_conv   ON messages(conversation_id, created_at ASC);
CREATE INDEX idx_msg_unread ON messages(conversation_id, sender_id) WHERE read = false;

-- ── NOTES ──
CREATE TABLE ratings (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seller_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  buyer_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment     TEXT DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);
CREATE INDEX idx_ratings_seller ON ratings(seller_id, created_at DESC);

-- ── NOTIFICATIONS ──
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'general',
  title      TEXT NOT NULL,
  body       TEXT DEFAULT '',
  data       JSONB NOT NULL DEFAULT '{}',
  read       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON notifications(user_id, created_at DESC);

-- ── SIGNALEMENTS ──
CREATE TABLE reports (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  target_listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','reviewed','dismissed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

-- ── MISE À JOUR AUTOMATIQUE DE updated_at ──
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users    BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_listings BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_orders   BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();