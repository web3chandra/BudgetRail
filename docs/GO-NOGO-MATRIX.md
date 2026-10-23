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
- Current status reflects the state at end of Part 12 (October 22, 2026).

---

## Matrix

| # | Gate | Current Status | Testnet Deploy | Mainnet Deploy | Public GitHub | Grant Submission |
|---|------|---------------|:--------------:|:--------------:|:-------------:|:----------------:|
| G-01 | V1 testnet lifecycle complete (real tx hashes) | **NO-GO** (all null) | N/A | Required | N/A | Required |
| G-02 | V2 testnet lifecycle complete (real tx hashes) | **NO-GO** (V2 not deployed) | After deploy | Required | N/A | Required |
| G-03 | `QUOTE_SIGNER_PRIVATE_KEY` rotated (P0-A) | **NO-GO** (possible exposure) | Required | Required | Required | Required |
| G-04 | Git remote URL credential token revoked (P0-B) | **NO-GO** (token in .git/config) | Required | Required | Required | Required |
| G-05 | Independent security review complete | **NO-GO** | N/A | Required | Recommended | Required |
| G-06 | Treasury E ≠ Provider C (separate addresses) | **NO-GO** (currently C=E) | Operator decision | Required | N/A | Required |
| G-07 | Treasury E ownership proof recorded | **NO-GO** | N/A | Required | N/A | Required |
| G-08 | Provider C ownership proof recorded | **NO-GO** | N/A | Required | N/A | Required |
| G-09 | V2 preflight check passes (`bun run v2:preflight`) | **NO-GO** (V2 not deployed) | Required | Required | N/A | Required |
| G-10 | Foundry tests 60/60 | **GO** | Required | Required | Required | Required |
| G-11 | Provider tests 108/108 | **GO** | Required | Required | Required | Required |
| G-12 | SDK tests 66/66 | **GO** | Required | Required | Required | Required |
| G-13 | Frontend: 0 lint/typecheck errors | **GO** | Required | Required | Required | Required |
| G-14 | No secrets in git history | **GO** (verified Part 10) | Required | Required | Required | Required |
| G-15 | `.env` files gitignored | **GO** | Required | Required | Required | Required |
| G-16 | Public HTTPS provider URL live (`/api/health`) | **GO** — `https://arc-budgetrail.vercel.app/api/health` (needs Vercel env vars — see M-02) | N/A | Required | N/A | Required |
| G-17 | `ALLOWED_ORIGIN` set to production frontend URL | **PARTIAL** — set in Vercel env vars needed (see M-02) | N/A | Required | N/A | Required |
| G-18 | Public frontend URL live | **GO** — `https://arc-budgetrail.vercel.app` | N/A | Required | N/A | Required |
| G-19 | VersionBanner shows correct chain+version+address | **NO-GO** (V2 address zero) | After deploy | Required | N/A | Required |
| G-20 | FeeBreakdown shown before every V2 payment | **GO** (component built) | Required | Required | Required | Required |
| G-21 | No x402 compatibility claimed | **GO** | Required | Required | Required | Required |
| G-22 | Explorer bytecode verified after deploy | N/A | After deploy | Required | N/A | Required |
| G-23 | Arc Mainnet contract deployed | **NO-GO** | N/A | This action | N/A | Required |
| G-24 | Mainnet lifecycle tx hashes in evidence/mainnet.json | **NO-GO** | N/A | After deploy | N/A | Required |
| G-25 | Screen recording (2-3 min) complete | **NO-GO** | N/A | N/A | N/A | Required |
| G-26 | Public GitHub URL recorded | **NO-GO** | N/A | N/A | This action | Required |
| G-27 | Arc Studio project URL recorded | **NO-GO** | N/A | N/A | N/A | Required |
| G-28 | Builder profile on grant platform complete | **NO-GO** | N/A | N/A | N/A | Required |
| G-29 | Submission before November 1, 2026 deadline | **IN WINDOW** (Oct 22) | N/A | N/A | N/A | Required |
| G-30 | No fabricated evidence in any submitted file | **GO** | Required | Required | Required | Required |

