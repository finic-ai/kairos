import { useMemo } from "react";
import { useLocation } from "react-router";

export function useRoute(): string[] {
  const { pathname } = useLocation();
  return useMemo(() => pathname.split("/").filter(Boolean).map(decodeURIComponent), [pathname]);
}
