// @clawcart/openclaw-plugin — OpenClaw plugin for agentic commerce
//
// Registers ClawCart tools, config schema, and policy gates with OpenClaw.
// Install: openclaw plugins install @clawcart/openclaw-plugin
// Enable:  openclaw plugins enable clawcart

import { tools, executeTool } from "@clawcart/mcp-server";

export const pluginManifest = {
  id: "clawcart",
  name: "ClawCart Agentic Commerce",
  version: "0.1.0",
  description:
    "Agentic merchant gateway tools for product search, quote, policy validation, and approval-gated checkout.",
  configSchema: {
    type: "object",
    properties: {
      apiUrl: { type: "string", default: "http://localhost:7733" },
      apiKeyEnv: { type: "string", default: "CLAWCART_API_KEY" },
      requireApprovalForCheckout: { type: "boolean", default: true },
    },
    required: ["apiUrl"],
  },
  tools: tools.map(t => t.name),
  skills: ["clawcart-commerce"],
};

export interface OpenClawPluginContext {
  config: Record<string, any>;
  log: (msg: string) => void;
}

/** Called by OpenClaw when the plugin is loaded */
export function activate(ctx: OpenClawPluginContext): {
  tools: typeof tools;
  execute: typeof executeTool;
} {
  const apiUrl = ctx.config.apiUrl || "http://localhost:7733";
  ctx.log(`[clawcart] activated — gateway: ${apiUrl}`);

  // Set env for SDK client used by MCP server
  process.env.CLAWCART_API_URL = apiUrl;
  if (ctx.config.apiKeyEnv) {
    process.env.CLAWCART_API_KEY = process.env[ctx.config.apiKeyEnv] || "";
  }

  return { tools, execute: executeTool };
}

/** Called by OpenClaw when the plugin is unloaded */
export function deactivate(): void {
  // cleanup if needed
}

export default { pluginManifest, activate, deactivate };
