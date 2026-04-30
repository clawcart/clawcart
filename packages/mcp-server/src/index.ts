// @clawcart/mcp-server — MCP bridge for OpenClaw and other MCP-compatible runtimes
//
// Exposes ClawCart commerce tools as MCP-compatible tool definitions.
// Run: clawcart-mcp --stdio   (for local pipe)
//      clawcart-mcp --http    (for HTTP endpoint at /mcp)

import { ClawCartClient } from "@clawcart/sdk";
import type { PolicyId, ApprovalReceipt, PaymentToken } from "@clawcart/protocol";

const API_URL = process.env.CLAWCART_API_URL || "http://localhost:7733";
const API_KEY = process.env.CLAWCART_API_KEY;

const client = new ClawCartClient({ apiUrl: API_URL, apiKey: API_KEY });

// ── Tool Definitions ───────────────────────
export const tools = [
  {
    name: "clawcart.product.search",
    description: "Search ClawCart-compatible merchant product catalogs. Returns products with prices, availability, and agent checkout support.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g. '4k dash cam')" },
        max_total_cents: { type: "number", description: "Maximum price in cents" },
        currency: { type: "string", default: "usd" },
        delivery_days_max: { type: "number", description: "Maximum delivery days" },
        free_returns: { type: "boolean", description: "Require free returns" },
        blocked_categories: { type: "array", items: { type: "string" }, description: "Categories to exclude" },
      },
      required: ["query"],
    },
  },
  {
    name: "clawcart.quote.create",
    description: "Create a live quote for specific products. Returns pricing breakdown, delivery estimate, and approval requirements.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "number", default: 1 } },
            required: ["sku"],
          },
        },
        max_total_cents: { type: "number", description: "Budget limit in cents" },
      },
      required: ["items"],
    },
  },
  {
    name: "clawcart.checkout.prepare",
    description: "Prepare a checkout session from a quote. Locks the cart and returns approval requirements. Does NOT complete purchase.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "Quote ID from quote.create" },
        cart_hash: { type: "string", description: "Cart hash from quote response" },
        user_policy_id: { type: "string", description: "Optional user policy ID to validate against" },
      },
      required: ["quote_id", "cart_hash"],
    },
  },
  {
    name: "clawcart.checkout.complete",
    description: "Complete an approved checkout session. Requires explicit user approval receipt and payment token. This WILL charge the user.",
    inputSchema: {
      type: "object",
      properties: {
        checkout_session_id: { type: "string" },
        approval_receipt: { type: "string", description: "User approval receipt" },
        payment_token: { type: "string", description: "Scoped payment token" },
      },
      required: ["checkout_session_id", "approval_receipt", "payment_token"],
    },
  },
  {
    name: "clawcart.policy.validate",
    description: "Validate a quote against a user-defined purchasing policy. Returns violations if any rules are broken.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string" },
        policy_id: { type: "string" },
      },
      required: ["quote_id", "policy_id"],
    },
  },
  {
    name: "clawcart.merchant.scan",
    description: "Check if a merchant supports the agentic commerce protocol by fetching their manifest.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool Execution ─────────────────────────
export async function executeTool(name: string, input: Record<string, any>): Promise<any> {
  switch (name) {
    case "clawcart.product.search":
      return client.searchProducts({
        q: input.query,
        max_total_cents: input.max_total_cents,
        currency: input.currency,
        delivery_days_max: input.delivery_days_max,
        free_returns: input.free_returns,
        blocked_categories: input.blocked_categories,
      });

    case "clawcart.quote.create":
      return client.createQuote({
        items: input.items,
        constraints: input.max_total_cents ? { max_total_cents: input.max_total_cents } : undefined,
      });

    case "clawcart.checkout.prepare":
      return client.prepareCheckout({
        quote_id: input.quote_id,
        cart_hash: input.cart_hash,
        user_policy_id: input.user_policy_id as PolicyId,
      });

    case "clawcart.checkout.complete":
      return client.completeCheckout({
        checkout_session_id: input.checkout_session_id,
        approval_receipt: input.approval_receipt as ApprovalReceipt,
        payment_token: input.payment_token as PaymentToken,
      });

    case "clawcart.policy.validate":
      return client.validatePolicy(input.quote_id, input.policy_id as PolicyId);

    case "clawcart.merchant.scan":
      return client.manifest();

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Stdio MCP Transport ────────────────────
async function handleStdio(): Promise<void> {
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    try {
      const msg = JSON.parse(line);

      if (msg.method === "tools/list") {
        const response = { jsonrpc: "2.0", id: msg.id, result: { tools } };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (msg.method === "tools/call") {
        const result = await executeTool(msg.params.name, msg.params.arguments || {});
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      } else if (msg.method === "initialize") {
        const response = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "clawcart-mcp", version: "0.1.0" },
          },
        };
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err: any) {
      const errResp = { jsonrpc: "2.0", id: null, error: { code: -32603, message: err.message } };
      process.stdout.write(JSON.stringify(errResp) + "\n");
    }
  }
}

// ── Entry ──────────────────────────────────
const mode = process.argv.includes("--stdio") ? "stdio" : "list";

if (mode === "stdio") {
  handleStdio().catch(console.error);
} else {
  // Default: list tools
  console.log("ClawCart MCP Server");
  console.log(`API: ${API_URL}`);
  console.log(`Tools: ${tools.length}`);
  console.log(tools.map(t => `  - ${t.name}: ${t.description.slice(0, 60)}...`).join("\n"));
  console.log("\nRun with --stdio for MCP pipe mode");
}

export default { tools, executeTool };
