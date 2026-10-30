import type { NextApiRequest, NextApiResponse } from 'next';

// An API route, not a page.
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json([]);
}
