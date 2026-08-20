import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const stats = [
  { id: "total", label: "Total", value: "0" },
  { id: "active", label: "Active", value: "0" },
  { id: "pending", label: "Pending", value: "0" },
  { id: "failed", label: "Failed", value: "0" },
];

export default function Page() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Overview</h1>
        <p className="text-muted-foreground text-sm">Replace this with your dashboard.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.id}>
            <CardHeader>
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="font-semibold text-2xl tabular-nums">{stat.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">No data yet</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
