import { Database } from "lucide-react";
import { Card, EmptyState } from "@/components/ui";

export function SetupNotice() {
  return (
    <Card>
      <EmptyState
        icon={<Database size={34} />}
        title="Connect the database to see live data"
        description={
          <>
            Add your Supabase <code className="font-mono">SUPABASE_SERVICE_ROLE_KEY</code> (Project Settings → API)
            to <code className="font-mono">.env.local</code>, then restart the dev server. The schema and the 5
            portal sources are already provisioned.
          </>
        }
      />
    </Card>
  );
}
