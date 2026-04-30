// End-to-end checkout flow test
// Simulates: user intent → search → quote → policy check → prepare → approve → complete
import { describe, it, expect } from "vitest";

const BASE = process.env.CLAWCART_API_URL || "http://localhost:7733";

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

describe("End-to-end checkout flow", () => {
  it("completes the full agent shopping flow", async () => {
    // ── Step 1: Register user policy ──
    const policyRes = await api("POST", "/agent/policy/register", {
      id: "pol_e2e_test",
      name: "E2E Test - Electronics under $200",
      max_total_cents: 20000,
      currency: "usd",
      allowed_conditions: ["new"],
      blocked_categories: ["alcohol", "tobacco"],
      free_returns_required: true,
      warranty_required: true,
      delivery_days_max: 5,
      approval_required: true,
    });
    expect(policyRes.status).toBe(201);

    // ── Step 2: Search products ──
    const searchRes = await api("GET", "/agent/products/search?q=dash+cam&max_total_cents=20000&free_returns=true");
    expect(searchRes.status).toBe(200);
    expect(searchRes.data.results.length).toBeGreaterThan(0);

    const product = searchRes.data.results[0];
    expect(product.agent_checkout_supported).toBe(true);
    expect(product.price_cents).toBeLessThanOrEqual(20000);

    // ── Step 3: Create quote ──
    const quoteRes = await api("POST", "/agent/quote", {
      items: [{ sku: product.sku, qty: 1 }],
      constraints: { max_total_cents: 20000, currency: "usd", free_returns: true },
    });
    expect(quoteRes.status).toBe(201);
    expect(quoteRes.data.totals.total_cents).toBeLessThanOrEqual(20000);
    expect(quoteRes.data.approval.required).toBe(true);

    const quote = quoteRes.data;

    // ── Step 4: Validate policy ──
    const policyCheck = await api("POST", "/agent/policy/validate", {
      quote_id: quote.quote_id,
      policy_id: "pol_e2e_test",
    });
    expect(policyCheck.status).toBe(200);
    expect(policyCheck.data.valid).toBe(true);

    // ── Step 5: Prepare checkout ──
    const prepRes = await api("POST", "/agent/checkout/prepare", {
      quote_id: quote.quote_id,
      cart_hash: quote.cart_hash,
      user_policy_id: "pol_e2e_test",
    });
    expect(prepRes.status).toBe(201);
    expect(prepRes.data.requires_user_approval).toBe(true);
    expect(prepRes.data.approval_prompt).toContain("$");

    const session = prepRes.data;

    // ── Step 6: Accept payment token ──
    const tokenRes = await api("POST", "/agent/payment-token/accept", {
      checkout_session_id: session.checkout_session_id,
      payment_token: "pmtok_e2e_test",
      scope: {
        merchant_id: quote.merchant_id,
        quote_id: quote.quote_id,
        max_authorized_cents: quote.totals.total_cents + 100,
        currency: "usd",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.data.accepted).toBe(true);
    expect(tokenRes.data.ready_to_complete).toBe(true);

    // ── Step 7: Complete order ──
    const orderRes = await api("POST", "/agent/checkout/complete", {
      checkout_session_id: session.checkout_session_id,
      approval_receipt: "apr_e2e_approved",
      payment_token: "pmtok_e2e_test",
    });
    expect(orderRes.status).toBe(201);
    expect(orderRes.data.order_id).toMatch(/^ord_/);
    expect(orderRes.data.status).toBe("confirmed");
    expect(orderRes.data.total_cents).toBe(quote.totals.total_cents);

    // ── Step 8: Verify audit log ──
    const auditRes = await api("GET", "/agent/audit-log?limit=10");
    expect(auditRes.status).toBe(200);
    expect(auditRes.data.entries.length).toBeGreaterThan(0);
    expect(auditRes.data.entries.some((e: any) => e.action === "order.completed")).toBe(true);
  });
});
