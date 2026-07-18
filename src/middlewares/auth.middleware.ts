import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Access token is missing or invalid' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, config.jwtSecret) as {
      business_id: number;
      user_id: number;
    };

    if (!payload.business_id || !payload.user_id) {
      res.status(401).json({ error: 'Invalid token payload format' });
      return;
    }

    req.businessId = payload.business_id;
    req.userId = payload.user_id;

    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
