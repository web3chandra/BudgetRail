/**
 * Chain interaction helpers for the agent CLI.
 * Read-only client (publicClient) + wallet client (walletClient) created per-run.
 * No persistent state; all state lives onchain.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentConfig } from "./config.js";
import { BUDGET_RAIL_ABI, ERC20_ABI } from "./abi.js";
import { USDC_ADDRESS, MIN_GAS_NATIVE_UNITS } from "./constants.js";

// ── Session type ───────────────────────────────────────────────────────────

export interface OnchainSession {
  owner:         `0x${string}`;
  agent:         `0x${string}`;
  provider:      `0x${string}`;
  quoteSigner:   `0x${string}`;
  maxBudget:     bigint;
  perPaymentCap: bigint;
  totalFunded:   bigint;
  totalSpent:    bigint;
  expiresAt:     bigint;
  closed:        boolean;
}

export interface SessionChecks {
  session:           OnchainSession;
  availableBalance:  bigint;
  usdcBalance:       bigint;
  nativeBalance:     bigint;
  agentAddress:      `0x${string}`;
}

// ── Client factories ───────────────────────────────────────────────────────

export function makePublicClient(config: AgentConfig): PublicClient {
  return createPublicClient({
    transport: http(config.rpcUrl),
    chain: {
      id: config.chainId,
      name: config.network === "testnet" ? "Arc Testnet" : "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
  }) as PublicClient;
}

export function makeWalletClient(config: AgentConfig): [WalletClient, `0x${string}`] {
  const account = privateKeyToAccount(config.agentPrivateKey);
  const client  = createWalletClient({
    account,
    transport: http(config.rpcUrl),
    chain: {
      id: config.chainId,
      name: config.network === "testnet" ? "Arc Testnet" : "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    },
  });
  return [client, account.address.toLowerCase() as `0x${string}`];
}

// ── Onchain reads ──────────────────────────────────────────────────────────

export async function readSession(
  client: PublicClient,
  config: AgentConfig,
  sessionId: bigint,
): Promise<OnchainSession> {
  const raw = await client.readContract({
    address: config.contractAddress,
    abi: BUDGET_RAIL_ABI,
    functionName: "getSession",
    args: [sessionId],
  }) as {
    owner: `0x${string}`; agent: `0x${string}`; provider: `0x${string}`;
    quoteSigner: `0x${string}`; maxBudget: bigint; perPaymentCap: bigint;
    totalFunded: bigint; totalSpent: bigint; expiresAt: bigint; closed: boolean;
  };

  return {
    owner:         raw.owner.toLowerCase() as `0x${string}`,
    agent:         raw.agent.toLowerCase() as `0x${string}`,
    provider:      raw.provider.toLowerCase() as `0x${string}`,
    quoteSigner:   raw.quoteSigner.toLowerCase() as `0x${string}`,
    maxBudget:     raw.maxBudget,
    perPaymentCap: raw.perPaymentCap,
    totalFunded:   raw.totalFunded,
    totalSpent:    raw.totalSpent,
    expiresAt:     raw.expiresAt,
    closed:        raw.closed,
  };
}

export async function readAvailableBalance(
  client: PublicClient,
  config: AgentConfig,
  sessionId: bigint,
): Promise<bigint> {
  return client.readContract({
    address: config.contractAddress,
    abi: BUDGET_RAIL_ABI,
    functionName: "availableBalance",
    args: [sessionId],
  }) as Promise<bigint>;
}

export async function readUsdcBalance(
  client: PublicClient,
  agentAddress: `0x${string}`,
): Promise<bigint> {
  return client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [agentAddress],
  }) as Promise<bigint>;
}

export async function readNativeBalance(
  client: PublicClient,
  agentAddress: `0x${string}`,
): Promise<bigint> {
  return client.getBalance({ address: agentAddress });
}

// ── Pre-flight session verification ───────────────────────────────────────

/**
 * Performs all read-only pre-flight checks before requesting a quote.
 * Returns structured data for display; throws descriptive Error on any failure.
 */
