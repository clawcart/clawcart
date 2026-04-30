// Policy engine unit tests
import { describe, it, expect, beforeEach } from "vitest";
import { PolicyEngine } from "@clawcart/policy-engine";
import type { UserPolicy, Quote, Product, PolicyId } from "@clawcart/protocol";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;
  const policy: UserPolicy = {
    id: "pol_test" as PolicyId,
    name: "Electronics under $200",
    max_total_cents: 20000,
    currency: "usd",
    allowed_conditions: ["new"],
    blocked_categories: ["alcohol", "tobacco"],
    free_returns_required: true,
    warranty_required: true,
    delivery_days_max: 5,
    approval_required: true,
  };

  const quote: Quote = {
    quote_id: "qt_test" as any,
    merchant_id: "mrc_test" as any,
    expires_at: new Date(Date.now() + 900000).toISOString(),
    cart_hash: "sha256:abc",
    items: [{ sku: "TEST-001", qty: 1, name: "Test Product", price_cents: 17900 }],
    totals: { currency: "usd", subtotal_cents: 17900, shipping_cents: 0, tax_cents: 1397, total_cents: 19297 },
    delivery: { estimated_days: 4, carrier: "UPS" },
    policy: { free_returns: true, return_window_days: 30, subscription: false },
    approval: { required: true, reason: "payment_capture" },
  };

  beforeEach(() => {
    engine = new PolicyEngine();
    engine.register(policy);
  });

  it("validates a compliant quote", () => {
    const result = engine.validateQuote(quote, "pol_test" as PolicyId);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("rejects over-budget quote", () => {
    const expensive = { ...quote, totals: { ...quote.totals, total_cents: 25000 } };
    const result = engine.validateQuote(expensive, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("price_exceeds_limit");
  });

  it("rejects wrong currency", () => {
    const euro = { ...quote, totals: { ...quote.totals, currency: "eur" } };
    const result = engine.validateQuote(euro, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("currency_mismatch");
  });

  it("rejects slow delivery", () => {
    const slow = { ...quote, delivery: { estimated_days: 10, carrier: "USPS" } };
    const result = engine.validateQuote(slow, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("delivery_too_slow");
  });

  it("rejects no free returns when required", () => {
    const noReturns = { ...quote, policy: { ...quote.policy, free_returns: false } };
    const result = engine.validateQuote(noReturns, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("free_returns_required");
  });

  it("rejects subscription when not allowed", () => {
    const sub = { ...quote, policy: { ...quote.policy, subscription: true } };
    const result = engine.validateQuote(sub, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("subscription_not_allowed");
  });

  it("validates product against policy", () => {
    const product: Product = {
      sku: "TEST-001", name: "Test", price_cents: 17900, currency: "usd",
      stock_status: "in_stock", categories: ["electronics"], condition: "new",
      merchant_id: "mrc_test" as any, merchant_name: "Test", merchant_trust_score: 90,
      free_returns: true, warranty: "1 year", agent_checkout_supported: true,
    };
    const result = engine.validateProduct(product, "pol_test" as PolicyId);
    expect(result.valid).toBe(true);
  });

  it("blocks product in blocked category", () => {
    const product: Product = {
      sku: "ALC-001", name: "Wine", price_cents: 2500, currency: "usd",
      stock_status: "in_stock", categories: ["alcohol"], condition: "new",
      merchant_id: "mrc_test" as any, merchant_name: "Test", merchant_trust_score: 90,
      free_returns: true, warranty: undefined, agent_checkout_supported: true,
    };
    const result = engine.validateProduct(product, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("blocked_category");
  });

  it("blocks used condition when only new allowed", () => {
    const product: Product = {
      sku: "USED-001", name: "Used Item", price_cents: 5000, currency: "usd",
      stock_status: "in_stock", categories: ["electronics"], condition: "used",
      merchant_id: "mrc_test" as any, merchant_name: "Test", merchant_trust_score: 90,
      free_returns: true, warranty: "none", agent_checkout_supported: true,
    };
    const result = engine.validateProduct(product, "pol_test" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("condition_not_allowed");
  });

  it("requiresApproval returns true when policy says so", () => {
    expect(engine.requiresApproval("pol_test" as PolicyId, 15000)).toBe(true);
  });

  it("returns error for unknown policy", () => {
    const result = engine.validateQuote(quote, "pol_unknown" as PolicyId);
    expect(result.valid).toBe(false);
    expect(result.violations[0].code).toBe("policy_not_found");
  });
});
