import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  message: string;
}

const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export function rateLimitMiddleware(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // In test environment, bypass rate limits unless specifically testing the rate limits
    if (process.env.NODE_ENV === 'test' && req.headers['x-test-rate-limit'] !== 'true') {
      next();
      return;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    // Key by IP and request path so they are rate-limited per endpoint
    const key = `${ip}:${req.baseUrl || ''}${req.path}`;
    const now = Date.now();

    const record = rateLimitStore.get(key);

    if (!record) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + options.windowMs,
      });
      next();
      return;
    }

    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + options.windowMs;
      next();
      return;
    }

    record.count++;
    if (record.count > options.max) {
      res.status(429).json({ error: options.message });
      return;
    }

    next();
  };
}