export async function verifySessionPreFlight(
  client: PublicClient,
  config: AgentConfig,
  sessionId: bigint,
  agentAddress: `0x${string}`,
  priceUnits: bigint,
): Promise<SessionChecks> {
  const now = BigInt(Math.floor(Date.now() / 1000));

  const [session, availableBalance, usdcBalance, nativeBalance] = await Promise.all([
    readSession(client, config, sessionId),
    readAvailableBalance(client, config, sessionId),
    readUsdcBalance(client, agentAddress),
    readNativeBalance(client, agentAddress),
  ]);

  // Session must exist
  if (session.owner === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Session ${sessionId} does not exist on ${config.network}`);
  }

  // Agent must be authorized
  if (session.agent !== agentAddress) {
    throw new Error(
      `Wrong wallet: session ${sessionId} agent is ${session.agent}, ` +
      `but this key controls ${agentAddress}`
    );
  }

  // Session must not be closed
  if (session.closed) {
    throw new Error(`Session ${sessionId} is closed — no further payments possible`);
  }

  // Session must not be expired
  if (session.expiresAt < now) {
    const expiredAgo = Number(now - session.expiresAt);
    throw new Error(`Session ${sessionId} expired ${expiredAgo}s ago`);
  }

  // Provider must match configured payout address
  if (session.provider !== config.providerPayoutAddress) {
    throw new Error(
      `Provider mismatch: session has ${session.provider}, ` +
      `configured BUDGET_RAIL_PROVIDER_PAYOUT is ${config.providerPayoutAddress}. ` +
      `Do not proceed — you would pay the wrong recipient.`
    );
  }

  // Quote signer must match configured signer address
  if (session.quoteSigner !== config.quoteSignerAddress) {
    throw new Error(
      `Quote signer mismatch: session has ${session.quoteSigner}, ` +
      `configured BUDGET_RAIL_QUOTE_SIGNER is ${config.quoteSignerAddress}. ` +
      `A quote from this provider would fail signature verification.`
    );
  }

  // Price must fit within per-call cap
  if (priceUnits > session.perPaymentCap) {
    throw new Error(
      `Fixed price ${priceUnits} exceeds session perPaymentCap ${session.perPaymentCap}`
    );
  }

  // Session must have sufficient funded balance
  if (priceUnits > availableBalance) {
    throw new Error(
      `Insufficient funded balance: need ${priceUnits}, available ${availableBalance}. ` +
      `Owner must fund the session before further payments.`
    );
  }

  // Agent must have sufficient native USDC for gas
  if (nativeBalance < MIN_GAS_NATIVE_UNITS) {
    throw new Error(
      `Insufficient native USDC for gas: have ${nativeBalance} (18-dec), ` +
      `need at least ${MIN_GAS_NATIVE_UNITS}. Add USDC to wallet ${agentAddress}.`
    );
  }

  return { session, availableBalance, usdcBalance, nativeBalance, agentAddress };
}

// ── Gas estimation ─────────────────────────────────────────────────────────

export async function estimatePayForRequestGas(
  client: PublicClient,
  config: AgentConfig,
  agentAddress: `0x${string}`,
  sessionId: bigint,
  requestId: `0x${string}`,
  requestHash: `0x${string}`,
  amount: bigint,
  quoteDeadline: bigint,
  signature: `0x${string}`,
): Promise<bigint> {
  return client.estimateContractGas({
    address: config.contractAddress,
    abi: BUDGET_RAIL_ABI,
    functionName: "payForRequest",
    args: [sessionId, requestId, requestHash, amount, quoteDeadline, signature],
    account: agentAddress,
  });
}

// ── Transaction submission ─────────────────────────────────────────────────

export async function submitPayForRequest(
  walletClient: WalletClient,
  config: AgentConfig,
  sessionId: bigint,
  requestId: `0x${string}`,
  requestHash: `0x${string}`,
  amount: bigint,
  quoteDeadline: bigint,
  signature: `0x${string}`,
): Promise<Hash> {
  const account = (walletClient as unknown as { account: { address: `0x${string}` } }).account;
  return walletClient.writeContract({
    address: config.contractAddress,
    abi: BUDGET_RAIL_ABI,
    functionName: "payForRequest",
    args: [sessionId, requestId, requestHash, amount, quoteDeadline, signature],
    account: account as `0x${string}`,
    chain: null,
  } as Parameters<typeof walletClient.writeContract>[0]) as Promise<Hash>;
}

// ── Receipt polling ────────────────────────────────────────────────────────

const RECEIPT_POLL_INTERVAL_MS = 2000;
const RECEIPT_MAX_ATTEMPTS     = 90; // 3 minutes

export async function waitForReceipt(
  client: PublicClient,
  txHash: Hash,
  log: (msg: string) => void,
): Promise<TransactionReceipt> {
  for (let attempt = 1; attempt <= RECEIPT_MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt) return receipt;
    } catch {
      // Not yet mined; keep polling
    }
    if (attempt % 10 === 0) log(`  ... still waiting for receipt (${attempt * 2}s)`);
  }
  throw new Error(
    `Receipt not found after ${RECEIPT_MAX_ATTEMPTS * RECEIPT_POLL_INTERVAL_MS / 1000}s. ` +
    `The transaction may still be in flight. Do NOT resend. ` +
    `Check recovery metadata to resume.`
  );
}

// ── PaymentSettled log verification ───────────────────────────────────────

export interface SettledEvent {
  sessionId:    bigint;
  requestId:    `0x${string}`;
  provider:     `0x${string}`;
  requestHash:  `0x${string}`;
  agent:        `0x${string}`;
  amount:       bigint;
  quoteDeadline:bigint;
}

const PAYMENT_SETTLED_ABI = parseAbi([
  "event PaymentSettled(uint256 indexed sessionId, bytes32 indexed requestId, address indexed provider, bytes32 requestHash, address agent, uint96 amount, uint64 quoteDeadline)",
]);

export function findPaymentSettledLog(
  receipt: TransactionReceipt,
  contractAddress: `0x${string}`,
  requestId: `0x${string}`,
): SettledEvent | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: PAYMENT_SETTLED_ABI,
        data: log.data,
        topics: log.topics,
      }) as { eventName: string; args: Record<string, unknown> };
      if (decoded.eventName === "PaymentSettled" && decoded.args.requestId === requestId) {
        const a = decoded.args;
        return {
          sessionId:     a.sessionId as bigint,
          requestId:     (a.requestId as string).toLowerCase() as `0x${string}`,
          provider:      (a.provider  as string).toLowerCase() as `0x${string}`,
          requestHash:   (a.requestHash as string).toLowerCase() as `0x${string}`,
          agent:         (a.agent as string).toLowerCase() as `0x${string}`,
          amount:        a.amount as bigint,
          quoteDeadline: a.quoteDeadline as bigint,
        };
      }
    } catch { /* wrong event */ }
  }
  return null;
}
