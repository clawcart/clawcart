// ClawCart Gateway API — Agentic commerce merchant gateway
// Now with SQLite persistence (WAL mode, survives restarts)
//
// Endpoints:
//   GET  /.well-known/agentic-commerce.json   Manifest / discovery
//   GET  /agent/products/search               Product search
//   POST /agent/quote                         Create live quote
//   POST /agent/checkout/prepare              Prepare checkout session
//   POST /agent/payment-token/accept          Accept scoped payment token
//   POST /agent/checkout/complete             Complete order
//   GET  /agent/audit-log                     Audit trail
//   POST /agent/policy/validate               Validate policy against quote
//   POST /agent/policy/register               Register user policy
//   POST /admin/products                      Add/update products
//   GET  /health                              Health check

import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { PolicyEngine } from "@clawcart/policy-engine";
import {
  createDb, ProductStore, QuoteStore, SessionStore, OrderStore,
  AuditStore, PolicyStore, PaymentTokenStore,
} from "./db.js";
import type {
  Product, Quote, QuoteId, CheckoutSession, CheckoutSessionId,
  Order, OrderId, MerchantId, AuditEntry, AgenticCommerceManifest,
  QuoteRequest, CheckoutPrepareRequest, CheckoutCompleteRequest,
  PolicyId, ApprovalReceipt, PaymentToken, UserPolicy,
} from "@clawcart/protocol";
import { ErrorCodes } from "@clawcart/protocol";

// ── Database ───────────────────────────────
const db = createDb();
const productStore = new ProductStore(db);
const quoteStore = new QuoteStore(db);
const sessionStore = new SessionStore(db);
const orderStore = new OrderStore(db);
const auditStore = new AuditStore(db);
const policyStore = new PolicyStore(db);
const tokenStore = new PaymentTokenStore(db);
const policyEngine = new PolicyEngine();

// Load persisted policies into engine on boot
for (const p of policyStore.all()) policyEngine.register(p);

const MERCHANT_ID: MerchantId = "mrc_demo";
const MERCHANT_NAME = "ClawCart Demo Store";
const QUOTE_TTL_MS = 15 * 60 * 1000;
const CHECKOUT_TTL_MS = 30 * 60 * 1000;

// ── Helpers ────────────────────────────────
function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function cartHash(items: Array<{ sku: string; qty: number }>): string {
  const payload = items.map(i => `${i.sku}:${i.qty}`).sort().join("|");
  return "sha256:" + crypto.createHash("sha256").update(payload).digest("hex").slice(0, 12);
}

function audit(entry: Omit<AuditEntry, "timestamp">): void {
  auditStore.append(entry);
}

function taxCents(subtotal: number): number {
  return Math.round(subtotal * 0.0875);
}

// ── App ────────────────────────────────────
const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-ClawCart-API-Key");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

const API_KEY = process.env.CLAWCART_API_KEY;
function auth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) return next();
  const key = req.headers["x-clawcart-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== API_KEY) { res.status(401).json({ error: ErrorCodes.UNAUTHORIZED }); return; }
  next();
}

// ── Manifest ────────────────────────────────
app.get("/.well-known/agentic-commerce.json", (_req, res) => {
  const baseUrl = process.env.CLAWCART_API_URL || "http://localhost:7733";
  const manifest: AgenticCommerceManifest = {
    protocol: "agentic-commerce",
    version: "0.1.0",
    merchant_id: MERCHANT_ID,
    merchant_name: MERCHANT_NAME,
    endpoints: {
      product_search: `${baseUrl}/agent/products/search`,
      quote_create: `${baseUrl}/agent/quote`,
      checkout_prepare: `${baseUrl}/agent/checkout/prepare`,
      checkout_complete: `${baseUrl}/agent/checkout/complete`,
      payment_token_accept: `${baseUrl}/agent/payment-token/accept`,
    },
    capabilities: {
      agent_checkout_supported: true,
      approval_gates: true,
      scoped_payment_tokens: true,
      free_returns_available: true,
      subscription_products: false,
    },
    trust: { score: 91, verified: true, reviews_count: 2847 },
  };
  res.json(manifest);
});

