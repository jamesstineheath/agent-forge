import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ReposPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Repos</h1>
      <Card>
        <CardHeader>
          <CardTitle>Registered Repositories</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Target repo registration and configuration. Coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
