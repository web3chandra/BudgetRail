/**
 * BudgetRail SDK
 *
 * A typed TypeScript/viem client for BudgetRail on Arc.
 * Never stores or generates private keys — all write operations
 * require a BudgetRailSigner provided by the caller.
 *
 * @example
 * ```ts
 * import { readSession, requestQuote, verifyQuote, simulatePay } from "@budgetrail/sdk";
 *
 * const config = {
 *   contractAddress: "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
 *   chainId:         5042002,
 *   rpcUrl:          "https://rpc.testnet.arc.io",
 *   providerApiUrl:  "http://localhost:3001",
 *   providerPayout:  "<payout wallet C>",
 *   quoteSigner:     "<quote signer D>",
 * };
 *
 * const session = await readSession(config, 1n);
 * const quote   = await requestQuote(config, { sessionId: 1n, service: "document-insights-v1", input: "..." });
 * await verifyQuote(config, quote, "...", 1n, 50_000n);
 * await simulatePay(config, agentAddress, 1n, quote);
 * const result  = await submitPayment(config, signer, 1n, quote);
 * ```
 */

// Types
export type {
  BudgetRailConfig,
  Session,
  SignedQuote,
  BudgetRailSigner,
  WriteContractParams,
  TransactionReceipt,
  RawLog,
  PaymentResult,
  PaymentSettledEvent,
  AddFundsResult,
  CloseAndRefundResult,
  ProviderHealth,
  ServiceDescriptor,
  BudgetRailErrorCode,
} from "./types.js";
export { BudgetRailError } from "./types.js";

// ABI and constants
export {
  BUDGET_RAIL_ABI,
  ERC20_ABI,
  ARC_TESTNET_CONTRACT,
  ARC_TESTNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  USDC_ADDRESS,
  USDC_DECIMALS,
  DEPLOY_BLOCK_TESTNET,
} from "./abi.js";

// Read operations (no signer needed)
export {
  readSession,
  listOwnerSessions,
  getSpendableBalance,
  verifyChain,
  decodePaymentSettledLog,
  scanPaymentSettledEvents,
} from "./read.js";
export type { ScanOptions, ScannedPayment } from "./read.js";

// Quote (no signer needed)
export {
  checkProviderHealth,
  requestQuote,
  verifyQuote,
  computeRequestHash,
} from "./quote.js";
export type { QuoteRequest } from "./quote.js";

// Payment and fund management (signer required)
export {
  simulatePay,
  submitPayment,
  waitForPayment,
  retrieveResultByConfirmedPayment,
  addFunds,
  closeAndRefund,
} from "./pay.js";

// Service registry
export { SERVICE_REGISTRY, getServiceById } from "./services.js";
