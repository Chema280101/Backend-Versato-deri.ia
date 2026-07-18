import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /health
 * Returns 200 OK with status and timestamp.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

export default router;
