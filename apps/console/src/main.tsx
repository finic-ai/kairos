import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "./styles.css";
import "./appearance.css";
import { applyAppearance, applyTheme, readAppearance, readTheme } from "./theme";
import { queryClient } from "./lib/queryClient";
import { captureAuthError, captureSupabaseToken } from "./pages/Auth";
import { createRouter } from "./router";

applyTheme(readTheme());
applyAppearance(readAppearance());
captureSupabaseToken();
captureAuthError();
const router = createRouter();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
