import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { api, ApiError } from "./api.js";
import type { Me } from "./types.js";

interface AuthState {
  me: Me | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: Infinity,
  });

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      // Update the "me" query in place (the provider is subscribed to it), then drop every other
      // cached query so no patient data lingers in memory. clear() would orphan the subscription.
      await queryClient.cancelQueries();
      queryClient.setQueryData(["me"], null);
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
      window.history.replaceState(null, "", "/");
    }
  };

  return (
    <AuthContext.Provider value={{ me: data ?? null, loading: isLoading, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
