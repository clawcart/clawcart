// ClawCart SQLite persistence layer
// Replaces in-memory Maps with durable storage

import Database from "better-sqlite3";
import type {
  Product, Quote, CheckoutSession, Order, AuditEntry, UserPolicy,
} from "@clawcart/protocol";
import path from "path";

const DB_PATH = process.env.CLAWCART_DB_PATH || path.join(process.cwd(), "clawcart.db");

export function createDb(dbPath?: string): Database.Database {
  const db = new Database(dbPath || DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      sku TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS quotes (
      quote_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS checkout_sessions (
      checkout_session_id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_approval',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      checkout_session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS policies (
      policy_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payment_tokens (
      checkout_session_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_expires ON quotes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON checkout_sessions(status);
  `);
}

export class ProductStore {
  constructor(private db: Database.Database) {}

  upsert(product: Product): void {
    this.db.prepare(
      `INSERT INTO products (sku, data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
    ).run(product.sku, JSON.stringify(product));
  }

  upsertMany(products: Product[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO products (sku, data, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(sku) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
    );
    const tx = this.db.transaction((items: Product[]) => {
      for (const p of items) stmt.run(p.sku, JSON.stringify(p));
    });
    tx(products);
  }

  get(sku: string): Product | undefined {
    const row = this.db.prepare("SELECT data FROM products WHERE sku = ?").get(sku) as any;
    return row ? JSON.parse(row.data) : undefined;
  }

  search(filter: (p: Product) => boolean): Product[] {
    const rows = this.db.prepare("SELECT data FROM products").all() as any[];
    return rows.map(r => JSON.parse(r.data) as Product).filter(filter);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM products").get() as any).n;
  }
}

export class QuoteStore {
  constructor(private db: Database.Database) {}

  set(quote: Quote): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO quotes (quote_id, data, expires_at) VALUES (?, ?, ?)"
    ).run(quote.quote_id, JSON.stringify(quote), quote.expires_at);
  }

  get(id: string): Quote | undefined {
    const row = this.db.prepare("SELECT data FROM quotes WHERE quote_id = ?").get(id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM quotes").get() as any).n;
  }
}

export class SessionStore {
  constructor(private db: Database.Database) {}

  set(session: CheckoutSession): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO checkout_sessions (checkout_session_id, quote_id, data, status, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(session.checkout_session_id, session.quote_id, JSON.stringify(session), session.status);
  }

  get(id: string): CheckoutSession | undefined {
    const row = this.db.prepare("SELECT data FROM checkout_sessions WHERE checkout_session_id = ?").get(id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }

  update(session: CheckoutSession): void { this.set(session); }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM checkout_sessions WHERE status IN ('pending_approval','approved')").get() as any).n;
  }
}

export class OrderStore {
  constructor(private db: Database.Database) {}

  set(order: Order): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO orders (order_id, checkout_session_id, data) VALUES (?, ?, ?)"
    ).run(order.order_id, order.checkout_session_id, JSON.stringify(order));
  }

  get(id: string): Order | undefined {
    const row = this.db.prepare("SELECT data FROM orders WHERE order_id = ?").get(id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM orders").get() as any).n;
  }
}

export class AuditStore {
  constructor(private db: Database.Database) {}

  append(entry: Omit<AuditEntry, "timestamp">): void {
    const full = { ...entry, timestamp: new Date().toISOString() };
    this.db.prepare("INSERT INTO audit_log (action, data) VALUES (?, ?)").run(entry.action, JSON.stringify(full));
  }

  recent(limit: number): AuditEntry[] {
    const rows = this.db.prepare("SELECT data FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as any[];
    return rows.map(r => JSON.parse(r.data));
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM audit_log").get() as any).n;
  }
}

export class PolicyStore {
  constructor(private db: Database.Database) {}

  set(policy: UserPolicy): void {
    this.db.prepare("INSERT OR REPLACE INTO policies (policy_id, data) VALUES (?, ?)").run(policy.id, JSON.stringify(policy));
  }

  get(id: string): UserPolicy | undefined {
    const row = this.db.prepare("SELECT data FROM policies WHERE policy_id = ?").get(id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }

  all(): UserPolicy[] {
    return (this.db.prepare("SELECT data FROM policies").all() as any[]).map(r => JSON.parse(r.data));
  }
}

export class PaymentTokenStore {
  constructor(private db: Database.Database) {}

  set(sessionId: string, data: any): void {
    this.db.prepare("INSERT OR REPLACE INTO payment_tokens (checkout_session_id, data) VALUES (?, ?)").run(sessionId, JSON.stringify(data));
  }

  get(sessionId: string): any | undefined {
    const row = this.db.prepare("SELECT data FROM payment_tokens WHERE checkout_session_id = ?").get(sessionId) as any;
    return row ? JSON.parse(row.data) : undefined;
  }
}

export default { createDb, ProductStore, QuoteStore, SessionStore, OrderStore, AuditStore, PolicyStore, PaymentTokenStore };
