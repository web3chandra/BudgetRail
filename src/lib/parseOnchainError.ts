/**
 * Parse wagmi/viem errors into user-friendly messages.
 *
 * Priority order:
 * 1. 4-byte custom error selector from raw revert data  (most precise)
 * 2. Error name in the message string                   (viem sometimes includes it)
 * 3. Generic pattern matching on message text
 * 4. Fallback with the original message surfaced to the user
 */

// BudgetRail custom error selectors (Keccak256 first 4 bytes, confirmed against deployed bytecode).
// Selector -> human message.
const SELECTOR_MAP: Record<string, string> = {
  "0xd92e233d": "One or more addresses (provider or quote signer) is zero. Check your provider configuration.",
  "0x0757bfc9": "Max budget must be greater than zero.",
  "0x7d640cb9": "Per-call cap must be > 0 and ≤ max budget.",
  "0x079955a1": "Session expiry must be in the future.",
  "0x96c95f81": "Session not found on-chain.",
  "0x30cd7471": "Only the session owner can perform this action.",
  "0x0d9ab13f": "Only the authorized agent can pay.",
  "0xe9a4fb4e": "Session is already closed.",
  "0x1fe05652": "Session has expired.",
  "0x1f2a2005": "Amount must be greater than zero.",
  "0xbb539dcf": "Payment would exceed the session max budget.",
  "0x62563468": "Insufficient funded balance — owner must add more USDC.",
  "0x089bbe73": "Payment would exceed the session lifetime budget.",
  "0x7d15ded9": "Amount exceeds the per-call payment cap.",
  "0x8727a7f9": "Quote has expired — request a fresh quote.",
  "0xed774e0f": "Quote deadline exceeds the session expiry.",
  "0xc15be6e2": "This request ID has already been paid.",
  "0x8baa579f": "Invalid provider signature — request a fresh quote.",
};

type AnyObj = Record<string, unknown>;

/** Safely access a property on an unknown value. */
function prop(obj: unknown, key: string): unknown {
  if (obj !== null && typeof obj === "object") {
    return (obj as AnyObj)[key];
  }
  return undefined;
}

/** Extract a 4-byte hex selector from raw revert data if present. */
function extractSelector(err: unknown): string | null {
  // viem ContractFunctionRevertedError exposes .data
  const data = prop(err, "data") ?? prop(prop(err, "cause"), "data");
  if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) {
    return data.slice(0, 10).toLowerCase();
  }
  // Walk up cause chain
  const cause = prop(err, "cause");
  if (cause && cause !== err) return extractSelector(cause);
  return null;
}

export function parseOnchainError(error: unknown): string {
  // 1. Selector from revert data
  const selector = extractSelector(error);
  if (selector && SELECTOR_MAP[selector]) return SELECTOR_MAP[selector];

  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  // 2. User rejected in wallet
  if (
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("rejected the request") ||
    prop(error, "code") === 4001
  ) {
    return "Cancelled — you rejected the transaction in your wallet.";
  }

  // 3. Named custom errors in message text
  if (msg.includes("zeroaddress"))
    return SELECTOR_MAP["0xd92e233d"];
  if (msg.includes("invalidbudget"))
    return SELECTOR_MAP["0x0757bfc9"];
  if (msg.includes("invalidperpaymentcap"))
    return SELECTOR_MAP["0x7d640cb9"];
  if (msg.includes("expiryinpast"))
    return SELECTOR_MAP["0x079955a1"];
  if (msg.includes("sessionnotfound"))
    return SELECTOR_MAP["0x96c95f81"];
  if (msg.includes("notowner"))
    return SELECTOR_MAP["0x30cd7471"];
  if (msg.includes("notagent"))
    return SELECTOR_MAP["0x0d9ab13f"];
  if (msg.includes("sessionalreadyclosed"))
    return SELECTOR_MAP["0xe9a4fb4e"];
  if (msg.includes("sessionexpired"))
    return SELECTOR_MAP["0x1fe05652"];
  if (msg.includes("fundedbetexceeded") || msg.includes("fundedbetexceeded"))
    return SELECTOR_MAP["0x62563468"];
  if (msg.includes("budgetexceeded"))
    return SELECTOR_MAP["0xbb539dcf"];
  if (msg.includes("perpaymentcapexceeded"))
    return SELECTOR_MAP["0x7d15ded9"];
  if (msg.includes("quoteexpired"))
    return SELECTOR_MAP["0x8727a7f9"];
  if (msg.includes("requestalreadypaid"))
    return SELECTOR_MAP["0xc15be6e2"];
  if (msg.includes("invalidsignature"))
    return SELECTOR_MAP["0x8baa579f"];

  // 4. Generic patterns
  if (msg.includes("insufficient funds") || msg.includes("exceeds balance"))
    return "Insufficient balance. Check your USDC balance and gas.";
  if (msg.includes("network") || msg.includes("timeout") || msg.includes("fetch failed"))
    return "Network error — check your connection and try again.";
  if (msg.includes("replacement") || msg.includes("nonce"))
    return "Transaction nonce conflict — another pending transaction may be blocking this one.";
  if (msg.includes("dropped") || msg.includes("underpriced"))
    return "Transaction dropped from the mempool — please retry.";
  if (msg.includes("reverted")) {
    const match =
      msg.match(/reason:\s*"([^"]+)"/i) ??
      msg.match(/reverted with:\s*([^\n]+)/i);
    if (match) return `Contract reverted: ${match[1]}`;
    return "Transaction reverted on-chain. Check contract parameters and try again.";
  }

  // 5. Fallback with original message so the operator can debug
  const original = error instanceof Error ? error.message : String(error);
  const trimmed  = original.length > 200 ? original.slice(0, 200) + "…" : original;
  return `Unexpected error: ${trimmed}`;
}
