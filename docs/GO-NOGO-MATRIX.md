# BudgetRail — GO / NO-GO Decision Matrix

> Use this matrix immediately before any of these actions:
> (A) V2 testnet deploy, (B) V2 mainnet deploy, (C) public GitHub push, (D) grant submission.
>
> Every row in the relevant column must be GO before proceeding.
> A single NO-GO blocks the entire action. Do not override NO-GO items.

---

## How to read this table

- **GO** = condition is met; confirmed with evidence.
- **NO-GO** = condition is NOT met; action is blocked.
- **N/A** = not applicable to this action.
- Current status reflects the state at end of Part 11 (October 26, 2026).

---

## Matrix

| # | Gate | Current Status | Testnet Deploy | Mainnet Deploy | Public GitHub | Grant Submission |
|---|------|---------------|:--------------:|:--------------:|:-------------:|:----------------:|
| G-01 | V1 testnet lifecycle complete (real tx hashes) | **NO-GO** (all null in evidence/testnet.json) | N/A | Required | N/A | Required |
| G-02 | V2 testnet lifecycle complete (real tx hashes) | **NO-GO** (V2 not deployed) | After deploy | Required | N/A | Required |
| G-03 | `QUOTE_SIGNER_PRIVATE_KEY` rotated (P0-A) | **NO-GO** (operator action pending) | Required | Required | Required | Required |
| G-04 | Git remote URL credential token clean | **GO** (clean URL confirmed Part 01) | Required | Required | Required | Required |
| G-05 | Independent security review complete | **NO-GO** (not yet performed) | N/A | Required | Recommended | Required |
| G-06 | Treasury E ≠ Provider C (separate addresses) | **NO-GO** (currently C=E on testnet; mainnet decision pending) | Operator decision | Required | N/A | Required |
| G-07 | Treasury E ownership proof recorded | **NO-GO** | N/A | Required | N/A | Required |
| G-08 | Provider C ownership proof recorded | **NO-GO** | N/A | Required | N/A | Required |
| G-09 | V2 preflight check passes | **NO-GO** (V2 not deployed) | Required | Required | N/A | Required |
| G-10 | Foundry tests 119/119 | **GO** (verified Part 11) | Required | Required | Required | Required |
| G-11 | Provider tests ~150/150 | **GO** (verified Part 11) | Required | Required | Required | Required |
| G-12 | SDK tests 66/66 | **GO** (verified Part 10) | Required | Required | Required | Required |
| G-13 | Frontend: 0 lint/typecheck errors | **GO** (verified Part 11) | Required | Required | Required | Required |
| G-14 | No secrets in git history | **GO** (verified Part 09 — `git log --all` found no .env commits) | Required | Required | Required | Required |
| G-15 | `.env` files gitignored | **GO** | Required | Required | Required | Required |
| G-16 | Public HTTPS provider URL live (`/api/health`) | **PARTIAL** — URL exists; Vercel env vars M-02 still needed | N/A | Required | N/A | Required |
| G-17 | `ALLOWED_ORIGIN` set to production frontend URL | **PARTIAL** — set in provider/.env; Vercel env var M-02 pending | N/A | Required | N/A | Required |
| G-18 | Public frontend URL live | **GO** — `https://arc-budgetrail.vercel.app` | N/A | Required | N/A | Required |
| G-19 | VersionBanner shows correct chain+version+address | **NO-GO** (V2 address zero; V1 banner correct) | After deploy | Required | N/A | Required |
| G-20 | FeeBreakdown shown before every V2 payment | **GO** (component built and tested) | Required | Required | Required | Required |
| G-21 | No x402 compatibility claimed | **GO** | Required | Required | Required | Required |
| G-22 | Explorer bytecode verified after deploy | N/A | After deploy | Required | N/A | Required |
| G-23 | Arc Mainnet contract deployed | **NO-GO** | N/A | This action | N/A | Required |
| G-24 | Mainnet lifecycle tx hashes in evidence/mainnet.json | **NO-GO** | N/A | After deploy | N/A | Required |
| G-25 | Screen recording (2-3 min) complete | **NO-GO** | N/A | N/A | N/A | Required |
| G-26 | Public GitHub URL recorded | **NO-GO** (pending G-03) | N/A | N/A | This action | Required |
| G-27 | Arc Studio project URL recorded | **NO-GO** (operator must copy from Arc Studio project share) | N/A | N/A | N/A | Required |
| G-28 | Builder profile on grant platform complete | **NO-GO** | N/A | N/A | N/A | Required |
| G-29 | Submission before November 1, 2026 deadline | **IN WINDOW** (Oct 26 — 6 days remaining) | N/A | N/A | N/A | Required |
| G-30 | No fabricated evidence in any submitted file | **GO** | Required | Required | Required | Required |
| G-31 | Source SHA-256 hashes recorded | **GO** (recorded in docs/GO-NOGO-MATRIX.md and evidence/mainnet.json) | Required | Required | Required | Required |
| G-32 | ABI selectors recorded and match source | **GO** (forge inspect verified Part 11) | Required | Required | Required | Required |
| G-33 | `readSession`/`readSessionV2` return 503 on RPC failure | **GO** (fixed Part 09) | Required | Required | Required | Required |
| G-34 | `eth_sendRawTransaction` blocked in RPC proxy | **GO** (fixed Part 06) | Required | Required | Required | Required |
| G-35 | NetworkGuard uses profile chainId not hardcoded testnet | **GO** (fixed Part 07) | Required | Required | Required | Required |
| G-36 | Arc Mainnet included in wagmi transport config | **GO** (fixed Part 08) | Required | Required | Required | Required |
| G-37 | C=E mainnet guard in loadConfig() throws on startup | **GO** (added Part 05) | Required | Required | Required | Required |

