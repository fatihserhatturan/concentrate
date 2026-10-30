import type { NextApiHandler } from 'next';

export function withAuth(handler: NextApiHandler): NextApiHandler {
  return (req, res) => handler(req, res);
}
