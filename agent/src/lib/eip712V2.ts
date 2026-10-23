/**
 * V2 EIP-712 quote verification for the agent CLI.
 *
 * Verifies a SignedQuoteV2 returned by /api/quotes/v2:
 *   1. All required fields are present.
 *   2. Version tag is "2" — rejects V1 quotes.
 *   3. chainId, contractAddress, provider, treasury match config.
 *   4. baseAmount matches expected service price.
 *   5. feeAmount == floor(baseAmount * 50 / 10_000) — no hidden fees.
 *   6. grossAmount == baseAmount + feeAmount.
 *   7. grossAmount <= session.perPaymentCap and <= session.availableBalance.
 *   8. deadline is in the future.
 *   9. EIP-712 signature recovers to the expected quote signer D.
 *
 * Uses exact integer arithmetic (bigint) — never floats for authorization.
 */

import { recoverTypedDataAddress } from "viem";

export interface SignedQuoteV2 {
  version:            "2";
  sessionId:          string;
  requestId:          string;
  baseAmount:         string;
  feeAmount:          string;
  grossAmount:        string;
  deadline:           string;
  provider:           string;
  treasury:           string;
  signature:          `0x${string}`;
  chainId:            number;
  contractAddress:    string;
  quoteSignerAddress: string;
  service:            string;
  displayPrice:       string;
}

export interface V2VerifyParams {
  quote:                SignedQuoteV2;
  sessionId:            bigint;
  chainId:              number;
  contractAddress:      `0x${string}`;
  providerPayoutAddress: `0x${string}`;
  expectedTreasury:     `0x${string}`;
  quoteSignerAddress:   `0x${string}`;
  /** Expected base price in ERC-20 base units (6 decimals). */
  expectedBaseUnits:    bigint;
  /** Session perPaymentCap (gross). */
  perPaymentCap:        bigint;
  /** Session available balance (gross). */
  availableBalance:     bigint;
}

/** Compute fee using exact integer math — matches contract formula. */
function computeFee(baseAmount: bigint): { feeAmount: bigint; grossAmount: bigint } {
  const feeAmount   = (baseAmount * 50n) / 10_000n;
  const grossAmount = baseAmount + feeAmount;
  return { feeAmount, grossAmount };
}

/**
 * Fully verify a V2 signed quote before presenting it to the operator or submitting to chain.
 * Throws a descriptive Error on any mismatch.
 */
