import { Router, Request, Response } from 'express';
import { rateLimitMiddleware } from '../middlewares/rate-limit.middleware';
import { sendAlert } from '../utils/notifier';

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

// Rate limit frontend errors: max 10 errors per minute per IP
const errorRateLimit = rateLimitMiddleware({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Demasiados reportes de error enviados. Por favor intente más tarde.',
});

/**
 * POST /health/report-error
 * Receives frontend runtime errors and reports them to the alert webhook.
 */
router.post('/health/report-error', errorRateLimit, async (req: Request, res: Response): Promise<void> => {
  try {
    const { message, stack, url } = req.body || {};

    if (!message) {
      res.status(400).json({ error: 'El campo "message" es obligatorio.' });
      return;
    }

    const alertMessage = 
      `• Mensaje: **${message}**\n` +
      `• URL: ${url || 'N/A'}\n` +
      `• Stack Trace:\n\`\`\`\n${stack ? stack.substring(0, 800) : 'No stack trace provided.'}\n\`\`\``;

    await sendAlert('Frontend Runtime Error Logged', alertMessage, 'error');

    res.status(200).json({ status: 'error_logged' });
  } catch (error) {
    console.error('[ERROR]: Failed to report frontend error:', error);
    res.status(500).json({ error: 'Internal server error while reporting error' });
  }
});

export default router;
