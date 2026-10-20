# BudgetRail — Owner Flow Example (Next.js)

This example shows how to build an **owner wallet A** flow using the BudgetRail SDK
in a Next.js app. The owner creates sessions, deposits USDC, and closes sessions to reclaim funds.

> The agent wallet B is separate. Never use the owner's private key for payments.

## Prerequisites

- Node.js 18+ or Bun
- A wallet with Arc Testnet USDC (use Arc Studio sidebar → "Get test USDC")
- Provider addresses from a running BudgetRail provider server

## Install

```bash
npm install viem @budgetrail/sdk
```

## Configure

```ts
// lib/budgetrail.ts
import type { BudgetRailConfig } from "@budgetrail/sdk";

export const config: BudgetRailConfig = {
  contractAddress: "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
  chainId:         5042002,
  rpcUrl:          "https://rpc.testnet.arc.io",
  providerApiUrl:  "http://localhost:3001",        // Your provider server
  providerPayout:  "0x<provider payout address C>",
  quoteSigner:     "0x<quote signer address D>",
};
```

## Read owner sessions (server component)

```ts
// app/dashboard/page.tsx
import { listOwnerSessions } from "@budgetrail/sdk";
import { config } from "@/lib/budgetrail";

export default async function DashboardPage() {
  const ownerAddress = "0x7D76349B..."; // from session/wallet
  const sessions = await listOwnerSessions(config, ownerAddress as `0x${string}`);

  return (
    <ul>
      {sessions.map((s) => (
        <li key={s.id.toString()}>
          Session #{s.id.toString()} — available: {(Number(s.availableBalance) / 1e6).toFixed(2)} USDC
          {s.closed && " (closed)"}
        </li>
      ))}
    </ul>
  );
}
```

## Fund a session (client component with wagmi)

```ts
// components/FundSession.tsx
"use client";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { BUDGET_RAIL_ABI, ERC20_ABI, USDC_ADDRESS } from "@budgetrail/sdk";

const CONTRACT = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21";

export function FundSession({ sessionId, amount }: { sessionId: bigint; amount: bigint }) {
  const { writeContract, data: approveTx } = useWriteContract();

  // Step 1: Approve USDC
  const handleApprove = () => writeContract({
    address:      USDC_ADDRESS,
    abi:          ERC20_ABI,
    functionName: "approve",
    args:         [CONTRACT, amount],
  });

  // Step 2: Fund session (after approve confirms)
  const handleFund = () => writeContract({
    address:      CONTRACT,
    abi:          BUDGET_RAIL_ABI,
    functionName: "fundSession",
    args:         [sessionId, amount],
  });

  return (
    <div>
      <button onClick={handleApprove}>1. Approve USDC</button>
      <button onClick={handleFund}>2. Fund Session</button>
    </div>
  );
}
```

## Close and refund (client component)

```ts
// components/CloseSession.tsx
"use client";
import { useWriteContract } from "wagmi";
import { BUDGET_RAIL_ABI } from "@budgetrail/sdk";

export function CloseSession({ sessionId }: { sessionId: bigint }) {
  const { writeContract } = useWriteContract();

  const handleClose = () => writeContract({
    address:      "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
    abi:          BUDGET_RAIL_ABI,
    functionName: "closeSession",
    args:         [sessionId],
  });

  return <button onClick={handleClose}>Close & Refund</button>;
}
```

## Role summary

| Role | Address | Responsibilities |
|------|---------|-----------------|
| Owner A | Your wallet | Create, fund, close sessions |
| Agent B | Separate wallet | Execute payForRequest only |
| Provider C | Provider's wallet | Receive USDC payments |
| Signer D | Provider's hot key | Sign EIP-712 quotes |

Owner A and Agent B should be different addresses in production.
For testing, the same address can serve both roles (session.owner == session.agent).

## Testnet faucet

```
Arc Studio sidebar → "Get test USDC" → Connect wallet → Drip testnet USDC
```

## Explorer

```
https://explorer.testnet.arc.io/address/0xf6a13df15ad93c2e2968e1d69c53894a923bda21
```