// ── Product Search ──────────────────────────
app.get("/agent/products/search", auth, (req: Request, res: Response) => {
  const q = (req.query.q as string || "").toLowerCase();
  const maxCents = req.query.max_total_cents ? Number(req.query.max_total_cents) : undefined;
  const freeReturns = req.query.free_returns === "true" ? true : undefined;
  const deliveryMax = req.query.delivery_days_max ? Number(req.query.delivery_days_max) : undefined;
  const blockedCats = req.query.blocked_categories ? (req.query.blocked_categories as string).split(",") : [];
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const offset = Number(req.query.offset) || 0;

  const allResults = productStore.search(p => {
    if (p.stock_status === "out_of_stock") return false;
    if (q && !p.name.toLowerCase().includes(q) && !p.description?.toLowerCase().includes(q)) return false;
    if (maxCents && p.price_cents > maxCents) return false;
    if (freeReturns && !p.free_returns) return false;
    if (deliveryMax && p.delivery_days_estimate && p.delivery_days_estimate > deliveryMax) return false;
    if (blockedCats.length && p.categories.some(c => blockedCats.includes(c))) return false;
    return true;
  });

  const total = allResults.length;
  const results = allResults.slice(offset, offset + limit);

  audit({ action: "product.search", merchant_id: MERCHANT_ID, metadata: { q, results_count: total } });
  res.json({ results, total, offset, limit });
});

// ── Quote ───────────────────────────────────
app.post("/agent/quote", auth, (req: Request, res: Response) => {
  const { items, constraints } = req.body as QuoteRequest;
  if (!items?.length) { res.status(400).json({ error: "missing_items" }); return; }

  const resolved: Array<{ sku: string; qty: number; name: string; price_cents: number }> = [];
  for (const item of items) {
    const product = productStore.get(item.sku);
    if (!product) { res.status(404).json({ error: ErrorCodes.PRODUCT_NOT_FOUND, sku: item.sku }); return; }
    if (product.stock_status === "out_of_stock") { res.status(409).json({ error: ErrorCodes.OUT_OF_STOCK, sku: item.sku }); return; }
    resolved.push({ sku: item.sku, qty: item.qty, name: product.name, price_cents: product.price_cents });
  }

  const subtotal = resolved.reduce((s, i) => s + i.price_cents * i.qty, 0);
  const shipping = subtotal >= 5000 ? 0 : 799;
  const tax = taxCents(subtotal);
  const total = subtotal + shipping + tax;

  if (constraints?.max_total_cents && total > constraints.max_total_cents) {
    audit({ action: "policy.blocked", merchant_id: MERCHANT_ID, metadata: { reason: "price_exceeds_limit", max: constraints.max_total_cents, actual: total } });
    res.status(422).json({ error: ErrorCodes.POLICY_VIOLATION, max_total_cents: constraints.max_total_cents, actual_total_cents: total });
    return;
  }

  const quoteId = genId("qt") as QuoteId;
  const firstProduct = productStore.get(items[0].sku);

  const quote: Quote = {
    quote_id: quoteId,
    merchant_id: MERCHANT_ID,
    expires_at: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    cart_hash: cartHash(items),
    items: resolved,
    totals: { currency: constraints?.currency || "usd", subtotal_cents: subtotal, shipping_cents: shipping, tax_cents: tax, total_cents: total },
    delivery: { estimated_days: firstProduct?.delivery_days_estimate || 5, carrier: "UPS" },
    policy: { free_returns: firstProduct?.free_returns ?? true, return_window_days: firstProduct?.return_window_days ?? 30, subscription: false },
    approval: { required: true, reason: "payment_capture" },
  };

  quoteStore.set(quote);
  audit({ action: "quote.created", merchant_id: MERCHANT_ID, quote_id: quoteId, cart_hash: quote.cart_hash, total_cents: total });
  res.status(201).json(quote);
});

// ── Checkout Prepare ────────────────────────
app.post("/agent/checkout/prepare", auth, (req: Request, res: Response) => {
  const { quote_id, cart_hash, user_policy_id } = req.body as CheckoutPrepareRequest;

  const quote = quoteStore.get(quote_id);
  if (!quote) { res.status(404).json({ error: ErrorCodes.QUOTE_NOT_FOUND }); return; }
  if (new Date(quote.expires_at) < new Date()) { res.status(410).json({ error: ErrorCodes.QUOTE_EXPIRED }); return; }
  if (quote.cart_hash !== cart_hash) { res.status(409).json({ error: ErrorCodes.CART_HASH_MISMATCH }); return; }

  if (user_policy_id) {
    const result = policyEngine.validateQuote(quote, user_policy_id);
    if (!result.valid) {
      audit({ action: "policy.blocked", merchant_id: MERCHANT_ID, quote_id: quote.quote_id, policy_id: user_policy_id, violations: result.violations });
      res.status(422).json({ error: ErrorCodes.POLICY_VIOLATION, violations: result.violations });
      return;
    }
  }

  const sessionId = genId("chk") as CheckoutSessionId;
  const needsApproval = user_policy_id ? policyEngine.requiresApproval(user_policy_id, quote.totals.total_cents) : true;
  const itemNames = quote.items.map(i => i.name).join(", ");
  const totalFmt = `$${(quote.totals.total_cents / 100).toFixed(2)}`;

  const session: CheckoutSession = {
    checkout_session_id: sessionId,
    quote_id: quote.quote_id,
    merchant_id: MERCHANT_ID,
    requires_user_approval: needsApproval,
    approval_prompt: `Approve purchase of ${itemNames} for ${totalFmt}?`,
    payment_requirements: {
      token_supported: true,
      max_authorized_cents: quote.totals.total_cents + 100,
      merchant_binding_required: true,
      expires_at: new Date(Date.now() + CHECKOUT_TTL_MS).toISOString(),
    },
    status: needsApproval ? "pending_approval" : "approved",
    created_at: new Date().toISOString(),
  };

  sessionStore.set(session);
  audit({ action: "checkout.prepared", merchant_id: MERCHANT_ID, quote_id: quote.quote_id, checkout_session_id: sessionId, cart_hash: quote.cart_hash, total_cents: quote.totals.total_cents });
  res.status(201).json(session);
});

