import { QueryClient } from "@tanstack/react-query";

/**
 * One cache for the console. A request that a page asks for again while it is fresh is not sent
 * again; one that fails is shown at once, not retried.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: false, refetchOnWindowFocus: false },
  },
});