export async function verifySignedQuoteV2(params: V2VerifyParams): Promise<void> {
  const { quote, sessionId, chainId, contractAddress,
          providerPayoutAddress, expectedTreasury,
          quoteSignerAddress, expectedBaseUnits,
          perPaymentCap, availableBalance } = params;

  // ── 1. Version guard ──────────────────────────────────────────────────────
  if (quote.version !== "2") {
    throw new Error(
      `Quote version is "${quote.version}", expected "2". ` +
      `V1 quotes cannot be used with V2 sessions or payForRequestV2.`
    );
  }

  // ── 2. Parse numeric fields (exact bigint — no floats) ────────────────────
  const baseAmount  = BigInt(quote.baseAmount);
  const feeAmount   = BigInt(quote.feeAmount);
  const grossAmount = BigInt(quote.grossAmount);
  const deadline    = BigInt(quote.deadline);
  const quoteSessionId = BigInt(quote.sessionId);

  // ── 3. Session ID ─────────────────────────────────────────────────────────
  if (quoteSessionId !== sessionId) {
    throw new Error(`Quote sessionId ${quoteSessionId} != expected ${sessionId}`);
  }

  // ── 4. Chain and contract ─────────────────────────────────────────────────
  if (quote.chainId !== chainId) {
    throw new Error(`Quote chainId ${quote.chainId} != configured chainId ${chainId}`);
  }
  if (quote.contractAddress.toLowerCase() !== contractAddress.toLowerCase()) {
    throw new Error(`Quote contractAddress ${quote.contractAddress} != V2 contract ${contractAddress}`);
  }

  // ── 5. Provider C ─────────────────────────────────────────────────────────
  if (quote.provider.toLowerCase() !== providerPayoutAddress.toLowerCase()) {
    throw new Error(
      `Quote provider ${quote.provider} != configured provider ${providerPayoutAddress}. ` +
      `Do not submit — base payment would go to wrong address.`
    );
  }

  // ── 6. Treasury E ─────────────────────────────────────────────────────────
  if (quote.treasury.toLowerCase() !== expectedTreasury.toLowerCase()) {
    throw new Error(
      `Quote treasury ${quote.treasury} != configured treasury ${expectedTreasury}. ` +
      `Do not submit — platform fee would go to wrong address.`
    );
  }

  // ── 7. Base price ─────────────────────────────────────────────────────────
  if (baseAmount !== expectedBaseUnits) {
    throw new Error(
      `Quote baseAmount ${baseAmount} != expected service price ${expectedBaseUnits}. ` +
      `Server may have changed price since quote was issued.`
    );
  }

  // ── 8. Fee arithmetic (exact integer, matches contract formula) ───────────
  const { feeAmount: expectedFee, grossAmount: expectedGross } = computeFee(baseAmount);
  if (feeAmount !== expectedFee) {
    throw new Error(
      `Quote feeAmount ${feeAmount} != floor(${baseAmount} * 50 / 10000) = ${expectedFee}. ` +
      `Fee does not match the immutable 0.5% rate.`
    );
  }
  if (grossAmount !== expectedGross) {
    throw new Error(
      `Quote grossAmount ${grossAmount} != baseAmount + feeAmount = ${expectedGross}. ` +
      `Hidden fee or rounding drift detected.`
    );
  }

  // ── 9. Budget checks use grossAmount ─────────────────────────────────────
  if (grossAmount > perPaymentCap) {
    throw new Error(
      `Quote grossAmount ${grossAmount} exceeds session perPaymentCap ${perPaymentCap}. ` +
      `The session needs a higher cap to cover base + 0.5% fee.`
    );
  }
  if (grossAmount > availableBalance) {
    throw new Error(
      `Insufficient funded balance: quote grossAmount ${grossAmount} > available ${availableBalance}. ` +
      `Owner must fund the session before further V2 payments.`
    );
  }

  // ── 10. Deadline in the future ────────────────────────────────────────────
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= nowSecs) {
    throw new Error(
      `Quote deadline ${deadline} is in the past (now=${nowSecs}). ` +
      `Request a fresh quote.`
    );
  }

  // ── 11. EIP-712 signature recovery ───────────────────────────────────────
  const domain = {
    name:              "BudgetRail" as const,
    version:           "2" as const,
    chainId,
    verifyingContract: contractAddress,
  };
  const types = {
    PaymentQuoteV2: [
      { name: "sessionId",   type: "uint256" },
      { name: "requestId",   type: "bytes32" },
      { name: "baseAmount",  type: "uint256" },
      { name: "feeAmount",   type: "uint256" },
      { name: "grossAmount", type: "uint256" },
      { name: "deadline",    type: "uint256" },
      { name: "provider",    type: "address" },
      { name: "treasury",    type: "address" },
    ],
  } as const;

  const recovered = await recoverTypedDataAddress({
    domain,
    types,
    primaryType: "PaymentQuoteV2",
    message: {
      sessionId:   quoteSessionId,
      requestId:   quote.requestId as `0x${string}`,
      baseAmount,
      feeAmount,
      grossAmount,
      deadline,
      provider:    quote.provider as `0x${string}`,
      treasury:    quote.treasury as `0x${string}`,
    },
    signature: quote.signature,
  });

  if (recovered.toLowerCase() !== quoteSignerAddress.toLowerCase()) {
    throw new Error(
      `Signature verification failed: recovered signer ${recovered} != expected D ${quoteSignerAddress}. ` +
      `Quote may have been tampered with. Do NOT submit.`
    );
  }
}