// ── Payment Token Accept ────────────────────
app.post("/agent/payment-token/accept", auth, (req: Request, res: Response) => {
  const { checkout_session_id, payment_token, scope } = req.body;
  const session = sessionStore.get(checkout_session_id);
  if (!session) { res.status(404).json({ error: ErrorCodes.CHECKOUT_NOT_FOUND }); return; }

  const quote = quoteStore.get(session.quote_id);
  if (!quote) { res.status(404).json({ error: ErrorCodes.QUOTE_NOT_FOUND }); return; }

  const valid = scope.merchant_id === MERCHANT_ID && scope.quote_id === session.quote_id &&
    scope.max_authorized_cents >= quote.totals.total_cents && scope.currency === quote.totals.currency &&
    new Date(scope.expires_at) > new Date();

  if (!valid) { res.status(422).json({ accepted: false, token_scope_valid: false, ready_to_complete: false, error: ErrorCodes.PAYMENT_TOKEN_INVALID }); return; }

  tokenStore.set(checkout_session_id, { sessionId: checkout_session_id, scope, token: payment_token });
  audit({ action: "payment_token.accepted", merchant_id: MERCHANT_ID, checkout_session_id: session.checkout_session_id, quote_id: session.quote_id });
  res.json({ accepted: true, token_scope_valid: true, ready_to_complete: true });
});

// ── Checkout Complete ───────────────────────
app.post("/agent/checkout/complete", auth, (req: Request, res: Response) => {
  const { checkout_session_id, approval_receipt, payment_token } = req.body as CheckoutCompleteRequest;
  const session = sessionStore.get(checkout_session_id);
  if (!session) { res.status(404).json({ error: ErrorCodes.CHECKOUT_NOT_FOUND }); return; }
  if (session.status === "completed") { res.status(409).json({ error: ErrorCodes.CHECKOUT_ALREADY_COMPLETED }); return; }
  if (session.status === "expired" || session.status === "cancelled") { res.status(410).json({ error: ErrorCodes.CHECKOUT_EXPIRED }); return; }
  if (new Date(session.payment_requirements.expires_at) < new Date()) {
    session.status = "expired"; sessionStore.update(session);
    res.status(410).json({ error: ErrorCodes.CHECKOUT_EXPIRED }); return;
  }
  if (session.requires_user_approval && !approval_receipt) { res.status(403).json({ error: ErrorCodes.APPROVAL_REQUIRED }); return; }
  if (!payment_token) { res.status(400).json({ error: ErrorCodes.PAYMENT_TOKEN_INVALID }); return; }

  const quote = quoteStore.get(session.quote_id);
  if (!quote) { res.status(404).json({ error: ErrorCodes.QUOTE_NOT_FOUND }); return; }

  const orderId = genId("ord") as OrderId;
  const order: Order = {
    order_id: orderId,
    checkout_session_id: session.checkout_session_id,
    merchant_id: MERCHANT_ID,
    status: "confirmed",
    total_cents: quote.totals.total_cents,
    currency: quote.totals.currency,
    receipt_url: `${process.env.CLAWCART_API_URL || "http://localhost:7733"}/orders/${orderId}`,
    created_at: new Date().toISOString(),
  };

  session.status = "completed";
  sessionStore.update(session);
  orderStore.set(order);
  audit({ action: "order.completed", merchant_id: MERCHANT_ID, quote_id: session.quote_id, checkout_session_id: session.checkout_session_id, order_id: orderId, cart_hash: quote.cart_hash, total_cents: quote.totals.total_cents, approval_receipt });
  res.status(201).json(order);
});

// ── Policy Validate ─────────────────────────
app.post("/agent/policy/validate", auth, (req: Request, res: Response) => {
  const { quote_id, policy_id } = req.body;
  const quote = quoteStore.get(quote_id);
  if (!quote) { res.status(404).json({ error: ErrorCodes.QUOTE_NOT_FOUND }); return; }
  res.json(policyEngine.validateQuote(quote, policy_id as PolicyId));
});

