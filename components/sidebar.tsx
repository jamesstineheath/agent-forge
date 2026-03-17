"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/work-items", label: "Work Items" },
  { href: "/work-items/escalated", label: "Escalated" },
  { href: "/agents", label: "Agents" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/repos", label: "Repos" },
  { href: "/settings", label: "Settings" },
];

function NavLinks({
  onNavigate,
  mobile = false,
}: {
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  const pathname = usePathname();

  return (
    <nav className={mobile ? "flex flex-col gap-1 p-4" : "flex-1 space-y-1 p-2"}>
      {navItems.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center rounded-md px-3 text-sm font-medium transition-colors ${
              mobile ? "min-h-[44px]" : "py-2"
            } ${
              isActive
                ? "bg-zinc-900 text-amber-400"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function DesktopSidebar() {
  return (
    <aside className="hidden md:flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-950 shrink-0">
      <div className="flex h-14 items-center border-b border-zinc-800 px-4 gap-2">
        <Zap size={14} className="text-amber-400" />
        <Link href="/" className="text-sm font-semibold text-zinc-200">
          Agent Forge
        </Link>
      </div>
      <NavLinks />
    </aside>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex md:hidden sticky top-0 z-40 h-14 items-center border-b border-zinc-800 bg-zinc-950 px-4">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger aria-label="Open navigation menu">
          <Menu className="h-5 w-5" />
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 bg-zinc-950 border-zinc-800">
          <SheetHeader className="flex h-14 items-center border-b border-zinc-800 px-4">
            <SheetTitle className="flex items-center gap-2 font-semibold text-zinc-200">
              <Zap size={14} className="text-amber-400" />
              Agent Forge
            </SheetTitle>
          </SheetHeader>
          <NavLinks mobile onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="ml-3 flex items-center gap-2">
        <Zap size={14} className="text-amber-400" />
        <span className="text-sm font-semibold text-zinc-200">Agent Forge</span>
      </span>
    </div>
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
