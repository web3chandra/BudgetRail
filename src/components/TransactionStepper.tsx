/**
 * TransactionStepper — inline multi-step transaction progress.
 * Never simulates progress — states come from real wagmi hooks.
 */
import { Check, Loader2, X, Clock } from "lucide-react";

export type StepStatus = "idle" | "active" | "success" | "error" | "skipped";

export interface Step {
  id:     string;
  label:  string;
  status: StepStatus;
  detail?: string;
}

interface TransactionStepperProps {
  steps:      Step[];
  className?: string;
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "success": return <Check size={14} className="text-[var(--success)]" />;
    case "error":   return <X     size={14} className="text-[var(--danger)]"  />;
    case "active":  return <Loader2 size={14} className="text-[var(--accent)] animate-spin" />;
    case "skipped": return <span className="w-3.5 h-3.5 text-[var(--subtle)]">—</span>;
    default:        return <Clock size={14} className="text-[var(--subtle)]" />;
  }
}

export function TransactionStepper({ steps, className = "" }: TransactionStepperProps) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {steps.map((step, i) => (
        <div key={step.id} className="flex items-start gap-3">
          {/* connector line */}
          <div className="flex flex-col items-center">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0
              ${step.status === "success" ? "bg-[rgba(141,216,159,0.15)]"
              : step.status === "error"   ? "bg-[rgba(232,109,122,0.15)]"
              : step.status === "active"  ? "bg-[rgba(172,198,233,0.15)]"
              : "bg-[var(--surface)]"}`}>
              <StepIcon status={step.status} />
            </div>
            {i < steps.length - 1 && (
              <div className="w-px h-4 bg-[var(--border)] mt-1" />
            )}
          </div>
          <div className="pb-1 min-w-0">
            <p className={`text-sm font-medium leading-tight
              ${step.status === "success" ? "text-[var(--success)]"
              : step.status === "error"   ? "text-[var(--danger)]"
              : step.status === "active"  ? "text-[var(--ink)]"
              : "text-[var(--subtle)]"}`}>
              {step.label}
            </p>
            {step.detail && (
              <p className="text-xs text-[var(--subtle)] mt-0.5 break-all mono">
                {step.detail}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
