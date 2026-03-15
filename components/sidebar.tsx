"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Zap } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/work-items", label: "Work Items" },
  { href: "/agents", label: "Agents" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/repos", label: "Repos" },
  { href: "/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-56 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex h-14 items-center border-b border-zinc-800 px-4 gap-2">
        <Zap size={14} className="text-amber-400" />
        <Link href="/" className="text-sm font-semibold text-zinc-200">
          Agent Forge
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors ${
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
    </aside>
  );
}
