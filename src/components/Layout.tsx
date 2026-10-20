/**
 * Layout — sidebar nav (desktop) + mobile bottom tab bar.
 * Active link derived from current route.
 */
import { NavLink, useLocation } from "react-router-dom";
import { ConnectKitButton } from "connectkit";
import {
  LayoutDashboard,
  PlusCircle,
  Zap,
  List,
  Settings2,
  Menu,
  X,
  Code2,
} from "lucide-react";
import { useState } from "react";
import { NetworkBadge } from "./NetworkGuard";

const NAV = [
  { to: "/",             label: "Dashboard",    icon: LayoutDashboard },
  { to: "/create",       label: "New Budget",   icon: PlusCircle      },
  { to: "/playground",   label: "Playground",   icon: Zap             },
  { to: "/payments",     label: "History",      icon: List            },
  { to: "/integrations", label: "Integrations", icon: Code2           },
] as const;

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { pathname } = useLocation();

  const activeLabel = NAV.find(n =>
    n.to === "/" ? pathname === "/" : pathname.startsWith(n.to)
  )?.label ?? (pathname.startsWith("/sessions") ? "Session" : "BudgetRail");

  return (
    <div className="flex min-h-dvh">
      {/* ── Desktop sidebar ─────────────────────────────────────── */}
      <aside className="hidden lg:flex flex-col w-56 shrink-0 border-r border-[var(--border)]
                         bg-[rgba(13,27,47,0.8)] backdrop-blur-sm sticky top-0 h-screen">
        {/* Logo */}
        <div className="px-5 py-5 border-b border-[var(--border)]">
          <p className="display font-bold text-base text-[var(--ink)] tracking-tight">BudgetRail</p>
          <p className="text-xs text-[var(--subtle)] mt-0.5">USDC payment rail</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Main navigation">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors
                 ${isActive
                   ? "bg-[rgba(172,198,233,0.14)] text-[var(--accent)]"
                   : "text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)]"
                 }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Connect */}
        <div className="px-4 py-4 border-t border-[var(--border)] space-y-3">
          <NetworkBadge />
          <ConnectKitButton />
        </div>
      </aside>

      {/* ── Mobile drawer overlay ─────────────────────────────────── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0d1b2f] border-r border-[var(--border)]
                    flex flex-col transform transition-transform duration-200 lg:hidden
                    ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)]">
          <p className="display font-bold text-base text-[var(--ink)]">BudgetRail</p>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="text-[var(--subtle)] hover:text-[var(--ink)] transition-colors"
          >
            <X size={20} />
          </button>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors
                 ${isActive
                   ? "bg-[rgba(172,198,233,0.14)] text-[var(--accent)]"
                   : "text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)]"
                 }`
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-[var(--border)] space-y-3">
          <NetworkBadge />
          <ConnectKitButton />
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center justify-between px-4 py-3
                            border-b border-[var(--border)] bg-[rgba(13,27,47,0.9)] backdrop-blur-sm sticky top-0 z-30">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
          >
            <Menu size={22} />
          </button>
          <p className="display font-bold text-sm text-[var(--ink)]">{activeLabel}</p>
          <ConnectKitButton />
        </header>

        {/* Page area */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-5xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

// ── SessionLink helper used on sessions list ────────────────────────────────
export function SessionNavLink({ sessionId }: { sessionId: bigint }) {
  return (
    <NavLink
      to={`/sessions/${sessionId}`}
      className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]
                 transition-colors"
    >
      <Settings2 size={11} />
      Manage
    </NavLink>
  );
}
