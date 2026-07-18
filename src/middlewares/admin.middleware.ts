import { Request, Response, NextFunction } from 'express';
import { findUserById } from '../services/db.service';

export async function platformOperatorMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.userId;
  const businessId = req.businessId;

  if (!userId || !businessId) {
    res.status(401).json({ error: 'Access token is missing or invalid' });
    return;
  }

  // Multi-tenant check: only platform business (id = 1) is allowed
  if (businessId !== 1) {
    res.status(403).json({ error: 'Access denied: client businesses are not allowed' });
    return;
  }

  try {
    const user = await findUserById(userId);
    if (!user || user.rol !== 'operator') {
      res.status(403).json({ error: 'Access denied: operator role required' });
      return;
    }

    next();
  } catch (error) {
    console.error('[ERROR]: Error checking platform operator authorization:', error);
    res.status(500).json({ error: 'Internal server error during authorization' });
  }
}
