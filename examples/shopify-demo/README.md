# Shopify Demo

Example Shopify store with ClawCart enabled.

```bash
clawcart init --platform shopify --name "Demo Store"
clawcart scan https://demo-store.myshopify.com --fix-schema
clawcart protocol publish
clawcart dev --mcp --port 7733
```
