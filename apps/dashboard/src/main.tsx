import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { ApiError } from "./lib/api.js";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { CallDetail } from "./pages/CallDetail.js";
import { Calls } from "./pages/Calls.js";
import { Login } from "./pages/Login.js";
import { Schedule } from "./pages/Schedule.js";
import { Screenings } from "./pages/Screenings.js";
import { Tasks } from "./pages/Tasks.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

function AppRoutes() {
  const { me, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/calls" element={<Calls />} />
        <Route path="/calls/:id" element={<CallDetail />} />
        <Route path="/screenings" element={<Screenings />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route
          path="*"
          element={<Navigate to={me.role === "technologist" ? "/screenings" : "/calls"} replace />}
        />
      </Route>
    </Routes>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