---

## Source artifact hashes (verified Part 11, forge build)

These hashes identify the EXACT source committed to git. Verify before deploying.

| File | SHA-256 |
|------|---------|
| `contracts/BudgetRail.sol` | `be9ff6499e19fe240d69f47689a7acdd8dfafbfc34e1d85ab4bf6a91b056305a` |
| `contracts/BudgetRailV2.sol` | `94f4e3cf9ae37d5801a3633db6557dd840ce9a017502897ec22f05bfa760c879` |

Verify before deploy:
```bash
sha256sum contracts/BudgetRail.sol contracts/BudgetRailV2.sol
```

---

## ABI selectors (verified Part 11, forge inspect)

**V1 BudgetRail:**

| Function | Selector |
|----------|----------|
| `createSession(address,address,address,uint96,uint96,uint64)` | `78356880` |
| `fundSession(uint256,uint96)` | `a6f44bc7` |
| `payForRequest(uint256,bytes32,bytes32,uint96,uint64,bytes)` | `62f7482a` |
| `closeSession(uint256)` | `a3bfdf47` |
| `getSession(uint256)` | `402ff0db` |
| `availableBalance(uint256)` | `399570a3` |
| `USDC_ADDRESS()` | `bb09d9b7` |

**V2 BudgetRailV2:**

| Function | Selector |
|----------|----------|
| `createSession(address,address,address,uint256,uint256,uint64)` | `9a2be1f6` |
| `fundSession(uint256,uint256)` | `31498f93` |
| `payForRequestV2(uint256,uint256,uint256,bytes32,bytes32,uint64,bytes)` | `0814315c` |
| `closeSession(uint256)` | `a3bfdf47` |
| `getSession(uint256)` | `402ff0db` |
| `FEE_BPS()` | `bf333f2c` |
| `FEE_DENOMINATOR()` | `d73792a9` |
| `TREASURY()` | `2d2c5565` |
| `VERSION()` | `ffa1ad74` |
| `computeFee(uint256)` | `e1bf9c08` |
| `isRequestUsed(uint256,bytes32)` | `a813f43c` |

Note: `createSession` and `fundSession` selectors DIFFER between V1 and V2 (uint96 vs uint256 arg types). Never call V2 functions against V1 address.

---

## Current status summary

### V2 Testnet Deploy
- **Blocking:** G-03, G-06 (operator decisions), G-09 (depends on G-06)
- **Ready:** G-10 through G-16, G-20, G-21, G-30 through G-37
- **Verdict: NO-GO** — 3 operator decisions required

### V2 Mainnet Deploy
- **Blocking:** G-01, G-02, G-03, G-05, G-06, G-07, G-08, G-09, G-17(partial), G-22, G-23
- **Cleared since last matrix:** G-04, G-33, G-34, G-35, G-36, G-37
- **Verdict: NO-GO** — 11 gates open; independent security review not yet performed