// ── Policy Register ─────────────────────────
app.post("/agent/policy/register", auth, (req: Request, res: Response) => {
  const policy = req.body as UserPolicy;
  if (!policy.id || !policy.name || !policy.max_total_cents) {
    res.status(400).json({ error: "invalid_policy" }); return;
  }
  policyStore.set(policy);
  policyEngine.register(policy);
  res.status(201).json({ registered: true, policy_id: policy.id });
});

// ── Audit Log ───────────────────────────────
app.get("/agent/audit-log", auth, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const entries = auditStore.recent(limit);
  res.json({ entries, total: auditStore.count() });
});

// ── Admin: Products ─────────────────────────
app.post("/admin/products", auth, (req: Request, res: Response) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const products: Product[] = items.map(item => ({
    sku: item.sku || genId("sku"),
    name: item.name,
    description: item.description,
    price_cents: item.price_cents,
    currency: item.currency || "usd",
    stock_status: item.stock_status || "in_stock",
    categories: item.categories || [],
    condition: item.condition || "new",
    merchant_id: MERCHANT_ID,
    merchant_name: MERCHANT_NAME,
    merchant_trust_score: 91,
    free_returns: item.free_returns ?? true,
    return_window_days: item.return_window_days ?? 30,
    warranty: item.warranty,
    delivery_days_estimate: item.delivery_days_estimate ?? 4,
    image_url: item.image_url,
    url: item.url,
    agent_checkout_supported: true,
  }));
  productStore.upsertMany(products);
  res.status(201).json({ added: items.length, total_products: productStore.count() });
});

// ── Health ──────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    version: "0.1.0",
    merchant_id: MERCHANT_ID,
    persistence: "sqlite",
    products: productStore.count(),
    active_quotes: quoteStore.count(),
    active_sessions: sessionStore.count(),
    orders: orderStore.count(),
  });
});

// ── Error handler ───────────────────────────
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[clawcart]", err);
  res.status(err.statusCode || 500).json({ error: err.code || "internal_error", message: err.message });
});

// ── Boot ────────────────────────────────────
const PORT = Number(process.env.PORT) || 7733;

function seedDemo(): void {
  if (productStore.count() > 0) return;
  const demo: Partial<Product>[] = [
    { sku: "CAM-4K-001", name: "4K Dash Cam + Hardwire Kit", price_cents: 17900, categories: ["electronics", "automotive"], warranty: "1 year", delivery_days_estimate: 4, description: "Ultra-wide 4K dash cam with hardwire kit, parking mode, GPS" },
    { sku: "CAM-4K-002", name: "Budget 4K Dash Cam", price_cents: 8900, categories: ["electronics", "automotive"], warranty: "6 months", delivery_days_estimate: 3, description: "Compact 4K dash cam, night vision, loop recording" },
    { sku: "HEADPHONES-001", name: "Wireless Noise-Cancelling Headphones", price_cents: 24900, categories: ["electronics", "audio"], warranty: "2 years", delivery_days_estimate: 2, description: "Over-ear ANC headphones, 40h battery, USB-C" },
    { sku: "KEYBOARD-001", name: "Mechanical Keyboard 75%", price_cents: 12900, categories: ["electronics", "peripherals"], warranty: "1 year", delivery_days_estimate: 3, description: "Hot-swappable mechanical keyboard, RGB, gasket mount" },
    { sku: "CHARGER-001", name: "100W GaN USB-C Charger", price_cents: 4500, categories: ["electronics", "accessories"], warranty: "1 year", delivery_days_estimate: 2, description: "4-port GaN charger, PD 3.1, 100W max single port" },
  ];
  const products: Product[] = demo.map(d => ({
    sku: d.sku!, name: d.name!, description: d.description, price_cents: d.price_cents!, currency: "usd",
    stock_status: "in_stock" as const, categories: d.categories || [], condition: "new" as const,
    merchant_id: MERCHANT_ID, merchant_name: MERCHANT_NAME, merchant_trust_score: 91,
    free_returns: true, return_window_days: 30, warranty: d.warranty,
    delivery_days_estimate: d.delivery_days_estimate, agent_checkout_supported: true,
  }));
  productStore.upsertMany(products);
  console.log(`[clawcart] seeded ${products.length} demo products`);
}

app.listen(PORT, () => {
  seedDemo();
  console.log(`
╔══════════════════════════════════════════════╗
║  ClawCart Gateway API v0.1.0                 ║
║  Port: ${PORT}                                 ║
║  DB: ${process.env.CLAWCART_DB_PATH || "clawcart.db"}                        ║
║  Merchant: ${MERCHANT_NAME}             ║
║  Manifest: /.well-known/agentic-commerce.json║
╚══════════════════════════════════════════════╝
  `);
});

export { app };
