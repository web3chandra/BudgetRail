/**
 * ABI fragments needed by the agent CLI.
 * Derived from the compiled BudgetRail.sol artifact — do not edit manually.
 */

export const BUDGET_RAIL_ABI = [
  // getSession(uint256) returns (Session)
  {
    "type": "function",
    "name": "getSession",
    "inputs": [{ "name": "sessionId", "type": "uint256" }],
    "outputs": [{
      "name": "",
      "type": "tuple",
      "components": [
        { "name": "owner",         "type": "address" },
        { "name": "agent",         "type": "address" },
        { "name": "provider",      "type": "address" },
        { "name": "quoteSigner",   "type": "address" },
        { "name": "maxBudget",     "type": "uint96"  },
        { "name": "perPaymentCap", "type": "uint96"  },
        { "name": "totalFunded",   "type": "uint96"  },
        { "name": "totalSpent",    "type": "uint96"  },
        { "name": "expiresAt",     "type": "uint64"  },
        { "name": "closed",        "type": "bool"    }
      ]
    }],
    "stateMutability": "view"
  },
  // availableBalance(uint256) returns (uint96)
  {
    "type": "function",
    "name": "availableBalance",
    "inputs": [{ "name": "sessionId", "type": "uint256" }],
    "outputs": [{ "name": "", "type": "uint96" }],
    "stateMutability": "view"
  },
  // payForRequest(uint256,bytes32,bytes32,uint96,uint64,bytes)
  {
    "type": "function",
    "name": "payForRequest",
    "inputs": [
      { "name": "sessionId",         "type": "uint256" },
      { "name": "requestId",         "type": "bytes32" },
      { "name": "requestHash",       "type": "bytes32" },
      { "name": "amount",            "type": "uint96"  },
      { "name": "quoteDeadline",     "type": "uint64"  },
      { "name": "providerSignature", "type": "bytes"   }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  // PaymentSettled event
  {
    "type": "event",
    "name": "PaymentSettled",
    "inputs": [
      { "name": "sessionId",    "type": "uint256", "indexed": true  },
      { "name": "requestId",    "type": "bytes32", "indexed": true  },
      { "name": "provider",     "type": "address", "indexed": true  },
      { "name": "requestHash",  "type": "bytes32", "indexed": false },
      { "name": "agent",        "type": "address", "indexed": false },
      { "name": "amount",       "type": "uint96",  "indexed": false },
      { "name": "quoteDeadline","type": "uint64",  "indexed": false }
    ]
  }
] as const;

export const ERC20_ABI = [
  {
    "type": "function",
    "name": "balanceOf",
    "inputs":  [{ "name": "account", "type": "address" }],
    "outputs": [{ "name": "",        "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowance",
    "inputs":  [
      { "name": "owner",   "type": "address" },
      { "name": "spender", "type": "address" }
    ],
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  }
] as const;
