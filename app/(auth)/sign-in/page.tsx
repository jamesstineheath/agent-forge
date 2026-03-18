"use client";

import { signIn } from "next-auth/react";
import { Zap } from "lucide-react";

export default function SignInPage() {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background dot-grid">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 h-[400px] w-[600px] rounded-full bg-primary/[0.04] blur-[100px]" />
      </div>

      <div className="relative z-10 w-full max-w-sm px-4">
        {/* Logo + wordmark */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg mb-4">
            <Zap className="h-7 w-7 text-primary-foreground" />
            <div className="absolute inset-0 rounded-2xl bg-primary/20 blur-lg" />
          </div>
          <h1 className="text-2xl font-display font-bold tracking-tight text-foreground">
            Agent Forge
          </h1>
          <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mt-1">
            Orchestrator
          </p>
        </div>

        {/* Sign-in card */}
        <div className="rounded-xl card-elevated bg-surface-1 p-6">
          <button
            onClick={() => signIn("google", { callbackUrl: "/" })}
            className="group flex w-full items-center justify-center gap-3 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-all hover:opacity-90 active:scale-[0.98]"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>
          <p className="mt-4 text-center text-[10px] text-muted-foreground/50">
            Authorized accounts only
          </p>
        </div>

        {/* Version */}
        <p className="mt-6 text-center text-[10px] font-mono text-muted-foreground/30">
          v0.1.0
        </p>
      </div>
    </div>
  );
}
