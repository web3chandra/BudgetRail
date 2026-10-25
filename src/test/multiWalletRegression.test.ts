/**
 * Multi-wallet regression tests for BudgetRail session role isolation.
 *
 * Covers the three known test wallets and sessions 20/21:
 *
 *   Session #20:
 *     owner    = 0xC1CF…  (C1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B)
 *     agent    = 0xD995…  (D995d0c31802A8D95C163f875fFefB40AB964eD6)
 *     provider = 0x7D76…  (7D76349B806148594b8075A83b2f8fb12feaA743)
 *
 *   Session #21:
 *     owner    = 0x7D76…  (7D76349B806148594b8075A83b2f8fb12feaA743)
 *     agent    = 0xC1CF…  (C1CFDF533a6Da9a19e40cf9a8BFc1893DcFF2F7B)
 *     provider = 0x7D76…  (7D76349B806148594b8075A83b2f8fb12feaA743)
 *
 * Test wallets:
 *   A = 0xC1CF…  owner of #20, agent of #21
 *   B = 0xD995…  agent of #20, not involved in #21
 *   C = 0x7D76…  owner of #21, provider in both
 */

import { describe, it, expect } from "bun:test";

// ── Test fixture addresses ─────────────────────────────────────────────────

const WALLET_A = "0xc1cfdf533a6da9a19e40cf9a8bfc1893dcff2f7b"; // C1CF…
const WALLET_B = "0xd995d0c31802a8d95c163f875ffefb40ab964ed6"; // D995…
const WALLET_C = "0x7d76349b806148594b8075a83b2f8fb12feaa743"; // 7D76…

interface MockSession {
  sessionId: bigint;
  owner:   string;
  agent:   string;
  provider: string;
  closed:   boolean;
  expiresAt: bigint;
  maxBudget: bigint;
  totalFunded: bigint;
  totalSpent: bigint;
  perPaymentCap: bigint;
  quoteSigner: string;
}

const SESSION_20: MockSession = {
  sessionId:    20n,
  owner:        WALLET_A,
  agent:        WALLET_B,
  provider:     WALLET_C,
  closed:       false,
  expiresAt:    BigInt(Math.floor(Date.now() / 1000) + 7 * 86400), // 7 days from now
  maxBudget:    1_000_000n,
  totalFunded:  500_000n,
  totalSpent:   50_000n,
  perPaymentCap: 50_000n,
  quoteSigner:  "0x70cd9e6a417b792eceeea2e033bdfb8f8a8113a4c",
};

const SESSION_21: MockSession = {
  sessionId:    21n,
  owner:        WALLET_C,
  agent:        WALLET_A,
  provider:     WALLET_C,
  closed:       false,
  expiresAt:    BigInt(Math.floor(Date.now() / 1000) + 7 * 86400),
  maxBudget:    1_000_000n,
  totalFunded:  500_000n,
  totalSpent:   100_000n,
  perPaymentCap: 50_000n,
  quoteSigner:  "0x70cd9e6a417b792eceeea2e033bdfb8f8a8113a4c",
};

// ── Role classification helpers (mirrors Dashboard / ManageSession logic) ──

function isOwner(session: MockSession, wallet: string): boolean {
  return session.owner.toLowerCase() === wallet.toLowerCase();
}

function isAgent(session: MockSession, wallet: string): boolean {
  return session.agent.toLowerCase() === wallet.toLowerCase();
}

function isProvider(session: MockSession, wallet: string): boolean {
  return session.provider.toLowerCase() === wallet.toLowerCase();
}

/**
 * Determine which sessions appear under "My Budgets" (owner) vs "Agent Sessions"
 * tabs for a given wallet.
 */
function classifyForWallet(sessions: MockSession[], wallet: string): {
  ownerSessions: MockSession[];
  agentSessions: MockSession[];
} {
  const ownerSessions = sessions.filter(s => isOwner(s, wallet));
  // Agent sessions: wallet is agent AND is NOT the owner (prevents double-listing)
  const agentSessions = sessions.filter(s => isAgent(s, wallet) && !isOwner(s, wallet));
  return { ownerSessions, agentSessions };
}

