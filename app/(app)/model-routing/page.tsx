import { ModelRoutingDashboard } from "@/app/components/model-routing-dashboard";

export const metadata = {
  title: "Model Routing Analytics | Agent Forge",
};

export default function ModelRoutingPage() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-foreground">
          Model Routing Analytics
        </h1>
        <p className="mt-2 text-muted-foreground">
          Per-model cost breakdown, daily spend, quality scores, and escalation
          rates across routing decisions.
        </p>
      </div>
      <ModelRoutingDashboard />
    </div>
  );
}
