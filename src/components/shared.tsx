/**
 * Shared UI primitives: Skeleton, EmptyState, ErrorBanner, ConfirmModal, Spinner.
 */
import { AlertCircle, Inbox } from "lucide-react";

// ── Skeleton ────────────────────────────────────────────────────────────────

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      className={`bg-[var(--surface-strong)] rounded animate-pulse ${className}`}
      aria-hidden="true"
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

// ── EmptyState ──────────────────────────────────────────────────────────────

interface EmptyStateProps {
  title:    string;
  body?:    string;
  action?:  React.ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
      <Inbox size={36} className="text-[var(--subtle)]" strokeWidth={1.25} />
      <div className="space-y-1 max-w-xs">
        <p className="font-semibold text-[var(--ink-2)]">{title}</p>
        {body && <p className="text-sm text-[var(--subtle)] text-pretty">{body}</p>}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

// ── ErrorBanner ─────────────────────────────────────────────────────────────

interface ErrorBannerProps {
  message:    string;
  onDismiss?: () => void;
  className?: string;
}

export function ErrorBanner({ message, onDismiss, className = "" }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border border-[var(--danger)]
                  bg-[rgba(232,109,122,0.08)] px-4 py-3 ${className}`}
    >
      <AlertCircle size={16} className="shrink-0 text-[var(--danger)] mt-0.5" />
      <p className="text-sm text-[var(--ink-2)] flex-1 text-pretty">{message}</p>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-[var(--subtle)] hover:text-[var(--ink)] transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── ConfirmModal ─────────────────────────────────────────────────────────────

interface ConfirmModalProps {
  title:     string;
  body:      React.ReactNode;
  confirmLabel?: string;
  cancelLabel?:  string;
  onConfirm: () => void;
  onCancel:  () => void;
  danger?:   boolean;
}

export function ConfirmModal({
  title, body, confirmLabel = "Confirm", cancelLabel = "Cancel",
  onConfirm, onCancel, danger = false,
}: ConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative w-full max-w-md rounded-2xl border border-[var(--border-strong)]
                      bg-[#1a2d45] p-6 space-y-4 shadow-2xl">
        <h2
          id="confirm-modal-title"
          className="display font-bold text-lg text-[var(--ink)] leading-tight"
        >
          {title}
        </h2>
        <div className="text-sm text-[var(--muted)] text-pretty">{body}</div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-[var(--border)] bg-transparent
                       px-4 py-2.5 text-sm font-semibold text-[var(--ink-2)]
                       hover:bg-[var(--surface)] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors
              ${danger
                ? "bg-[var(--danger)] text-white hover:opacity-90"
                : "bg-[var(--accent)] text-[#0d1b2f] hover:bg-[var(--accent-hover)]"
              }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────

export function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className={`animate-spin ${className}`}
      aria-hidden="true"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" opacity="0.3" />
      <path d="M12 2v4" />
    </svg>
  );
}

// ── StatusBadge ────────────────────────────────────────────────────────────

type BadgeStatus = "active" | "expired" | "closed";

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const styles: Record<BadgeStatus, string> = {
    active:  "bg-[rgba(141,216,159,0.15)] text-[var(--success)]",
    expired: "bg-[rgba(148,163,184,0.15)] text-[var(--subtle)]",
    closed:  "bg-[rgba(232,109,122,0.12)] text-[var(--danger)]",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        status === "active" ? "bg-[var(--success)]" : status === "closed" ? "bg-[var(--danger)]" : "bg-[var(--subtle)]"
      }`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
