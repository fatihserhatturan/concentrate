export function withAuth(handler: (req: unknown, res: { status(code: number): { json(body: unknown): void } }) => Promise<void>) {
  return handler;
}
