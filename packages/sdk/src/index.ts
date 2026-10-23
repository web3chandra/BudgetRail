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

// Types — V1
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
  CoverageMetadata,
  FailedRange,
} from "./types.js";
export { BudgetRailError, IncompleteHistoryError } from "./types.js";

// Types — V2
export type {
  BudgetRailV2Config,
  V2FeePrice,
  SignedQuoteV2,
  PaymentSettledV2Event,
  PaymentResultV2,
} from "./types.js";
export { computeV2Fee } from "./types.js";

// ABI and constants — V1
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

// ABI and constants — V2
export {
  BUDGET_RAIL_V2_ABI,
  V2_FEE_BPS,
  V2_FEE_DENOM,
} from "./abi.js";

// Read operations — V1 (no signer needed)
export {
  readSession,
  listOwnerSessions,
  getSpendableBalance,
  verifyChain,
  decodePaymentSettledLog,
  scanPaymentSettledEvents,
} from "./read.js";
export type { ScanOptions, ScannedPayment } from "./read.js";

// Read operations — V2 (no signer needed)
export {
  readSessionV2,
  verifyV2Treasury,
  decodePaymentSettledV2Log,
  scanPaymentSettledV2Events,
} from "./read.js";
export type { ScannedPaymentV2 } from "./read.js";

// Quote — V1 (no signer needed)
export {
  checkProviderHealth,
  requestQuote,
  verifyQuote,
  computeRequestHash,
} from "./quote.js";
export type { QuoteRequest } from "./quote.js";

// Quote — V2 (no signer needed)
export {
  requestQuoteV2,
  verifyQuoteV2,
} from "./quote.js";
export type { QuoteRequestV2 } from "./quote.js";

// Payment and fund management — V1 (signer required)
export {
  simulatePay,
  submitPayment,
  waitForPayment,
  retrieveResultByConfirmedPayment,
  addFunds,
  closeAndRefund,
} from "./pay.js";

// Payment — V2 (signer required)
export {
  simulatePayV2,
  submitPaymentV2,
  retrieveResultV2,
} from "./pay.js";

// Service registry
export { SERVICE_REGISTRY, getServiceById } from "./services.js";
