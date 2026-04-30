# ClawCart Protocol Specification

See README.md section 3 (Architecture) and the REST API section for the full protocol spec.

## Manifest

Merchants expose `/.well-known/agentic-commerce.json` with capabilities, endpoints, and policies.

## Flow

```
search → quote → policy check → checkout prepare → approval → payment handoff → order
```
