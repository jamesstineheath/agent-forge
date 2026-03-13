import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PipelinePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Pipeline</h1>
      <Card>
        <CardHeader>
          <CardTitle>Active Executions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Pipeline monitoring, ATC decisions, and execution queue. Coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
