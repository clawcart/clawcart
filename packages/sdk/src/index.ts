// @clawcart/sdk — TypeScript client for the ClawCart agentic commerce gateway

import type {
  ProductSearchRequest, ProductSearchResponse, QuoteRequest, Quote,
  CheckoutPrepareRequest, CheckoutSession, CheckoutCompleteRequest, Order,
  AgenticCommerceManifest, PolicyValidationResult, UserPolicy, AuditEntry,
  QuoteId, CheckoutSessionId, PolicyId, ApprovalReceipt, PaymentToken,
} from "@clawcart/protocol";

export interface ClawCartClientConfig {
  apiUrl: string;
  apiKey?: string;
  timeout?: number;
}

export class ClawCartClient {
  private baseUrl: string;
  private apiKey?: string;
  private timeout: number;

  constructor(config: ClawCartClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 30000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-ClawCart-API-Key"] = this.apiKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const data = await res.json();
      if (!res.ok) {
        const err = new Error(data.message || `HTTP ${res.status}`) as any;
        err.code = data.error;
        err.statusCode = res.status;
        err.details = data;
        throw err;
      }
      return data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch the agentic commerce manifest for discovery */
  async manifest(): Promise<AgenticCommerceManifest> {
    return this.request("GET", "/.well-known/agentic-commerce.json");
  }

  /** Search for products */
  async searchProducts(params: ProductSearchRequest): Promise<ProductSearchResponse> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.max_total_cents) qs.set("max_total_cents", String(params.max_total_cents));
    if (params.currency) qs.set("currency", params.currency);
    if (params.delivery_days_max) qs.set("delivery_days_max", String(params.delivery_days_max));
    if (params.free_returns !== undefined) qs.set("free_returns", String(params.free_returns));
    if (params.blocked_categories?.length) qs.set("blocked_categories", params.blocked_categories.join(","));
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return this.request("GET", `/agent/products/search?${qs.toString()}`);
  }

  /** Create a live quote */
  async createQuote(req: QuoteRequest): Promise<Quote> {
    return this.request("POST", "/agent/quote", req);
  }

  /** Prepare checkout from a quote */
  async prepareCheckout(req: CheckoutPrepareRequest): Promise<CheckoutSession> {
    return this.request("POST", "/agent/checkout/prepare", req);
  }

  /** Accept a scoped payment token */
  async acceptPaymentToken(sessionId: CheckoutSessionId, token: PaymentToken, scope: {
    merchant_id: string; quote_id: string; max_authorized_cents: number; currency: string; expires_at: string;
  }): Promise<{ accepted: boolean; token_scope_valid: boolean; ready_to_complete: boolean }> {
    return this.request("POST", "/agent/payment-token/accept", {
      checkout_session_id: sessionId,
      payment_token: token,
      scope,
    });
  }

  /** Complete checkout and place order */
  async completeCheckout(req: CheckoutCompleteRequest): Promise<Order> {
    return this.request("POST", "/agent/checkout/complete", req);
  }

  /** Validate a policy against a quote */
  async validatePolicy(quoteId: QuoteId, policyId: PolicyId): Promise<PolicyValidationResult> {
    return this.request("POST", "/agent/policy/validate", { quote_id: quoteId, policy_id: policyId });
  }

  /** Register a user policy */
  async registerPolicy(policy: UserPolicy): Promise<{ registered: boolean; policy_id: string }> {
    return this.request("POST", "/agent/policy/register", policy);
  }

  /** Fetch audit log */
  async auditLog(limit = 50): Promise<{ entries: AuditEntry[]; total: number }> {
    return this.request("GET", `/agent/audit-log?limit=${limit}`);
  }

  /** Health check */
  async health(): Promise<{ status: string; products: number; active_quotes: number }> {
    return this.request("GET", "/health");
  }

  /** Full agentic flow: search → quote → prepare → complete */
  async agentBuy(opts: {
    query: string;
    maxCents: number;
    policyId?: PolicyId;
    approvalReceipt: ApprovalReceipt;
    paymentToken: PaymentToken;
  }): Promise<{ product: string; order: Order }> {
    // 1. Search
    const { results } = await this.searchProducts({ q: opts.query, max_total_cents: opts.maxCents });
    if (!results.length) throw new Error("No products found matching query");
    const best = results[0];

    // 2. Quote
    const quote = await this.createQuote({
      items: [{ sku: best.sku, qty: 1 }],
      constraints: { max_total_cents: opts.maxCents },
    });

    // 3. Prepare checkout
    const session = await this.prepareCheckout({
      quote_id: quote.quote_id,
      cart_hash: quote.cart_hash,
      user_policy_id: opts.policyId,
    });

    // 4. Complete
    const order = await this.completeCheckout({
      checkout_session_id: session.checkout_session_id,
      approval_receipt: opts.approvalReceipt,
      payment_token: opts.paymentToken,
    });

    return { product: best.name, order };
  }
}

export default ClawCartClient;
