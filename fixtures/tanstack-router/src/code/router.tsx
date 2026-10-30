import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";
import { PostView } from "../components/PostView";

type Context = { userId: string | null };

function Shell() {
  return <main />;
}

function Settings() {
  return <form />;
}

function Profile() {
  return <section />;
}

// Code routes: paths join through getParentRoute.
const rootRoute = createRootRouteWithContext<Context>()({ component: Shell });

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: Settings,
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: Settings,
});

const accountLayout = createRoute({
  getParentRoute: () => settingsRoute,
  id: "account",
});

const profileRoute = createRoute({
  getParentRoute: () => accountLayout,
  path: "profile/$userId",
  component: Profile,
});

const postRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$postId",
  component: PostView,
});

const routeTree = rootRoute.addChildren([
  settingsRoute.addChildren([settingsIndexRoute, accountLayout.addChildren([profileRoute])]),
  postRoute,
]);

export const router = createRouter({ routeTree });
