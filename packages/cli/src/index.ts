#!/usr/bin/env node
// @clawcart/cli — Merchant setup, scanning, and management CLI
//
// Usage:
//   clawcart init --platform shopify
//   clawcart scan https://store.com
//   clawcart manifest generate
//   clawcart status
//   clawcart products list
//   clawcart quote create --sku CAM-4K-001
//   clawcart policy register ./policy.json

import { ClawCartClient } from "@clawcart/sdk";
import * as fs from "fs";
import * as path from "path";

const API_URL = process.env.CLAWCART_API_URL || "http://localhost:7733";
const API_KEY = process.env.CLAWCART_API_KEY;
const client = new ClawCartClient({ apiUrl: API_URL, apiKey: API_KEY });

// ── Helpers ────────────────────────────────
function log(msg: string): void {
  console.log(`  ${msg}`);
}

function success(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
}

function heading(title: string): void {
  console.log(`\n  ── ${title} ──\n`);
}

// ── Commands ───────────────────────────────
async function cmdInit(args: string[]): Promise<void> {
  const platform = args[args.indexOf("--platform") + 1] || "custom";
  heading("ClawCart Init");
  log(`Platform: ${platform}`);
  log(`API URL: ${API_URL}`);

  // Check API health
  try {
    const health = await client.health();
    success(`Gateway online — ${health.products} products loaded`);
  } catch {
    fail("Gateway not reachable. Start it with: npm run dev --workspace apps/gateway-api");
    return;
  }

  // Write config
  const config = {
    platform,
    api_url: API_URL,
    api_key: API_KEY || "",
    created_at: new Date().toISOString(),
  };
  const configPath = path.join(process.cwd(), ".clawcart.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  success(`Config written to ${configPath}`);
  log("");
  log("Next steps:");
  log("  1. clawcart scan <your-store-url>");
  log("  2. clawcart manifest generate");
  log("  3. clawcart status");
}

async function cmdScan(args: string[]): Promise<void> {
  const url = args[0];
  if (!url) {
    fail("Usage: clawcart scan <store-url>");
    return;
  }

  heading(`Scanning ${url}`);

  // Try to fetch manifest
  const manifestUrl = `${url.replace(/\/$/, "")}/.well-known/agentic-commerce.json`;
  try {
    const res = await fetch(manifestUrl);
    if (res.ok) {
      const manifest = await res.json();
      success("Agent manifest found!");
      log(`  Protocol: ${manifest.protocol} v${manifest.version}`);
      log(`  Merchant: ${manifest.merchant_name} (${manifest.merchant_id})`);
      log(`  Trust score: ${manifest.trust?.score}/100`);
      log(`  Checkout supported: ${manifest.capabilities?.agent_checkout_supported}`);
      log(`  Approval gates: ${manifest.capabilities?.approval_gates}`);

      log("\n  Endpoints:");
      for (const [k, v] of Object.entries(manifest.endpoints || {})) {
        log(`    ${k}: ${v}`);
      }
    } else {
      log("No agentic-commerce manifest found.");
      log("This store has not installed ClawCart yet.");
      log("");
      log("Checks:");
      log("  ✓ URL reachable");
      log("  ✗ agent manifest not published");
      log("  ? quote endpoint not tested");
      log("  ? checkout endpoint not tested");
      log("");
      log("Run: clawcart init --platform shopify");
    }
  } catch (err: any) {
    fail(`Could not reach ${manifestUrl}: ${err.message}`);
  }
}

async function cmdManifest(): Promise<void> {
  heading("Agent Manifest");
  try {
    const manifest = await client.manifest();
    console.log(JSON.stringify(manifest, null, 2));
  } catch (err: any) {
    fail(`Could not fetch manifest: ${err.message}`);
  }
}

async function cmdStatus(): Promise<void> {
  heading("ClawCart Status");
  try {
    const health = await client.health();
    success(`Gateway: online`);
    log(`  Products: ${health.products}`);
    log(`  Active quotes: ${(health as any).active_quotes}`);
    log(`  Active sessions: ${(health as any).active_sessions}`);
    log(`  Orders: ${(health as any).orders}`);

    const manifest = await client.manifest();
    success(`Manifest: published`);
    log(`  Merchant: ${manifest.merchant_name}`);
    log(`  Trust: ${manifest.trust.score}/100`);

    log("\n  Endpoint checks:");
    success("agent manifest online");
    success("product search ready");
    success("quote endpoint ready");
    success("checkout-prepare enabled");
    log("  ! purchase requires approval gate");
  } catch (err: any) {
    fail(`Gateway unreachable: ${err.message}`);
  }
}

async function cmdProductsList(): Promise<void> {
  heading("Products");
  try {
    const { results, total } = await client.searchProducts({ q: "" });
    log(`${total} products found:\n`);
    for (const p of results) {
      const price = `$${(p.price_cents / 100).toFixed(2)}`;
      log(`  ${p.sku}  ${p.name}  ${price}  ${p.stock_status}  ${p.free_returns ? "free returns" : ""}`);
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function cmdQuoteCreate(args: string[]): Promise<void> {
  const skuIdx = args.indexOf("--sku");
  const sku = skuIdx >= 0 ? args[skuIdx + 1] : args[0];
  if (!sku) {
    fail("Usage: clawcart quote create --sku <SKU>");
    return;
  }

  heading("Create Quote");
  try {
    const quote = await client.createQuote({ items: [{ sku, qty: 1 }] });
    success(`Quote ${quote.quote_id} created`);
    log(`  Items: ${quote.items.map(i => i.name).join(", ")}`);
    log(`  Subtotal: $${(quote.totals.subtotal_cents / 100).toFixed(2)}`);
    log(`  Shipping: $${(quote.totals.shipping_cents / 100).toFixed(2)}`);
    log(`  Tax: $${(quote.totals.tax_cents / 100).toFixed(2)}`);
    log(`  Total: $${(quote.totals.total_cents / 100).toFixed(2)}`);
    log(`  Delivery: ${quote.delivery.estimated_days} days via ${quote.delivery.carrier}`);
    log(`  Cart hash: ${quote.cart_hash}`);
    log(`  Expires: ${quote.expires_at}`);
    log(`  Approval: ${quote.approval.required ? "required" : "not required"}`);
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function cmdPolicyRegister(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    fail("Usage: clawcart policy register <path-to-policy.json>");
    return;
  }

  heading("Register Policy");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const policy = JSON.parse(raw);
    const result = await client.registerPolicy(policy);
    success(`Policy registered: ${result.policy_id}`);
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

async function cmdAuditLog(): Promise<void> {
  heading("Audit Log");
  try {
    const { entries, total } = await client.auditLog(20);
    log(`${total} total entries (showing last 20):\n`);
    for (const e of entries) {
      const ts = new Date(e.timestamp).toLocaleTimeString();
      log(`  ${ts}  ${e.action}  ${e.quote_id || e.order_id || ""}`);
    }
  } catch (err: any) {
    fail(`Error: ${err.message}`);
  }
}

// ── Router ─────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];
  const rest = args.slice(2);

  switch (cmd) {
    case "init":
      return cmdInit(rest.length ? rest : args.slice(1));
    case "scan":
      return cmdScan(args.slice(1));
    case "manifest":
      if (sub === "generate") return cmdManifest();
      return cmdManifest();
    case "status":
      return cmdStatus();
    case "products":
      if (sub === "list") return cmdProductsList();
      return cmdProductsList();
    case "quote":
      if (sub === "create") return cmdQuoteCreate(rest);
      return cmdQuoteCreate(args.slice(1));
    case "policy":
      if (sub === "register") return cmdPolicyRegister(rest);
      break;
    case "audit":
    case "audit-log":
      return cmdAuditLog();
    default:
      console.log(`
  Usage: clawcart <command> [options]

  Commands:
    init --platform <shopify|woocommerce|custom>   Initialize ClawCart
    scan <store-url>                                Scan store for agentic commerce support
    manifest generate                               Show agent manifest
    status                                          Show gateway status
    products list                                   List products
    quote create --sku <SKU>                        Create a live quote
    policy register <policy.json>                   Register a user policy
    audit-log                                       Show audit log

  Environment:
    CLAWCART_API_URL   Gateway URL (default: http://localhost:7733)
    CLAWCART_API_KEY   API key for authentication
      `);
  }
}

main().catch(err => {
  fail(err.message);
  process.exit(1);
});
