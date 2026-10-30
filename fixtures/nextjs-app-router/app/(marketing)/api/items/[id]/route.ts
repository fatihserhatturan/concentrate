// An arrow handler under a route group: DELETE /api/items/[id].
export const DELETE = async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  return new Response(id, { status: 204 });
};

// Not an HTTP method: no route.
export function revalidate() {
  return 60;
}