---

## Current status summary

### V2 Testnet Deploy
- **Blocking:** G-03, G-04, G-06 (operator decisions), G-09 (depends on G-06)
- **Ready:** G-10, G-11, G-12, G-13, G-14, G-15, G-20, G-21, G-30
- **Verdict: NO-GO** — 3 operator decisions required before deployment

### V2 Mainnet Deploy
- **Blocking:** G-01, G-02, G-03, G-04, G-05, G-06, G-07, G-08, G-09, G-17 (partial), G-22, G-23
- **Newly cleared:** G-16 (provider URL live), G-18 (frontend URL live)
- **Verdict: NO-GO** — 12 gates open; independent security review not yet performed

### Public GitHub Release
- **Blocking:** G-03, G-04 (must be done before any public push)
- **Verdict: NO-GO** — 2 operator actions required (rotate key, fix git remote)

### Grant Submission (Deadline: Nov 1, 2026)
- **Blocking:** All of the above, plus G-24, G-25, G-26, G-27, G-28
- **Time remaining:** ~10 days from October 22, 2026
- **Verdict: NO-GO** — mainnet deployment and lifecycle not yet executed

---

## Critical path to grant submission (minimum viable sequence)

```
Day 1:  G-03 Rotate QUOTE_SIGNER_PRIVATE_KEY (operator, 30 min)
        G-04 Fix git remote URL + revoke token (operator, 5 min)
        G-06 Decide C=E or separate E address (operator decision)

Day 2:  H-01 Deploy V2 to Arc Testnet (requires G-03, G-04, G-06)
        P0-C Execute V1 testnet lifecycle — 6 steps with real tx hashes

Day 3:  H-03 Execute V2 testnet lifecycle — 8 steps with real tx hashes
        M-02 Deploy provider to public HTTPS
        M-03 Deploy frontend to public URL

Day 4:  G-05 Independent security review (external reviewer — schedule in advance)

Day 5:  G-23 Deploy V2 to Arc Mainnet (requires G-05 complete)
        Gate 6 Execute mainnet lifecycle — 6 steps

Day 6:  G-25 Record 2-3 min demo video (DEMO-SCRIPT-FINAL.md)
        G-26 Push sanitized repo to public GitHub
        G-27+G-28 Complete grant platform profile

Day 7+: Submit before November 1, 2026
```

**If the independent security review (G-05) cannot be completed before October 29:**
- V1 fallback: submit V1 only (already deployed, no V2 fee complexity).
- V1 mainnet deploy is simpler (2-arg constructor, no C=E decision).
- V1 still requires P0-C (testnet lifecycle), P0-A+B, public URLs, and mainnet lifecycle.
- See "V1 Fallback" section below.

---

## V1 Fallback — if V2 cannot be safely completed before deadline

V1 (`BudgetRail.sol`, deployed at `0xf6a13df15ad93c2e2968e1d69c53894a923bda21` on testnet) is:
- Already deployed on Arc Testnet with verified USDC constructor arg
- No platform fee (simpler, less security surface)
- No C=E risk (no treasury in constructor)
- Passes 60/60 Foundry tests (V1 subset)
- All frontend, SDK, and provider V1 paths tested

**V1 fallback pre-approval gates (subset):**
- G-03, G-04 — still required (key rotation, git remote)
- G-01 — still required (V1 testnet lifecycle with real tx hashes)
- G-05 — strongly recommended; V1 is simpler but still custodiies USDC
- G-10 to G-15 — all already GO
- G-16 to G-18 — still required (public URLs)
- G-23 to G-28 — V1 mainnet deploy + lifecycle + recording + submission

**V1 mainnet constructor args:**
```
Arg 0 — usdcAddress: 0x3600000000000000000000000000000000000000
(no treasury arg — V1 has no platform fee)
```

**Recommendation:** If you cannot complete an independent security review of V2 before October 28, deploy V1 to mainnet instead. V1 is already battle-tested in this project, has no immutable-address risk, and satisfies all four grant criteria. Flag V2 as "in development" and ship V1.
