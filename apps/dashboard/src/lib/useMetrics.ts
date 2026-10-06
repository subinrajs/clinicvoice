import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import type { Metrics } from "./types.js";

export const useMetrics = () =>
  useQuery({
    queryKey: ["metrics"],
    queryFn: () => api.get<Metrics>("/metrics"),
    refetchInterval: 60_000,
  });
