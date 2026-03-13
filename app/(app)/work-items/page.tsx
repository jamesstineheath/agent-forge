import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function WorkItemsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Work Items</h1>
      <Card>
        <CardHeader>
          <CardTitle>Backlog</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Work item store with CRUD, filtering, and dispatch. Coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
