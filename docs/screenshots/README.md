# Screenshots — Capture Guide

This directory holds annotated screenshots for grant evidence, README, and docs.

## Required Screenshots (for grant submission)

Capture these after completing the V1 testnet lifecycle (P0-C in PENDING.md):

### 1. `dashboard.png`
- **What:** Dashboard page showing a live session with remaining balance
- **Highlight:** Session ID, expiry, available USDC, provider payout address
- **When:** After creating and funding a session

### 2. `create-budget.png`
- **What:** New Budget page with all fields filled
- **Highlight:** Spending summary (max budget, per-call cap, up to N calls), V2 fee notice if applicable
- **When:** Before clicking "Create session"

### 3. `playground-quote.png`
- **What:** Playground after a quote is received
- **Highlight:** Base amount ($0.05), fee (V2: $0.00025), gross total ($0.05025), signer D address
- **When:** After Step 1 completes (Quote issued by provider)

### 4. `playground-success.png`
- **What:** Playground after a successful payment + fulfillment
- **Highlight:** All 4 steps complete, Document Insights result visible
- **When:** After Step 4 completes (Provider verifies + delivers result)

### 5. `history-dual-transfer.png`
- **What:** Payment History page showing the PaymentSettled event
- **Highlight:** V2: base/fee columns; V1: gross amount; covered block range
- **When:** After at least one successful payment

### 6. `explorer-dual-transfer.png`
- **What:** Arc Testnet explorer showing the PaymentSettled transaction
- **Highlight:** Two USDC Transfer logs — C +$0.05, E +$0.00025 (V2) or one transfer (V1)
- **URL:** https://explorer.testnet.arc.io/tx/<your-tx-hash>
- **When:** After a V2 payment

### 7. `manage-session-refund.png`
- **What:** Manage Session page showing the close/refund math
- **Highlight:** Unspent balance, refund amount, "fee not reversed" note (V2)
- **When:** After clicking Close Session

### 8. `version-banner.png`
- **What:** Any page showing the VersionBanner component
- **Highlight:** Chain, contract version badge, deploy block, treasury address (V2)
- **When:** Any time after V2 is deployed

---

## Naming Convention

```
<page>-<state>.png     e.g. playground-quote.png, dashboard-funded.png
```

## Recording Guide (for demo video)

See `docs/DEMO-SCRIPT-FINAL.md` for the full 2:30 script.
Record at 1920x1080, 30fps. Use Arc Studio preview for the build evidence scene.
Export as MP4 H.264 for YouTube/Loom upload.
