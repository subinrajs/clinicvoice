import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

const TABLE_QUERIES: Record<string, string[][]> = {
  calls: [["calls"], ["call"], ["metrics"]],
  tasks: [["tasks"], ["metrics"], ["call"]],
  screenings: [["screenings"], ["metrics"]],
  appointments: [["schedule"]],
};

/** Subscribes to server-sent change events and refetches the affected views. */
export function useLiveUpdates(enabled: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/events", { withCredentials: true });
    source.addEventListener("change", (event) => {
      try {
        const { table } = JSON.parse((event as MessageEvent<string>).data) as { table: string };
        for (const key of TABLE_QUERIES[table] ?? [])
          void queryClient.invalidateQueries({ queryKey: key });
      } catch {
        // Ignore malformed events; the next poll or event will catch up.
      }
    });
    return () => source.close();
  }, [enabled, queryClient]);
}
