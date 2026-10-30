import { createFileRoute } from "@tanstack/react-router";

// posts_ un-nests: the URL keeps /posts, the layout does not wrap it.
export const Route = createFileRoute("/posts_/$postId/edit")({
  component: () => <form />,
});