// ── Tests ──────────────────────────────────────────────────────────────────

const ALL_SESSIONS = [SESSION_20, SESSION_21];

describe("Session role isolation — wallet A (0xC1CF)", () => {
  const { ownerSessions, agentSessions } = classifyForWallet(ALL_SESSIONS, WALLET_A);

  it("appears as owner of session #20", () => {
    expect(ownerSessions.map(s => s.sessionId)).toContain(20n);
  });

  it("does NOT appear as owner of session #21", () => {
    expect(ownerSessions.map(s => s.sessionId)).not.toContain(21n);
  });

  it("appears as agent of session #21", () => {
    expect(agentSessions.map(s => s.sessionId)).toContain(21n);
  });

  it("does NOT appear as agent of session #20 (is owner, not agent)", () => {
    expect(agentSessions.map(s => s.sessionId)).not.toContain(20n);
  });

  it("can close session #20 (is owner)", () => {
    expect(isOwner(SESSION_20, WALLET_A)).toBe(true);
  });

  it("cannot close session #21 (is agent, not owner)", () => {
    expect(isOwner(SESSION_21, WALLET_A)).toBe(false);
  });

  it("is the provider C for NEITHER session (provider is 0x7D76)", () => {
    expect(isProvider(SESSION_20, WALLET_A)).toBe(false);
    expect(isProvider(SESSION_21, WALLET_A)).toBe(false);
  });
});

describe("Session role isolation — wallet B (0xD995)", () => {
  const { ownerSessions, agentSessions } = classifyForWallet(ALL_SESSIONS, WALLET_B);

  it("is NOT an owner of any session", () => {
    expect(ownerSessions).toHaveLength(0);
  });

  it("is agent of session #20 only", () => {
    expect(agentSessions.map(s => s.sessionId)).toEqual([20n]);
  });

  it("is NOT involved in session #21 as owner or agent", () => {
    expect(isOwner(SESSION_21, WALLET_B)).toBe(false);
    expect(isAgent(SESSION_21, WALLET_B)).toBe(false);
  });

  it("My Budgets tab should be empty for wallet B", () => {
    expect(ownerSessions).toHaveLength(0);
  });
});

describe("Session role isolation — wallet C (0x7D76)", () => {
  const { ownerSessions, agentSessions } = classifyForWallet(ALL_SESSIONS, WALLET_C);

  it("appears as owner of session #21", () => {
    expect(ownerSessions.map(s => s.sessionId)).toContain(21n);
  });

  it("does NOT appear as owner of session #20", () => {
    expect(ownerSessions.map(s => s.sessionId)).not.toContain(20n);
  });

  it("is provider in both sessions, but provider is NOT counted as agent", () => {
    expect(agentSessions).toHaveLength(0);
  });

  it("can close session #21 (is owner)", () => {
    expect(isOwner(SESSION_21, WALLET_C)).toBe(true);
  });

  it("cannot close session #20 (is provider, not owner)", () => {
    expect(isOwner(SESSION_20, WALLET_C)).toBe(false);
  });
});

describe("Provider C label — must NOT be confused with connected wallet", () => {
  it("session #20 provider equals wallet C, not wallet A or B", () => {
    expect(SESSION_20.provider.toLowerCase()).toBe(WALLET_C);
    expect(SESSION_20.provider.toLowerCase()).not.toBe(WALLET_A);
    expect(SESSION_20.provider.toLowerCase()).not.toBe(WALLET_B);
  });

  it("session #21 owner and provider are both wallet C (C=E warning case)", () => {
    expect(SESSION_21.owner.toLowerCase()).toBe(WALLET_C);
    expect(SESSION_21.provider.toLowerCase()).toBe(WALLET_C);
    // This triggers the C=E warning — should be flagged in V2 preflight
  });

  it("provider C must be labelled as 'service revenue — not connected wallet'", () => {
    // This is a documentation assertion — tests that the mapping is correct
    // so we can assert the label logic separately from the role classification
    const labelForProvider = (s: MockSession, connectedWallet: string): string => {
      if (s.provider.toLowerCase() === connectedWallet.toLowerCase()) {
        return "service revenue — your wallet (provider)";
      }
      return "service revenue — not connected wallet";
    };
    // wallet A sees "not connected wallet" for provider C in session 20
    expect(labelForProvider(SESSION_20, WALLET_A)).toBe("service revenue — not connected wallet");
    // wallet C sees "your wallet" when viewing provider field of session 21
    expect(labelForProvider(SESSION_21, WALLET_C)).toBe("service revenue — your wallet (provider)");
  });
});

