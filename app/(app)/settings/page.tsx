import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <>
      <header className="sticky top-0 z-10 glass-header border-b border-border">
        <div className="flex items-center justify-between px-6 py-3.5">
          <div>
            <h1 className="text-lg font-display font-bold text-foreground">Settings</h1>
            <p className="text-[11px] font-medium text-muted-foreground">
              Global configuration
            </p>
          </div>
        </div>
      </header>

      <div className="p-4 md:p-6 dot-grid min-h-[calc(100vh-60px)]">
        <div className="max-w-5xl">
          <div className="rounded-xl card-elevated bg-surface-1 p-8 text-center">
            <Settings className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
            <p className="text-[14px] font-display font-bold text-foreground">Configuration</p>
            <p className="text-[12px] text-muted-foreground mt-1">
              Global settings, concurrency limits, and API keys. Coming soon.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
