import { Router } from 'express';

function stats(req: unknown, res: { json(body: unknown): void }) {
  res.json({});
}

export const admin = Router();
admin.get('/stats', stats);
