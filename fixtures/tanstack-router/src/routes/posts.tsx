import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/posts")({
  loader: () => fetch("/api/posts"),
  component: function PostsLayout() {
    return <Outlet />;
  },
});
