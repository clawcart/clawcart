// @clawcart/protocol — Type definitions for the ClawCart agentic commerce protocol

// ── IDs ────────────────────────────────────
export type MerchantId = `mrc_${string}`;
export type QuoteId = `qt_${string}`;
export type CheckoutSessionId = `chk_${string}`;
export type OrderId = `ord_${string}`;
export type ApprovalReceipt = `apr_${string}`;
export type PolicyId = `pol_${string}`;
export type PaymentToken = `pmtok_${string}`;

// ── Product ────────────────────────────────
export interface Product {
  sku: string;
  name: string;
  description?: string;
  price_cents: number;
  currency: string;
  stock_status: "in_stock" | "low_stock" | "out_of_stock" | "preorder";
  categories: string[];
  condition?: "new" | "used" | "refurbished" | "open_box";
  merchant_id: MerchantId;
  merchant_name: string;
  merchant_trust_score: number;
  free_returns: boolean;
  return_window_days?: number;
  warranty?: string;
  delivery_days_estimate?: number;
  image_url?: string;
  url?: string;
  agent_checkout_supported: boolean;
}

export interface ProductSearchRequest {
  q: string;
  max_total_cents?: number;
  currency?: string;
  delivery_days_max?: number;
  free_returns?: boolean;
  blocked_categories?: string[];
  condition?: string[];
  limit?: number;
  offset?: number;
}

export interface ProductSearchResponse {
  results: Product[];
  total: number;
  offset: number;
  limit: number;
}

// ── Quote ──────────────────────────────────
export interface QuoteItem {
  sku: string;
  qty: number;
}

export interface QuoteConstraints {
  max_total_cents?: number;
  currency?: string;
  delivery_days_max?: number;
  free_returns?: boolean;
  blocked_categories?: string[];
}

export interface QuoteRequest {
  items: QuoteItem[];
  constraints?: QuoteConstraints;
}

export interface QuoteTotals {
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface Quote {
  quote_id: QuoteId;
  merchant_id: MerchantId;
  expires_at: string;
  cart_hash: string;
  items: Array<QuoteItem & { name: string; price_cents: number }>;
  totals: QuoteTotals;
  delivery: { estimated_days: number; carrier?: string };
  policy: { free_returns: boolean; return_window_days: number; subscription: boolean };
  approval: { required: boolean; reason: string };
}

// ── Checkout ───────────────────────────────
export interface CheckoutPrepareRequest {
  quote_id: QuoteId;
  cart_hash: string;
  user_policy_id?: PolicyId;
}

export interface CheckoutSession {
  checkout_session_id: CheckoutSessionId;
  quote_id: QuoteId;
  merchant_id: MerchantId;
  requires_user_approval: boolean;
  approval_prompt: string;
  payment_requirements: {
    token_supported: boolean;
    max_authorized_cents: number;
    merchant_binding_required: boolean;
    expires_at: string;
  };
  status: "pending_approval" | "approved" | "completed" | "expired" | "cancelled";
  created_at: string;
}

export interface CheckoutCompleteRequest {
  checkout_session_id: CheckoutSessionId;
  approval_receipt: ApprovalReceipt;
  payment_token: PaymentToken;
}

export interface Order {
  order_id: OrderId;
  checkout_session_id: CheckoutSessionId;
  merchant_id: MerchantId;
  status: "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded";
  total_cents: number;
  currency: string;
  receipt_url: string;
  created_at: string;
}

// ── Policy ─────────────────────────────────
export interface UserPolicy {
  id: PolicyId;
  name: string;
  max_total_cents: number;
  currency: string;
  allowed_conditions?: string[];
  blocked_categories?: string[];
  blocked_merchants?: MerchantId[];
  allowed_merchants?: string[];
  free_returns_required?: boolean;
  warranty_required?: boolean;
  delivery_days_max?: number;
  approval_required?: boolean;
  approval_required_above_cents?: number;
  subscriptions_allowed?: boolean;
}

export interface PolicyViolation {
  code: string;
  message: string;
  field: string;
  limit?: number;
  actual?: number;
}

export interface PolicyValidationResult {
  valid: boolean;
  violations: PolicyViolation[];
}

// ── Manifest ───────────────────────────────
export interface AgenticCommerceManifest {
  protocol: "agentic-commerce";
  version: "0.1.0";
  merchant_id: MerchantId;
  merchant_name: string;
  endpoints: {
    product_search: string;
    quote_create: string;
    checkout_prepare: string;
    checkout_complete: string;
    payment_token_accept: string;
  };
  capabilities: {
    agent_checkout_supported: boolean;
    approval_gates: boolean;
    scoped_payment_tokens: boolean;
    free_returns_available: boolean;
    subscription_products: boolean;
  };
  trust: { score: number; verified: boolean; reviews_count: number };
}

// ── Webhooks ───────────────────────────────
export type WebhookEvent =
  | { type: "quote.created"; quote_id: QuoteId; merchant_id: MerchantId; total_cents: number; currency: string }
  | { type: "checkout.prepared"; checkout_session_id: CheckoutSessionId; requires_approval: boolean }
  | { type: "approval.received"; approval_receipt: ApprovalReceipt; checkout_session_id: CheckoutSessionId }
  | { type: "order.completed"; order_id: OrderId; checkout_session_id: CheckoutSessionId }
  | { type: "policy.blocked"; reason: string; max_total_cents: number; actual_total_cents: number };

// ── Audit Log ──────────────────────────────
export interface AuditEntry {
  timestamp: string;
  action: string;
  merchant_id: MerchantId;
  quote_id?: QuoteId;
  checkout_session_id?: CheckoutSessionId;
  order_id?: OrderId;
  cart_hash?: string;
  total_cents?: number;
  approval_receipt?: ApprovalReceipt;
  policy_id?: PolicyId;
  violations?: PolicyViolation[];
  metadata?: Record<string, unknown>;
}

// ── Errors ─────────────────────────────────
export class ClawCartError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ClawCartError";
  }
}

export const ErrorCodes = {
  QUOTE_EXPIRED: "quote_expired",
  QUOTE_NOT_FOUND: "quote_not_found",
  CART_HASH_MISMATCH: "cart_hash_mismatch",
  POLICY_VIOLATION: "policy_violation",
  CHECKOUT_NOT_FOUND: "checkout_not_found",
  CHECKOUT_EXPIRED: "checkout_expired",
  CHECKOUT_ALREADY_COMPLETED: "checkout_already_completed",
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_INVALID: "approval_invalid",
  PAYMENT_TOKEN_INVALID: "payment_token_invalid",
  PRODUCT_NOT_FOUND: "product_not_found",
  OUT_OF_STOCK: "out_of_stock",
  MERCHANT_NOT_FOUND: "merchant_not_found",
  UNAUTHORIZED: "unauthorized",
  RATE_LIMITED: "rate_limited",
} as const;
