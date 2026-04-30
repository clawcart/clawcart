// Gateway API integration tests
import { describe, it, expect, beforeAll } from "vitest";

const BASE = process.env.CLAWCART_API_URL || "http://localhost:7733";

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

describe("ClawCart Gateway API", () => {
  it("GET /health returns ok", async () => {
    const { status, data } = await api("GET", "/health");
    expect(status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.products).toBeGreaterThan(0);
  });

  it("GET /.well-known/agentic-commerce.json returns manifest", async () => {
    const { status, data } = await api("GET", "/.well-known/agentic-commerce.json");
    expect(status).toBe(200);
    expect(data.protocol).toBe("agentic-commerce");
    expect(data.version).toBe("0.1.0");
    expect(data.capabilities.agent_checkout_supported).toBe(true);
    expect(data.capabilities.approval_gates).toBe(true);
  });

  it("GET /agent/products/search returns products", async () => {
    const { status, data } = await api("GET", "/agent/products/search?q=dash+cam");
    expect(status).toBe(200);
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0]).toHaveProperty("sku");
    expect(data.results[0]).toHaveProperty("price_cents");
    expect(data.results[0].agent_checkout_supported).toBe(true);
  });

  it("POST /agent/quote creates a quote", async () => {
    const { status, data } = await api("POST", "/agent/quote", {
      items: [{ sku: "CAM-4K-001", qty: 1 }],
      constraints: { max_total_cents: 25000 },
    });
    expect(status).toBe(201);
    expect(data.quote_id).toMatch(/^qt_/);
    expect(data.cart_hash).toMatch(/^sha256:/);
    expect(data.totals.total_cents).toBeGreaterThan(0);
    expect(data.approval.required).toBe(true);
  });

  it("POST /agent/quote rejects over-budget", async () => {
    const { status, data } = await api("POST", "/agent/quote", {
      items: [{ sku: "CAM-4K-001", qty: 1 }],
      constraints: { max_total_cents: 100 },
    });
    expect(status).toBe(422);
    expect(data.error).toBe("policy_violation");
  });

  it("full checkout flow works end-to-end", async () => {
    // 1. Search
    const search = await api("GET", "/agent/products/search?q=charger");
    expect(search.data.results.length).toBeGreaterThan(0);
    const sku = search.data.results[0].sku;

    // 2. Quote
    const quote = await api("POST", "/agent/quote", { items: [{ sku, qty: 1 }] });
    expect(quote.status).toBe(201);

    // 3. Prepare
    const prep = await api("POST", "/agent/checkout/prepare", {
      quote_id: quote.data.quote_id,
      cart_hash: quote.data.cart_hash,
    });
    expect(prep.status).toBe(201);
    expect(prep.data.checkout_session_id).toMatch(/^chk_/);
    expect(prep.data.requires_user_approval).toBe(true);

    // 4. Complete
    const complete = await api("POST", "/agent/checkout/complete", {
      checkout_session_id: prep.data.checkout_session_id,
      approval_receipt: "apr_test_receipt",
      payment_token: "pmtok_test_token",
    });
    expect(complete.status).toBe(201);
    expect(complete.data.order_id).toMatch(/^ord_/);
    expect(complete.data.status).toBe("confirmed");
  });
});
