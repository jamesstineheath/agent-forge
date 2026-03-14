"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { RepoConfig } from "@/lib/types";

interface RepoFormProps {
  existing?: RepoConfig;
  onSuccess?: () => void;
}

interface FormState {
  fullName: string;
  shortName: string;
  claudeMdPath: string;
  systemMapPath: string;
  adrPath: string;
  handoffDir: string;
  executeWorkflow: string;
  concurrencyLimit: string;
  defaultBudget: string;
}

function defaultState(existing?: RepoConfig): FormState {
  return {
    fullName: existing?.fullName ?? "",
    shortName: existing?.shortName ?? "",
    claudeMdPath: existing?.claudeMdPath ?? "CLAUDE.md",
    systemMapPath: existing?.systemMapPath ?? "",
    adrPath: existing?.adrPath ?? "",
    handoffDir: existing?.handoffDir ?? "handoffs/",
    executeWorkflow: existing?.executeWorkflow ?? "execute-handoff.yml",
    concurrencyLimit: String(existing?.concurrencyLimit ?? 1),
    defaultBudget: String(existing?.defaultBudget ?? 5),
  };
}

export function RepoForm({ existing, onSuccess }: RepoFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => defaultState(existing));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body = {
      fullName: form.fullName,
      shortName: form.shortName,
      claudeMdPath: form.claudeMdPath,
      systemMapPath: form.systemMapPath || undefined,
      adrPath: form.adrPath || undefined,
      handoffDir: form.handoffDir,
      executeWorkflow: form.executeWorkflow,
      concurrencyLimit: parseInt(form.concurrencyLimit, 10),
      defaultBudget: parseFloat(form.defaultBudget),
    };

    const url = existing ? `/api/repos/${existing.id}` : "/api/repos";
    const method = existing ? "PATCH" : "POST";

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save repo");
      }

      if (onSuccess) {
        onSuccess();
      } else {
        router.push("/repos");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save repo");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{existing ? "Edit Repo" : "Add Repo"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="fullName">
                Full Name <span className="text-red-500">*</span>
              </label>
              <Input
                id="fullName"
                name="fullName"
                placeholder="owner/repo"
                value={form.fullName}
                onChange={handleChange}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="shortName">
                Short Name <span className="text-red-500">*</span>
              </label>
              <Input
                id="shortName"
                name="shortName"
                placeholder="repo"
                value={form.shortName}
                onChange={handleChange}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="claudeMdPath">
                CLAUDE.md Path
              </label>
              <Input
                id="claudeMdPath"
                name="claudeMdPath"
                value={form.claudeMdPath}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="handoffDir">
                Handoff Dir
              </label>
              <Input
                id="handoffDir"
                name="handoffDir"
                value={form.handoffDir}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="systemMapPath">
                System Map Path
              </label>
              <Input
                id="systemMapPath"
                name="systemMapPath"
                placeholder="docs/SYSTEM_MAP.md"
                value={form.systemMapPath}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="adrPath">
                ADR Path
              </label>
              <Input
                id="adrPath"
                name="adrPath"
                placeholder="docs/adr/"
                value={form.adrPath}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="executeWorkflow">
                Execute Workflow
              </label>
              <Input
                id="executeWorkflow"
                name="executeWorkflow"
                value={form.executeWorkflow}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="concurrencyLimit">
                Concurrency Limit
              </label>
              <Input
                id="concurrencyLimit"
                name="concurrencyLimit"
                type="number"
                min={1}
                value={form.concurrencyLimit}
                onChange={handleChange}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="defaultBudget">
                Default Budget ($)
              </label>
              <Input
                id="defaultBudget"
                name="defaultBudget"
                type="number"
                min={0}
                step={0.5}
                value={form.defaultBudget}
                onChange={handleChange}
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : existing ? "Save Changes" : "Add Repo"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push("/repos")}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
