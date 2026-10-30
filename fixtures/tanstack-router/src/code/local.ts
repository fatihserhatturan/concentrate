// A local createRoute, not TanStack's: no pages.
function createRoute(options: { path: string }) {
  return options;
}

export const route = createRoute({ path: "/local" });
