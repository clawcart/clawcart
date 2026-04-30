// @clawcart/policy-engine — Evaluates user-defined purchasing policies against quotes

import type {
  UserPolicy, Quote, Product, PolicyValidationResult, PolicyViolation, PolicyId,
} from "@clawcart/protocol";

export class PolicyEngine {
  private policies = new Map<string, UserPolicy>();

  /** Register a policy for evaluation */
  register(policy: UserPolicy): void {
    this.policies.set(policy.id, policy);
  }

  /** Load multiple policies */
  loadAll(policies: UserPolicy[]): void {
    for (const p of policies) this.register(p);
  }

  /** Get a registered policy */
  get(id: PolicyId): UserPolicy | undefined {
    return this.policies.get(id);
  }

  /** List all registered policies */
  list(): UserPolicy[] {
    return Array.from(this.policies.values());
  }

  /** Validate a quote against a user policy */
  validateQuote(quote: Quote, policyId: PolicyId): PolicyValidationResult {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return {
        valid: false,
        violations: [{
          code: "policy_not_found",
          message: `Policy ${policyId} not found`,
          field: "policy_id",
        }],
      };
    }

    const violations: PolicyViolation[] = [];

    // Price limit check
    if (policy.max_total_cents && quote.totals.total_cents > policy.max_total_cents) {
      violations.push({
        code: "price_exceeds_limit",
        message: `Total ${quote.totals.total_cents} exceeds max ${policy.max_total_cents}`,
        field: "total_cents",
        limit: policy.max_total_cents,
        actual: quote.totals.total_cents,
      });
    }

    // Currency mismatch
    if (policy.currency && quote.totals.currency !== policy.currency) {
      violations.push({
        code: "currency_mismatch",
        message: `Expected ${policy.currency}, got ${quote.totals.currency}`,
        field: "currency",
      });
    }

    // Delivery time check
    if (policy.delivery_days_max && quote.delivery.estimated_days > policy.delivery_days_max) {
      violations.push({
        code: "delivery_too_slow",
        message: `Delivery ${quote.delivery.estimated_days}d exceeds max ${policy.delivery_days_max}d`,
        field: "delivery_days",
        limit: policy.delivery_days_max,
        actual: quote.delivery.estimated_days,
      });
    }

    // Free returns check
    if (policy.free_returns_required && !quote.policy.free_returns) {
      violations.push({
        code: "free_returns_required",
        message: "Policy requires free returns but merchant does not offer them",
        field: "free_returns",
      });
    }

    // Subscription check
    if (!policy.subscriptions_allowed && quote.policy.subscription) {
      violations.push({
        code: "subscription_not_allowed",
        message: "Policy does not allow subscriptions",
        field: "subscription",
      });
    }

    return { valid: violations.length === 0, violations };
  }

  /** Validate a product against a user policy (pre-quote filter) */
  validateProduct(product: Product, policyId: PolicyId): PolicyValidationResult {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return {
        valid: false,
        violations: [{
          code: "policy_not_found",
          message: `Policy ${policyId} not found`,
          field: "policy_id",
        }],
      };
    }

    const violations: PolicyViolation[] = [];

    // Price check
    if (policy.max_total_cents && product.price_cents > policy.max_total_cents) {
      violations.push({
        code: "price_exceeds_limit",
        message: `Price ${product.price_cents} exceeds max ${policy.max_total_cents}`,
        field: "price_cents",
        limit: policy.max_total_cents,
        actual: product.price_cents,
      });
    }

    // Blocked categories
    if (policy.blocked_categories?.length) {
      const blocked = product.categories.filter(c => policy.blocked_categories!.includes(c));
      if (blocked.length) {
        violations.push({
          code: "blocked_category",
          message: `Product in blocked categories: ${blocked.join(", ")}`,
          field: "categories",
        });
      }
    }

    // Condition check
    if (policy.allowed_conditions?.length && product.condition) {
      if (!policy.allowed_conditions.includes(product.condition)) {
        violations.push({
          code: "condition_not_allowed",
          message: `Condition "${product.condition}" not in allowed: ${policy.allowed_conditions.join(", ")}`,
          field: "condition",
        });
      }
    }

    // Blocked merchants
    if (policy.blocked_merchants?.length) {
      if (policy.blocked_merchants.includes(product.merchant_id)) {
        violations.push({
          code: "merchant_blocked",
          message: `Merchant ${product.merchant_id} is blocked`,
          field: "merchant_id",
        });
      }
    }

    // Free returns
    if (policy.free_returns_required && !product.free_returns) {
      violations.push({
        code: "free_returns_required",
        message: "Policy requires free returns",
        field: "free_returns",
      });
    }

    // Warranty
    if (policy.warranty_required && !product.warranty) {
      violations.push({
        code: "warranty_required",
        message: "Policy requires warranty",
        field: "warranty",
      });
    }

    // Delivery estimate
    if (policy.delivery_days_max && product.delivery_days_estimate) {
      if (product.delivery_days_estimate > policy.delivery_days_max) {
        violations.push({
          code: "delivery_too_slow",
          message: `Estimated ${product.delivery_days_estimate}d exceeds max ${policy.delivery_days_max}d`,
          field: "delivery_days_estimate",
          limit: policy.delivery_days_max,
          actual: product.delivery_days_estimate,
        });
      }
    }

    return { valid: violations.length === 0, violations };
  }

  /** Check if approval is required for a given amount */
  requiresApproval(policyId: PolicyId, totalCents: number): boolean {
    const policy = this.policies.get(policyId);
    if (!policy) return true; // default: require approval
    if (policy.approval_required) return true;
    if (policy.approval_required_above_cents !== undefined) {
      return totalCents > policy.approval_required_above_cents;
    }
    return true; // safe default
  }
}

export { PolicyEngine as default };