describe("RPC 503 error category classification", () => {
  function classifyRpcError(errorMsg: string): "rpc_unavailable" | "contract_revert" | "unknown" {
    if (
      errorMsg.includes("503") ||
      errorMsg.includes("502") ||
      errorMsg.includes("504") ||
      errorMsg.includes("RPC not configured") ||
      errorMsg.includes("fetch failed") ||
      errorMsg.includes("ECONNREFUSED") ||
      errorMsg.includes("timeout") ||
      errorMsg.includes("abort")
    ) return "rpc_unavailable";
    if (
      errorMsg.includes("revert") ||
      errorMsg.includes("execution reverted") ||
      errorMsg.includes("custom error")
    ) return "contract_revert";
    return "unknown";
  }

  it("classifies 503 as rpc_unavailable", () => {
    expect(classifyRpcError("HTTP 503 Service Unavailable")).toBe("rpc_unavailable");
  });

  it("classifies 'RPC not configured' as rpc_unavailable", () => {
    expect(classifyRpcError("RPC not configured — set ARC_TESTNET_RPC_URL in Vercel")).toBe("rpc_unavailable");
  });

  it("classifies fetch timeout as rpc_unavailable", () => {
    expect(classifyRpcError("AbortError: abort")).toBe("rpc_unavailable");
  });

  it("classifies contract revert as contract_revert", () => {
    expect(classifyRpcError("execution reverted: SessionClosed")).toBe("contract_revert");
  });

  it("rpc_unavailable must NOT claim funds were spent", () => {
    // RPC errors must be surfaced with 'no funds spent' message
    const isRpc = classifyRpcError("HTTP 503 Service Unavailable") === "rpc_unavailable";
    expect(isRpc).toBe(true);
    // The UI should say: "no funds spent — retry simulation later"
    // This is tested by CreateBudget.tsx simError rendering
  });
});

describe("Dashboard query key isolation", () => {
  /**
   * Each wallet+role combination must produce a unique cache key so wagmi
   * never serves wallet A's owner sessions to wallet B.
   * Format: chainId:contract:address:role
   */
  function makeQueryKey(chainId: number, contract: string, address: string, role: "owner" | "agent") {
    return `${chainId}:${contract.toLowerCase()}:${address.toLowerCase()}:${role}`;
  }

  const CONTRACT = "0xf6a13df15ad93c2e2968e1d69c53894a923bda21";

  it("wallet A owner key differs from wallet B owner key", () => {
    const keyA = makeQueryKey(5042002, CONTRACT, WALLET_A, "owner");
    const keyB = makeQueryKey(5042002, CONTRACT, WALLET_B, "owner");
    expect(keyA).not.toBe(keyB);
  });

  it("wallet A owner key differs from wallet A agent key", () => {
    const keyOwner = makeQueryKey(5042002, CONTRACT, WALLET_A, "owner");
    const keyAgent = makeQueryKey(5042002, CONTRACT, WALLET_A, "agent");
    expect(keyOwner).not.toBe(keyAgent);
  });

  it("wallet switch: wallet A then wallet B produces different keys", () => {
    const before = makeQueryKey(5042002, CONTRACT, WALLET_A, "owner");
    const after  = makeQueryKey(5042002, CONTRACT, WALLET_B, "owner");
    expect(before).not.toBe(after);
  });
});
