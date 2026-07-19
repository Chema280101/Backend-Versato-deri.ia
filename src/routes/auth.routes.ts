import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { config } from '../config';
import { findUserByEmail } from '../services/db.service';
import { rateLimitMiddleware } from '../middlewares/rate-limit.middleware';

const router = Router();

router.post(
  '/auth/login',
  rateLimitMiddleware({
    windowMs: 60 * 1000,
    max: 10,
    message: 'Demasiados intentos de inicio de sesión. Por favor intente más tarde.',
  }),
  async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = await findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const isMatch = await bcryptjs.compare(password, user.passwordHash);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = jwt.sign(
      {
        business_id: user.businessId,
        user_id: user.id,
      },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn as any },
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        rol: user.rol,
        business_id: user.businessId,
      },
    });
  } catch (error) {
    console.error('[ERROR]: Auth login failed:', error);
    res.status(500).json({ error: 'Internal server error during authentication' });
  }
});

export default router;
