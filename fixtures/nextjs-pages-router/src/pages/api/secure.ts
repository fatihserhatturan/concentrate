import type { NextApiHandler } from 'next';
import { withAuth } from '../../lib/auth';

// Wrapped: handled by the wrapped function.
const handler: NextApiHandler = (req, res) => {
  res.status(200).json({ ok: true });
};

export default withAuth(handler);
