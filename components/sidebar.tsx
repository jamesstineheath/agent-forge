"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  LayoutDashboard,
  FolderKanban,
  GitBranch,
  DollarSign,
  BookMarked,
  Bot,
  Anvil,
  Settings,
  ClipboardCheck,
  AlertTriangle,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useWorkItems } from "@/lib/hooks";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    label: "Workflow",
    items: [
      { label: "Dashboard", href: "/", icon: LayoutDashboard },
      { label: "Projects", href: "/projects", icon: ClipboardCheck },
      { label: "Work Items", href: "/work-items", icon: FolderKanban },
      { label: "Pipeline", href: "/pipeline", icon: GitBranch },
      { label: "Cost", href: "/cost", icon: DollarSign },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Agents", href: "/agents", icon: Bot },
      { label: "Repos", href: "/repos", icon: BookMarked },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

type HealthStatus = "healthy" | "error";

const healthConfig: Record<HealthStatus, { dotClass: string; labelClass: string }> = {
  healthy: { dotClass: "bg-status-merged animate-status-pulse", labelClass: "text-status-merged" },
  error: { dotClass: "bg-status-blocked animate-status-pulse", labelClass: "text-status-blocked" },
};

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex-1 px-3 pt-2 space-y-4" aria-label="Main navigation">
      {navSections.map((section) => (
        <div key={section.label}>
          <p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-all duration-150",
                      isActive
                        ? "bg-primary/10 text-primary shadow-sm ring-1 ring-primary/10"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    <item.icon className={cn("h-4 w-4", isActive && "text-primary")} />
                    {item.label}
                    {isActive && (
                      <div className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function HealthPanel() {
  const { data: workItems } = useWorkItems();

  const activeCount = (workItems ?? []).filter(
    (i) => i.status === "generating" || i.status === "executing" || i.status === "reviewing"
  ).length;
  const failedCount = (workItems ?? []).filter(
    (i) => i.status === "failed" || i.status === "blocked"
  ).length;

  let status: HealthStatus = "healthy";
  let label = "Healthy";
  let detail = `${activeCount} agent${activeCount !== 1 ? "s" : ""} executing.`;

  if (failedCount > 0) {
    status = "error";
    label = "Attention";
    detail = `${failedCount} failed/blocked. ${activeCount} executing.`;
  } else if (activeCount > 0) {
    detail = `${activeCount} agent${activeCount !== 1 ? "s" : ""} executing.`;
  }

  const health = healthConfig[status];

  const Wrapper = status === "error" ? Link : "div";
  const wrapperProps = status === "error"
    ? { href: "/work-items?status=failed,blocked" }
    : {};

  return (
    <Wrapper
      {...wrapperProps as any}
      className={cn(
        "rounded-lg p-3 block transition-colors",
        status === "healthy" && "bg-surface-2",
        status === "error" && "bg-status-blocked/[0.06] ring-1 ring-status-blocked/10 hover:bg-status-blocked/[0.1] cursor-pointer"
      )}
      role="status"
      aria-label={`System status: ${label}`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        {status === "error" ? (
          <AlertTriangle className="h-3 w-3 text-status-blocked" aria-hidden="true" />
        ) : (
          <div className={cn("h-2 w-2 rounded-full", health.dotClass)} aria-hidden="true" />
        )}
        <span className={cn("text-[11px] font-semibold", health.labelClass)}>
          {label}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        {detail}
      </p>
    </Wrapper>
  );
}

function DesktopSidebar() {
  return (
    <aside className="hidden md:flex h-screen w-[220px] flex-col border-r border-border bg-sidebar shrink-0">
      {/* Wordmark */}
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-sm">
          <Anvil className="h-4 w-4 text-primary-foreground" />
          <div className="absolute inset-0 rounded-lg bg-primary/20 blur-md" />
        </div>
        <div>
          <Link href="/" className="text-[15px] font-display font-bold tracking-tight text-foreground">
            Agent Forge
          </Link>
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Orchestrator
          </p>
        </div>
      </div>

      <NavLinks />

      {/* Footer */}
      <div className="space-y-3 px-4 pb-4">
        <HealthPanel />
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-[10px] font-mono font-medium text-muted-foreground/50 tracking-wide">
            v0.1.0
          </span>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex md:hidden items-center justify-between border-b border-border bg-sidebar px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
            <Anvil className="h-3.5 w-3.5 text-primary-foreground" />
          </div>
          <span className="text-[14px] font-display font-bold text-foreground">Agent Forge</span>
        </div>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger aria-label={open ? "Close menu" : "Open menu"}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 bg-sidebar border-border">
            <SheetHeader className="flex h-14 items-center border-b border-border px-4">
              <SheetTitle className="flex items-center gap-2 font-display font-bold text-foreground">
                <Anvil size={14} className="text-primary" />
                Agent Forge
              </SheetTitle>
            </SheetHeader>
            <div className="pt-4">
              <NavLinks onNavigate={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </>
  );
}

export function Sidebar() {
  return (
    <>
      <DesktopSidebar />
      <MobileNav />
    </>
  );
}

export default Sidebar;
