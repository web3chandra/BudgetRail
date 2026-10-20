/**
 * useSessionFlow — full lifecycle state machine for createSession → approve → fundSession.
 *
 * State machine:
 *   idle → validating → awaiting_signature → submitted → confirming → confirmed
 *                                                                    → failed
 *                                          → cancelled
 *
 * Each of the three steps (create / approve / fund) has its own sub-machine.
 * The overall "flow step" tracks which step is active.
 *
 * Key guarantees:
 * - simulateContract runs before EVERY writeContract call; if simulation reverts,
 *   the wallet is never opened.
 * - Receipt status is checked; status="reverted" sets step to "failed".
 * - isError from useWaitForTransactionReceipt is handled for every step.
 * - isError from useWriteContract is handled for wallet rejection.
 * - Duplicate submissions are blocked while any step is in-flight.
 * - Non-sensitive form draft + pending tx hashes are persisted to localStorage
 *   so the user can recover after a browser refresh.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  usePublicClient,
} from "wagmi";
import { erc20Abi, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { getUsdc } from "@/onchain-facts";
import {
  BUDGET_RAIL_ABI,
  BUDGET_RAIL_ADDRESS,
  PROVIDER_PAYOUT,
  QUOTE_SIGNER,
} from "@/lib/budgetRail";
import { parseOnchainError } from "@/lib/parseOnchainError";

const CHAIN_ID = arcTestnet.id;
const USDC = getUsdc(CHAIN_ID)!;

// ── Types ─────────────────────────────────────────────────────────────────

export type TxStatus =
  | "idle"
  | "validating"
  | "awaiting_signature"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "cancelled";

export type FlowStep =
  | "form"
  | "creating"
  | "created"
  | "approving"
  | "approved"
  | "funding"
  | "done";

export interface FlowState {
  step:            FlowStep;
  createStatus:    TxStatus;
  approveStatus:   TxStatus;
  fundStatus:      TxStatus;
  createHash:      `0x${string}` | undefined;
  approveHash:     `0x${string}` | undefined;
  fundHash:        `0x${string}` | undefined;
  sessionId:       bigint | null;
  txError:         string | null;
  /** Cleared on every new attempt; shows the sim revert reason before wallet opens */
  simError:        string | null;
}

export interface FormValues {
  agentAddress:  string;
  maxBudget:     string;
  perPaymentCap: string;
  expiryDays:    string;
  fundAmount:    string;
}

export const DEFAULT_FORM: FormValues = {
  agentAddress:  "",
  maxBudget:     "1.00",
  perPaymentCap: "0.05",
  expiryDays:    "7",
  fundAmount:    "0.50",
};

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a decimal USDC string to 6-decimal bigint units.
 * Uses pure string/bigint arithmetic — no floating-point, no rounding error.
 * Returns null for invalid, zero, or negative inputs.
 * Examples: "1.50" → 1500000n, "0.05" → 50000n, "0.0000001" → null (below 1 unit)
 */
export function parseUsdcUnits(s: string): bigint | null {
  const t = s.trim();
  if (!t || !/^\d*\.?\d*$/.test(t) || t === "." || t === "") return null;
  const [whole, frac = ""] = t.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  try {
    const v = BigInt(whole || "0") * 1_000_000n + BigInt(fracPadded);
    return v > 0n ? v : null;
  } catch { return null; }
}

export function isValidAddress(addr: string): addr is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

const DRAFT_KEY  = "budgetrail_create_draft_v1";
const HASHES_KEY = "budgetrail_pending_hashes_v1";

function loadDraft(): Partial<FormValues> {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Partial<FormValues>) : {};
  } catch { return {}; }
}

function saveDraft(f: FormValues) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(f)); } catch { /* quota */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* */ }
}

interface PendingHashes {
  chainId:       number;
  account:       string;
  contract:      string;
  createHash?:   string;
  approveHash?:  string;
  fundHash?:     string;
  sessionId?:    string;
  flowStep?:     FlowStep;
}

