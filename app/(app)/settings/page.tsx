"use client";

import { SettingsKillSwitch } from "@/components/settings-kill-switch";
import { SettingsForceOpus } from "@/components/settings-force-opus";
import { SettingsForceSonnet } from "@/components/settings-force-sonnet";
import { SettingsConcurrency } from "@/components/settings-concurrency";

export default function SettingsPage() {
  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Settings</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              System-wide controls for the Agent Forge pipeline
            </p>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl space-y-6">
          <SettingsKillSwitch />
          <SettingsForceOpus />
          <SettingsForceSonnet />
          <SettingsConcurrency />
        </div>
      </div>
    </>
  );
}