### Public GitHub Release
- **Blocking:** G-03 (must rotate key before any public push)
- **Verdict: NO-GO** — 1 operator action required

### Grant Submission (Deadline: Nov 1, 2026 — 6 days remaining)
- **Blocking:** All of the above, plus G-24, G-25, G-26, G-27, G-28
- **Verdict: NO-GO** — mainnet deployment and lifecycle not yet executed
- **WARNING:** November 1 deadline is 6 days away. Critical path is extremely tight.

---

## Critical path to grant submission (minimum viable sequence)

```
TODAY (Oct 26):
  G-03  Rotate QUOTE_SIGNER_PRIVATE_KEY (operator, 30 min)
  G-06  Decide C=E or separate E address (operator decision, 15 min)

Oct 27:
  H-01  Deploy V2 to Arc Testnet (requires G-03, G-06)
  P0-C  Execute V1 testnet lifecycle — record 4 real tx hashes in evidence/testnet.json

Oct 28:
  H-03  Execute V2 testnet lifecycle — record 8 real tx hashes
  M-02  Add all Vercel env vars + redeploy

Oct 29:
  G-05  Independent security review of BudgetRailV2.sol (external reviewer — schedule NOW)

Oct 30 (if G-05 complete):
  G-23  Deploy V2 to Arc Mainnet (Gate 4 in MAINNET-DEPLOY-RUNBOOK.md)
  G-24  Execute mainnet lifecycle — 6 steps, record all tx hashes

Oct 31:
  G-25  Record 2-3 min demo video (see docs/VIDEO-STORYBOARD.md)
  G-26  Push sanitized repo to public GitHub (after G-03)
  G-27  Copy Arc Studio project URL to evidence/mainnet.json
  G-28  Complete grant platform builder profile

Nov 1 (deadline):
  Submit before 00:00 UTC
```

---

## V1 Fallback — if V2 cannot be safely completed before deadline

Today is October 26. If G-05 (independent security review) cannot be scheduled before October 29,
the V1 fallback is strongly recommended:

- V1 is already deployed at `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` on Arc Testnet
- V1 has no immutable treasury, no C=E risk, simpler constructor (1 arg)
- V1 passes 60+ Foundry tests, all provider V1 paths tested end-to-end
- V1 mainnet constructor: `usdcAddress = 0x3600000000000000000000000000000000000000` only

**V1-only critical path (simpler, lower risk):**
```
Oct 26:  G-03 Rotate key
Oct 27:  P0-C Execute V1 testnet lifecycle (4 real tx hashes)
Oct 28:  Deploy V1 to Arc Mainnet; execute mainnet lifecycle
Oct 29:  Record evidence; record demo video
Oct 30:  Public GitHub push; grant profile
Oct 31:  Submit
```

**Recommendation:** If you cannot confirm an independent security reviewer for V2 by October 28,
choose V1 for mainnet submission. V2 remains your product roadmap but does NOT need to be
the grant submission vehicle.

---

## What the grant program requires (confirmed from project documentation)

The following are recorded from prior documentation in this project. The live grant program page
must be independently verified — the web search was rate-limited and cannot be completed here.

| Requirement | Source | Status |
|-------------|--------|--------|
| Real Arc USDC movement on Arc Mainnet | docs/GRANT-EVIDENCE.md | NO-GO (not yet executed) |
| Arc Studio provenance (project URL) | docs/GRANT-EVIDENCE.md | PARTIAL (URL needed) |
| Working public application | docs/GRANT-EVIDENCE.md | GO (https://arc-budgetrail.vercel.app) |
| Public GitHub repository | docs/GRANT-EVIDENCE.md | NO-GO (pending G-03) |
| Screen recording | docs/GRANT-EVIDENCE.md | NO-GO |
| Builder profile | docs/GRANT-EVIDENCE.md | NO-GO |
| Deadline | docs/GRANT-EVIDENCE.md | November 1, 2026 |

**IMPORTANT:** Independently verify the current grant program URL, exact criteria, and deadline
before submission. Do not rely solely on prior documentation. The official source is
https://studio.arc.io or the grant program announcement channel. Arc Studio cannot confirm
live grant program rules.