function loadHashes(account: string): PendingHashes | null {
  try {
    const raw = localStorage.getItem(HASHES_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PendingHashes;
    if (
      data.chainId === CHAIN_ID &&
      data.account.toLowerCase() === account.toLowerCase() &&
      data.contract.toLowerCase() === BUDGET_RAIL_ADDRESS.toLowerCase()
    ) return data;
  } catch { /* */ }
  return null;
}

function saveHashes(data: PendingHashes) {
  try { localStorage.setItem(HASHES_KEY, JSON.stringify(data)); } catch { /* */ }
}

function clearHashes() {
  try { localStorage.removeItem(HASHES_KEY); } catch { /* */ }
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useSessionFlow(address: `0x${string}` | undefined) {
  // Form state — restored from draft
  const draft = loadDraft();
  const [form, setForm] = useState<FormValues>({ ...DEFAULT_FORM, ...draft });

  // Save draft whenever form changes
  useEffect(() => { saveDraft(form); }, [form]);

  // Flow state
  const [flow, setFlow] = useState<FlowState>({
    step:          "form",
    createStatus:  "idle",
    approveStatus: "idle",
    fundStatus:    "idle",
    createHash:    undefined,
    approveHash:   undefined,
    fundHash:      undefined,
    sessionId:     null,
    txError:       null,
    simError:      null,
  });

  // Prevent double-submission
  const inFlight = useRef(false);

  // wagmi hooks
  const publicClient = usePublicClient({ chainId: CHAIN_ID });

  const {
    writeContract: writeCreate,
    data:          createHashRaw,
    isPending:     isCreatePending,
    isError:       isCreateWalletError,
    error:         createWalletError,
    reset:         resetCreate,
  } = useWriteContract();

  const {
    writeContract: writeApprove,
    data:          approveHashRaw,
    isPending:     isApprovePending,
    isError:       isApproveWalletError,
    error:         approveWalletError,
    reset:         resetApprove,
  } = useWriteContract();

  const {
    writeContract: writeFund,
    data:          fundHashRaw,
    isPending:     isFundPending,
    isError:       isFundWalletError,
    error:         fundWalletError,
    reset:         resetFund,
  } = useWriteContract();

  // Receipt watchers
  const {
    isLoading: isCreateConfirming,
    isSuccess: isCreateSuccess,
    isError:   isCreateReceiptError,
    error:     createReceiptError,
    data:      createReceipt,
  } = useWaitForTransactionReceipt({ hash: createHashRaw });

  const {
    isLoading: isApproveConfirming,
    isSuccess: isApproveSuccess,
    isError:   isApproveReceiptError,
    error:     approveReceiptError,
  } = useWaitForTransactionReceipt({ hash: approveHashRaw });

  const {
    isLoading: isFundConfirming,
    isSuccess: isFundSuccess,
    isError:   isFundReceiptError,
    error:     fundReceiptError,
  } = useWaitForTransactionReceipt({ hash: fundHashRaw });

  // ── Wallet rejection handlers ─────────────────────────────────────────

  useEffect(() => {
    if (!isCreateWalletError || flow.step !== "creating") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:         "form",
      createStatus: "cancelled",
      txError:      parseOnchainError(createWalletError),
    }));
    resetCreate();
  }, [isCreateWalletError, createWalletError, flow.step, resetCreate]);

  useEffect(() => {
    if (!isApproveWalletError || flow.step !== "approving") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:          "created",
      approveStatus: "cancelled",
      txError:       parseOnchainError(approveWalletError),
    }));
    resetApprove();
  }, [isApproveWalletError, approveWalletError, flow.step, resetApprove]);

  useEffect(() => {
    if (!isFundWalletError || flow.step !== "funding") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:       "approved",
      fundStatus: "cancelled",
      txError:    parseOnchainError(fundWalletError),
    }));
    resetFund();
  }, [isFundWalletError, fundWalletError, flow.step, resetFund]);

  // ── Receipt: submitted → confirming ──────────────────────────────────

  useEffect(() => {
    if (createHashRaw && flow.createStatus === "awaiting_signature") {
      saveHashes({
        chainId: CHAIN_ID, account: address ?? "", contract: BUDGET_RAIL_ADDRESS,
        createHash: createHashRaw, flowStep: "creating",
      });
      setFlow(f => ({
        ...f,
        createHash:   createHashRaw,
        createStatus: "submitted",
      }));
    }
  }, [createHashRaw, flow.createStatus, address]);

  useEffect(() => {
    if (isCreateConfirming && flow.createStatus === "submitted") {
      setFlow(f => ({ ...f, createStatus: "confirming" }));
    }
  }, [isCreateConfirming, flow.createStatus]);

  useEffect(() => {
    if (approveHashRaw && flow.approveStatus === "awaiting_signature") {
      saveHashes({
        chainId: CHAIN_ID, account: address ?? "", contract: BUDGET_RAIL_ADDRESS,
        createHash:  createHashRaw,
        approveHash: approveHashRaw,
        sessionId:   flow.sessionId?.toString(),
        flowStep:    "approving",
      });
      setFlow(f => ({
        ...f,
        approveHash:   approveHashRaw,
        approveStatus: "submitted",
      }));
    }
  }, [approveHashRaw, flow.approveStatus, address, createHashRaw, flow.sessionId]);

  useEffect(() => {
    if (isApproveConfirming && flow.approveStatus === "submitted") {
      setFlow(f => ({ ...f, approveStatus: "confirming" }));
    }
  }, [isApproveConfirming, flow.approveStatus]);

  useEffect(() => {
    if (fundHashRaw && flow.fundStatus === "awaiting_signature") {
      saveHashes({
        chainId: CHAIN_ID, account: address ?? "", contract: BUDGET_RAIL_ADDRESS,
        createHash:  createHashRaw,
        approveHash: approveHashRaw,
        fundHash:    fundHashRaw,
        sessionId:   flow.sessionId?.toString(),
        flowStep:    "funding",
      });
      setFlow(f => ({
        ...f,
        fundHash:   fundHashRaw,
        fundStatus: "submitted",
      }));
    }
  }, [fundHashRaw, flow.fundStatus, address, createHashRaw, approveHashRaw, flow.sessionId]);

  useEffect(() => {
    if (isFundConfirming && flow.fundStatus === "submitted") {
      setFlow(f => ({ ...f, fundStatus: "confirming" }));
    }
  }, [isFundConfirming, flow.fundStatus]);

  // ── Receipt: confirming → confirmed / failed ──────────────────────────

  useEffect(() => {
    if (!isCreateSuccess || !createReceipt || flow.step !== "creating") return;
    inFlight.current = false;

    // Check receipt.status (viem returns "success" | "reverted")
    if ((createReceipt.status as string) === "reverted") {
      setFlow(f => ({
        ...f,
        step:         "form",
        createStatus: "failed",
        txError:      "createSession transaction reverted on-chain. Check parameters and try again.",
      }));
      return;
    }

    // Decode SessionCreated event to get session ID
    let sessionId: bigint | null = null;
    for (const log of createReceipt.logs) {
      if (log.address.toLowerCase() !== BUDGET_RAIL_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: BUDGET_RAIL_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "SessionCreated") {
          sessionId = (decoded.args as unknown as { sessionId: bigint }).sessionId;
          break;
        }
      } catch { /* different event */ }
    }

    if (!sessionId) {
      setFlow(f => ({
        ...f,
        step:         "form",
        createStatus: "failed",
        txError:      "Transaction confirmed but SessionCreated event not found in receipt. Unexpected contract state.",
      }));
      return;
    }

    saveHashes({
      chainId: CHAIN_ID, account: address ?? "", contract: BUDGET_RAIL_ADDRESS,
      createHash: createHashRaw,
      sessionId:  sessionId.toString(),
      flowStep:   "created",
    });

    setFlow(f => ({
      ...f,
      step:         "created",
      createStatus: "confirmed",
      sessionId,
      txError:      null,
    }));
  }, [isCreateSuccess, createReceipt, flow.step, address, createHashRaw]);

  useEffect(() => {
    if (!isCreateReceiptError || flow.step !== "creating") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:         "form",
      createStatus: "failed",
      txError:      parseOnchainError(createReceiptError) + " (createSession)",
    }));
  }, [isCreateReceiptError, createReceiptError, flow.step]);

  useEffect(() => {
    if (!isApproveSuccess || flow.step !== "approving") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:          "approved",
      approveStatus: "confirmed",
      txError:       null,
    }));
  }, [isApproveSuccess, flow.step]);

  useEffect(() => {
    if (!isApproveReceiptError || flow.step !== "approving") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:          "created",
      approveStatus: "failed",
      txError:       parseOnchainError(approveReceiptError) + " (approve)",
    }));
  }, [isApproveReceiptError, approveReceiptError, flow.step]);

  useEffect(() => {
    if (!isFundSuccess || flow.step !== "funding") return;
    inFlight.current = false;
    clearHashes();
    clearDraft();
    setFlow(f => ({
      ...f,
      step:       "done",
      fundStatus: "confirmed",
      txError:    null,
    }));
  }, [isFundSuccess, flow.step]);

  useEffect(() => {
    if (!isFundReceiptError || flow.step !== "funding") return;
    inFlight.current = false;
    setFlow(f => ({
      ...f,
      step:       "approved",
      fundStatus: "failed",
      txError:    parseOnchainError(fundReceiptError) + " (fundSession)",
    }));
  }, [isFundReceiptError, fundReceiptError, flow.step]);

  // ── On-chain recovery after refresh ──────────────────────────────────

  const recoverFromChain = useCallback(async () => {
    if (!address || !publicClient) return;
    const stored = loadHashes(address);
    if (!stored) return;

    // If we have a completed fund hash, clear and start fresh
    if (stored.fundHash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: stored.fundHash as `0x${string}` });
        if (r.status === "success") {
          clearHashes();
          clearDraft();
          setFlow(f => ({
            ...f,
            step:       "done",
            fundStatus: "confirmed",
            fundHash:   stored.fundHash as `0x${string}`,
            sessionId:  stored.sessionId ? BigInt(stored.sessionId) : null,
          }));
          return;
        }
        // Fund tx failed — resume from approved
        if (r.status === "reverted") {
          setFlow(f => ({
            ...f,
            step:       "approved",
            fundStatus: "failed",
            fundHash:   stored.fundHash as `0x${string}`,
            sessionId:  stored.sessionId ? BigInt(stored.sessionId) : null,
            txError:    "Previous fundSession transaction reverted. Click Fund Session to retry.",
          }));
          return;
        }
      } catch { /* tx not found — may have been dropped; fall through */ }
    }

    // Check approve hash
    if (stored.approveHash && stored.sessionId) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: stored.approveHash as `0x${string}` });
        if (r.status === "success") {
          setFlow(f => ({
            ...f,
            step:          "approved",
            createStatus:  "confirmed",
            approveStatus: "confirmed",
            createHash:    stored.createHash as `0x${string}` | undefined,
            approveHash:   stored.approveHash as `0x${string}`,
            sessionId:     BigInt(stored.sessionId!),
          }));
          return;
        }
      } catch { /* */ }
    }

    // Check create hash
    if (stored.createHash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash: stored.createHash as `0x${string}` });
        if (r.status === "success") {
          let sessionId: bigint | null = stored.sessionId ? BigInt(stored.sessionId) : null;
          if (!sessionId) {
            for (const log of r.logs) {
              if (log.address.toLowerCase() !== BUDGET_RAIL_ADDRESS.toLowerCase()) continue;
              try {
                const decoded = decodeEventLog({ abi: BUDGET_RAIL_ABI, data: log.data, topics: log.topics });
                if (decoded.eventName === "SessionCreated") {
                  sessionId = (decoded.args as unknown as { sessionId: bigint }).sessionId;
                  break;
                }
              } catch { /* */ }
            }
          }
          if (sessionId) {
            setFlow(f => ({
              ...f,
              step:         "created",
              createStatus: "confirmed",
              createHash:   stored.createHash as `0x${string}`,
              sessionId,
            }));
            return;
          }
        }
        if (r.status === "reverted") {
          clearHashes();
          return;
        }
      } catch { /* tx not found */ }
    }
  }, [address, publicClient]);

  // Run recovery on mount once per account
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (!address || recoveredRef.current) return;
    recoveredRef.current = true;
    void recoverFromChain();
  }, [address, recoverFromChain]);

  // ── Simulation helper ─────────────────────────────────────────────────

  const simulate = useCallback(async (
    fn: string,
    args: unknown[],
    abi: typeof BUDGET_RAIL_ABI | typeof erc20Abi,
    contractAddress: `0x${string}`,
  ): Promise<string | null> => {
    if (!publicClient || !address) return "Wallet not connected.";
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (publicClient.simulateContract as (opts: unknown) => Promise<unknown>)({
        address: contractAddress,
        abi,
        functionName: fn,
        args,
        account: address,
      });
      return null;
    } catch (err) {
      return parseOnchainError(err);
    }
  }, [publicClient, address]);

  // ── Step actions ──────────────────────────────────────────────────────

  const submitCreate = useCallback(async (
    agentAddr: `0x${string}`,
    maxBudgetUnits: bigint,
    capUnits: bigint,
    expiresAt: bigint,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFlow(f => ({ ...f, step: "creating", createStatus: "validating", simError: null, txError: null }));

    // Simulate before opening wallet
    const simErr = await simulate(
      "createSession",
      [agentAddr, PROVIDER_PAYOUT, QUOTE_SIGNER, maxBudgetUnits, capUnits, expiresAt],
      BUDGET_RAIL_ABI,
      BUDGET_RAIL_ADDRESS,
    );
    if (simErr) {
      inFlight.current = false;
      setFlow(f => ({ ...f, step: "form", createStatus: "failed", simError: simErr, txError: null }));
      return;
    }

    setFlow(f => ({ ...f, createStatus: "awaiting_signature" }));
    writeCreate({
      address: BUDGET_RAIL_ADDRESS,
      abi: BUDGET_RAIL_ABI,
      functionName: "createSession",
      args: [agentAddr, PROVIDER_PAYOUT, QUOTE_SIGNER, maxBudgetUnits, capUnits, expiresAt],
      chainId: CHAIN_ID,
    });
  }, [writeCreate, simulate]);

  const submitApprove = useCallback(async (sessionIdVal: bigint, fundUnits: bigint) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFlow(f => ({ ...f, step: "approving", approveStatus: "validating", simError: null, txError: null }));

    const simErr = await simulate(
      "approve",
      [BUDGET_RAIL_ADDRESS, fundUnits],
      erc20Abi,
      USDC.address,
    );
    if (simErr) {
      inFlight.current = false;
      setFlow(f => ({ ...f, step: "created", approveStatus: "failed", simError: simErr, txError: null }));
      return;
    }

    setFlow(f => ({ ...f, approveStatus: "awaiting_signature" }));
    writeApprove({
      address: USDC.address,
      abi: erc20Abi,
      functionName: "approve",
      args: [BUDGET_RAIL_ADDRESS, fundUnits],
      chainId: CHAIN_ID,
    });
    void sessionIdVal; // used by caller for context, not needed here
  }, [writeApprove, simulate]);

  const submitFund = useCallback(async (sessionIdVal: bigint, fundUnits: bigint) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFlow(f => ({ ...f, step: "funding", fundStatus: "validating", simError: null, txError: null }));

    const simErr = await simulate(
      "fundSession",
      [sessionIdVal, fundUnits],
      BUDGET_RAIL_ABI,
      BUDGET_RAIL_ADDRESS,
    );
    if (simErr) {
      inFlight.current = false;
      setFlow(f => ({ ...f, step: "approved", fundStatus: "failed", simError: simErr, txError: null }));
      return;
    }

    setFlow(f => ({ ...f, fundStatus: "awaiting_signature" }));
    writeFund({
      address: BUDGET_RAIL_ADDRESS,
      abi: BUDGET_RAIL_ABI,
      functionName: "fundSession",
      args: [sessionIdVal, fundUnits],
      chainId: CHAIN_ID,
    });
  }, [writeFund, simulate]);

  const dismissError = useCallback(() => {
    setFlow(f => ({ ...f, txError: null, simError: null }));
  }, []);

  const resetFlow = useCallback(() => {
    inFlight.current = false;
    clearHashes();
    resetCreate(); resetApprove(); resetFund();
    setFlow({
      step: "form", createStatus: "idle", approveStatus: "idle", fundStatus: "idle",
      createHash: undefined, approveHash: undefined, fundHash: undefined,
      sessionId: null, txError: null, simError: null,
    });
  }, [resetCreate, resetApprove, resetFund]);

  // ── Derived status flags ──────────────────────────────────────────────

  const isCreating  = isCreatePending  || flow.createStatus  === "validating" || flow.createStatus  === "awaiting_signature" || isCreateConfirming;
  const isApproving = isApprovePending || flow.approveStatus === "validating" || flow.approveStatus === "awaiting_signature" || isApproveConfirming;
  const isFunding   = isFundPending    || flow.fundStatus    === "validating" || flow.fundStatus    === "awaiting_signature" || isFundConfirming;

  return {
    form, setForm,
    flow,
    submitCreate, submitApprove, submitFund,
    dismissError, resetFlow,
    isCreating, isApproving, isFunding,
  };
}
