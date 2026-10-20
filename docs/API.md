# BudgetRail Provider API

Base URL (testnet): `http://localhost:3001` (or your hosted URL)

All endpoints return JSON. Error responses always include `{ "error": "...", "retryable": bool }`.

---

## GET /api/health

Returns server status, chain config, and the public quote signer address. Never returns secrets.

**Response 200:**
```json
{
  "status": "ok",
  "chainId": 5042002,
  "contractAddress": "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
  "providerPayout": "0x...",
  "quoteSignerAddress": "0x...",
  "service": "document-insights-v1",
  "priceBaseUnits": "50000",
  "usdcAddress": "0x3600000000000000000000000000000000000000",
  "usdcDecimals": 6,
  "network": "testnet",
  "latestBlock": "12345678",
  "rpcOk": true
}
```

**Response 503** (RPC unreachable):
```json
{ "status": "degraded", "error": "RPC unreachable", ... }
```

---

## POST /api/quotes

Issues a signed EIP-712 `PaymentQuote`. No funds move here.

**Request:**
```json
{
  "sessionId": "1",
  "service": "document-insights-v1",
  "input": "The document text to analyse (max 8 KiB UTF-8)"
}
```

**Response 200:**
```json
{
  "sessionId": "1",
  "requestId": "0x<random 32-byte hex>",
  "requestHash": "0x<SHA-256 of input, hex>",
  "amount": "50000",
  "quoteDeadline": "<unix timestamp + 600s, clamped to session expiry>",
  "signature": "0x<EIP-712 signature by key D>",
  "chainId": 5042002,
  "contractAddress": "0xf6a13df15ad93c2e2968e1d69c53894a923bda21",
  "providerPayout": "0x...",
  "quoteSignerAddress": "0x...",
  "service": "document-insights-v1",
  "displayPrice": "$0.05 USDC"
}
```

**Error responses:**
| Code | Condition |
|------|-----------|
| 400 | Invalid input, wrong service, session not found/closed/expired, provider/signer mismatch, price exceeds cap, insufficient funded balance, session expires too soon |
| 429 | Rate limit exceeded for this session (10 req/min by default) |
| 503 | RPC error reading session |

**Security guarantees:**
- Server always sets `amount` to the configured price; any user-supplied amount is ignored.
- `requestHash = SHA-256(exact UTF-8 bytes of input)` — binds the quote to the input.
- `requestId` is 32 bytes of cryptographic randomness — different on every call.
- The private key is never in the response.

---

## POST /api/fulfill

Verifies the on-chain payment proof and returns the Document Insights result.

**Request:**
```json
{
  "input": "<exact original UTF-8 input — must match requestHash>",
  "quote": { "<full SignedQuote object returned by /api/quotes>" },
  "txHash": "0x<transaction hash of the payForRequest call>"
}
```

**Response 200:**
```json
{
  "result": {
    "wordCount": 42,
    "sentenceCount": 3,
    "paragraphCount": 1,
    "avgWordsPerSentence": 14,
    "avgSentencesPerParagraph": 3,
    "top10Keywords": [["word", 5], ...],
    "readabilityTier": "moderate",
    "extractiveSummary": ["First sentence of paragraph 1.", ...],
    "frequencyTable": { "word": 5, ... }
  },
  "payment": {
    "txHash": "0x...",
    "sessionId": "1",
    "requestId": "0x...",
    "amount": "50000",
    "amountUsdc": "$0.050000 USDC",
    "chainId": 5042002,
    "contractAddress": "0x...",
    "blockNumber": "12345678",
    "explorerUrl": "https://explorer.testnet.arc.io/tx/0x..."
  }
}
```

**Error responses:**
| Code | Condition |
|------|-----------|
| 400 | SHA-256(input) != requestHash; wrong chainId/contract/provider/signer/amount; tx to wrong contract; agent mismatch; no PaymentSettled from BudgetRail; field mismatches; USDC Transfer mismatch; payment block after quoteDeadline |
| 402 (retryable) | Tx not found yet; reverted tx; no PaymentSettled log; no ERC-20 Transfer log |
| 503 (retryable) | RPC error fetching tx or receipt |

**Security guarantees (14 independent checks):**
1. SHA-256(input) == quote.requestHash
2. Quote fields match server config (chainId, contract, provider, signer, amount, service)
3. Signature valid against session.quoteSigner stored on-chain
4. tx.status == success
5. tx.to == BudgetRail contract (exact address)
6. PaymentSettled emitted from BudgetRail address (not just same topic)
7. PaymentSettled.sessionId, requestId, requestHash, provider, amount, quoteDeadline all match
8. tx.from == PaymentSettled.agent (prevents replay with different agent)
9. ERC-20 Transfer from BudgetRail to provider C with exact amount
10. block.timestamp of payment block <= quoteDeadline (on-chain time, not wall-clock)
11. Input size within bounds
12. txHash format valid
13. All required quote fields present
14. BigInt fields parseable

**Idempotency:** The same `(input, quote, txHash)` tuple always returns the same result (Document Insights is deterministic). Safe to retry without a new payment.

---

## Document Insights v1 schema

```typescript
interface DocumentInsights {
  wordCount:                 number;
  sentenceCount:             number;
  paragraphCount:            number;
  avgWordsPerSentence:       number;
  avgSentencesPerParagraph:  number;
  top10Keywords:             [string, number][];  // [word, count]
  readabilityTier:           "simple" | "moderate" | "complex";
  extractiveSummary:         string[];  // first sentence of up to 3 paragraphs
  frequencyTable:            Record<string, number>;
}
```

Readability tiers: `avgWordsPerSentence < 10` → simple; `< 20` → moderate; else complex. Stop-words are excluded from `top10Keywords` and `frequencyTable`.

---

## EIP-712 PaymentQuote type (for agent integration)

```
domain:
  name:              "BudgetRail"
  version:           "1"
  chainId:           5042002  (testnet) or 5042 (mainnet)
  verifyingContract: <BudgetRail contract address>

primaryType: "PaymentQuote"

types:
  PaymentQuote:
    - sessionId:     uint256
    - requestId:     bytes32
    - requestHash:   bytes32
    - amount:        uint256
    - quoteDeadline: uint64
```
