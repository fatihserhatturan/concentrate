import { createFileRoute } from "@tanstack/react-router";
import { PostView } from "../components/PostView";

export const Route = createFileRoute("/posts/$postId")({
  component: PostView,
});
