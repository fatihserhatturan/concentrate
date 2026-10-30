import { withAuth } from '../../lib/auth';

// An anonymous arrow passed inline has no Function node: the route has no handler.
export default withAuth(async (req, res) => {
  res.status(200).json({ ok: true });
});
