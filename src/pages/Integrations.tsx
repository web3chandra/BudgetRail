/**
 * Integrations / Developer Documentation page.
 * Explains Owner A, Agent B, Provider C, Signer D, and the full payment lifecycle.
 * Links to SDK, examples, and contract explorer.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check, ExternalLink } from "lucide-react";
import { BUDGET_RAIL_ADDRESS } from "@/lib/budgetRail";

// ── Copy button ────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  };
  return (
    <button
      onClick={handleCopy}
      className="ml-2 p-1 rounded hover:bg-white/10 transition-colors"
      title="Copy"
    >
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} className="text-slate-400" />}
    </button>
  );
}

// ── Code block ─────────────────────────────────────────────────────────────

function Code({ children, lang = "ts" }: { children: string; lang?: string }) {
  return (
    <div className="relative mt-2 rounded-lg bg-slate-900 border border-slate-700 overflow-x-auto">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700">
        <span className="text-xs text-slate-500 font-mono">{lang}</span>
        <CopyButton text={children} />
      </div>
      <pre className="px-4 py-3 text-sm text-slate-200 font-mono whitespace-pre-wrap">{children}</pre>
    </div>
  );
}

// ── Collapsible section ────────────────────────────────────────────────────

function Section({ title, children, defaultOpen = false }: {
  title: string; children: React.ReactNode; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-700 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left bg-slate-800/50 hover:bg-slate-800 transition-colors"
      >
        <span className="font-semibold text-white">{title}</span>
        {open ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
      </button>
      {open && <div className="px-5 py-4 bg-slate-900/50 space-y-4">{children}</div>}
    </div>
  );
}

// ── Role badge ────────────────────────────────────────────────────────────

function Role({ letter, name, color, description }: {
  letter: string; name: string; color: string; description: string;
}) {
  return (
    <div className="flex gap-3 p-3 rounded-lg bg-slate-800/60 border border-slate-700">
      <div className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${color}`}>
        {letter}
      </div>
      <div>
        <div className="font-semibold text-white text-sm">{name}</div>
        <div className="text-slate-400 text-xs mt-0.5">{description}</div>
      </div>
    </div>
  );
}

// ── Step item ─────────────────────────────────────────────────────────────

function Step({ n, label, detail }: { n: number; label: string; detail: string }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">
        {n}
      </div>
      <div>
        <div className="text-sm font-medium text-white">{label}</div>
        <div className="text-xs text-slate-400 mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function Integrations() {
  const explorerUrl = `https://explorer.testnet.arc.io/address/${BUDGET_RAIL_ADDRESS}`;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">Developer Integration</h1>
        <p className="text-slate-400 mt-1 text-sm">
          Connect your app or agent to BudgetRail. No SDK required — it's a plain HTTP API
          on top of an Arc smart contract.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600/20 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-600/30 transition-colors"
          >
            <ExternalLink size={12} /> Contract on Arc Explorer
          </a>
          <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-slate-700/50 text-slate-300 border border-slate-600/30 font-mono">
            {BUDGET_RAIL_ADDRESS.slice(0, 10)}…{BUDGET_RAIL_ADDRESS.slice(-8)}
            <CopyButton text={BUDGET_RAIL_ADDRESS} />
          </span>
        </div>
      </div>

      {/* Roles */}
      <Section title="Roles — who does what" defaultOpen>
        <p className="text-sm text-slate-400">
          Every BudgetRail session binds four roles at creation. None of them can be changed after the session is created.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Role
            letter="A" name="Owner" color="bg-blue-600 text-white"
            description="Creates the session, deposits USDC, and closes it to reclaim unspent funds. Cannot pay for requests."
          />
          <Role
            letter="B" name="Agent" color="bg-purple-600 text-white"
            description="The only address allowed to call payForRequest. Typically a software agent or CI runner. Needs gas (USDC on Arc)."
          />
          <Role
            letter="C" name="Provider payout" color="bg-emerald-600 text-white"
            description="Receives USDC when a payment settles. Set by the provider operator. Public address."
          />
          <Role
            letter="D" name="Quote signer" color="bg-amber-600 text-white"
            description="Signs EIP-712 payment quotes server-side. Private key stays on the provider server — never in the browser."
          />
        </div>
        <div className="text-xs text-slate-500 mt-2 p-3 rounded-lg bg-slate-800/50 border border-slate-700">
          <span className="text-amber-400 font-semibold">Same-wallet testing:</span> Owner A and Agent B can be the same address for testing. In production they should differ so the agent wallet can be rotated without closing sessions.
        </div>
      </Section>

      {/* Payment lifecycle */}
      <Section title="Payment lifecycle — step by step" defaultOpen>
        <div className="space-y-3">
          <Step n={1} label="Owner creates a session" detail="createSession(agent, provider, quoteSigner, maxBudget, perPaymentCap, expiresAt) — sets all four roles immutably." />
          <Step n={2} label="Owner approves + deposits USDC" detail="ERC-20 approve(BudgetRail, amount) then fundSession(sessionId, amount). Can be repeated up to maxBudget." />
          <Step n={3} label="Agent requests a signed quote" detail="POST /api/quotes with sessionId, service, input. Provider validates the session onchain and returns an EIP-712 signed quote." />
          <Step n={4} label="Agent verifies the quote locally" detail="Check chainId, contract, provider, signer address, amount ≤ perPaymentCap, deadline not expired, requestHash = SHA-256(input), EIP-712 signature valid." />
          <Step n={5} label="Agent simulates payForRequest" detail="simulateContract() before opening wallet — shows the revert reason without burning gas." />
          <Step n={6} label="Agent submits payForRequest" detail="Contract checks: agent authorized, session open, quote not expired, requestId not replayed, amount within cap. Transfers USDC to provider." />
          <Step n={7} label="Agent submits the receipt for fulfillment" detail="POST /api/fulfill with txHash + quote + input. Provider verifies the PaymentSettled event onchain, then delivers the result." />
          <Step n={8} label="Owner closes the session" detail="closeSession(sessionId) — irreversible. Refunds totalFunded − totalSpent back to the owner." />
        </div>
      </Section>

      {/* SDK quickstart */}
      <Section title="SDK quickstart (TypeScript)">
        <p className="text-sm text-slate-400">
          The SDK wraps all onchain reads, quote verification, simulation, and fulfillment in typed functions. It never generates or stores private keys.
        </p>
        <Code lang="bash">{`# The SDK lives in packages/sdk/ — install viem as a peer dep
bun add viem`}</Code>
        <Code>{`import {
  readSession, checkProviderHealth, requestQuote,
  verifyQuote, simulatePay, submitPayment,
  retrieveResultByConfirmedPayment,
  BudgetRailError,
} from "@budgetrail/sdk";

const config = {
  contractAddress: "${BUDGET_RAIL_ADDRESS}",
  chainId:         5042002,
  rpcUrl:          "https://rpc.testnet.arc.io",
  providerApiUrl:  "http://localhost:3001",
  providerPayout:  "0x<payout address C>",
  quoteSigner:     "0x<signer address D>",
};

const session = await readSession(config, 9n);
const quote   = await requestQuote(config, {
  sessionId: 9n, service: "document-insights-v1", input: "Hello world",
});
await verifyQuote(config, quote, "Hello world", 9n, session.perPaymentCap);
await simulatePay(config, agentAddress, 9n, quote);
const payment = await submitPayment(config, signer, 9n, quote);
const { result } = await retrieveResultByConfirmedPayment(config, {
  txHash: payment.txHash, quote, inputText: "Hello world",
});`}</Code>
        <p className="text-xs text-slate-500">See <code className="text-slate-300">examples/node-agent/README.md</code> for the full signer adapter example.</p>
      </Section>

      {/* Provider API reference */}
      <Section title="Provider API reference">
        <p className="text-sm text-slate-400">Three HTTP endpoints. Run the provider server at <code className="text-slate-300">provider/</code>.</p>
        <div className="space-y-3">
          <div className="p-3 rounded-lg bg-slate-800/60 border border-slate-700">
            <div className="font-mono text-sm text-green-400">GET /api/health</div>
            <div className="text-xs text-slate-400 mt-1">Returns chain ID, contract address, payout address, signer address, price per call, and RPC status. No auth required.</div>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/60 border border-slate-700">
            <div className="font-mono text-sm text-blue-400">POST /api/quotes</div>
            <div className="text-xs text-slate-400 mt-1">Body: <code className="text-slate-300">{"{ sessionId, service, input }"}</code>. Validates session onchain, returns a signed EIP-712 quote.</div>
            <Code lang="json">{`{
  "sessionId": "9",
  "service": "document-insights-v1",
  "input": "Text to analyze..."
}`}</Code>
          </div>
          <div className="p-3 rounded-lg bg-slate-800/60 border border-slate-700">
            <div className="font-mono text-sm text-purple-400">POST /api/fulfill</div>
            <div className="text-xs text-slate-400 mt-1">Body: <code className="text-slate-300">{"{ txHash, quote, input }"}</code>. Verifies PaymentSettled onchain, then delivers the result. Idempotent — safe to retry.</div>
          </div>
        </div>
      </Section>

      {/* Adding a new service */}
      <Section title="Adding a new service (RepoCheck example)">
        <p className="text-sm text-slate-400">
          BudgetRail supports multiple services via the same contract. Each service needs its own provider session.
        </p>
        <div className="space-y-2 text-sm text-slate-300">
          <p>1. Implement your compute logic (see <code className="text-slate-200">examples/provider-api/repocheck.ts</code>)</p>
          <p>2. Register it in <code className="text-slate-200">packages/sdk/src/services.ts</code></p>
          <p>3. Add it to the provider's quote + fulfill routes</p>
          <p>4. Create a new BudgetRail session with your provider's addresses</p>
          <p>5. Never reuse an existing session for a different provider</p>
        </div>
        <div className="mt-2 p-3 rounded-lg bg-amber-900/20 border border-amber-700/40 text-xs text-amber-300">
          <strong>RepoCheck</strong> scans GitHub dependencies against OSV CVE data. It is NOT a security audit. The smart contract verifies that the payment workflow was executed — it cannot verify result accuracy.
        </div>
      </Section>

      {/* Security notes */}
      <Section title="Security requirements">
        <div className="space-y-2 text-sm">
          <div className="flex gap-2"><span className="text-red-400">✗</span><span className="text-slate-300">Never put <code className="text-slate-200">QUOTE_SIGNER_PRIVATE_KEY</code> in VITE_ env vars or frontend code</span></div>
          <div className="flex gap-2"><span className="text-red-400">✗</span><span className="text-slate-300">Never use placeholder or zero addresses for provider or quoteSigner</span></div>
          <div className="flex gap-2"><span className="text-red-400">✗</span><span className="text-slate-300">Never retry payForRequest — use the same txHash for fulfillment retries</span></div>
          <div className="flex gap-2"><span className="text-red-400">✗</span><span className="text-slate-300">Never claim x402 compatibility — BudgetRail uses a custom quote/payment flow</span></div>
          <div className="flex gap-2"><span className="text-green-400">✓</span><span className="text-slate-300">Always simulate before opening wallet — catches reverts cheaply</span></div>
          <div className="flex gap-2"><span className="text-green-400">✓</span><span className="text-slate-300">Always verify EIP-712 quote signature locally before paying</span></div>
          <div className="flex gap-2"><span className="text-green-400">✓</span><span className="text-slate-300">Always verify PaymentSettled event in the receipt before delivering results</span></div>
          <div className="flex gap-2"><span className="text-green-400">✓</span><span className="text-slate-300">Save recovery state before broadcasting — enables retry without repayment</span></div>
        </div>
      </Section>
    </div>
  );
}
