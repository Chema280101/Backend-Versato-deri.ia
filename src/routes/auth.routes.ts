import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { config } from '../config';
import { findUserByEmail, findUserById, updateUser } from '../services/db.service';
import { rateLimitMiddleware } from '../middlewares/rate-limit.middleware';
import { authMiddleware } from '../middlewares/auth.middleware';

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

router.put('/auth/profile', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const { nombre, password, avatar } = req.body;

    const user = await findUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const updates: {
      nombre?: string;
      passwordHash?: string;
      avatar?: string | null;
      nombreLastChangedAt?: Date;
    } = {};

    // 1. Nombre validation (change limit of 14 days)
    if (nombre !== undefined && nombre.trim() !== '' && nombre !== user.nombre) {
      if (user.nombreLastChangedAt) {
        const lastChanged = new Date(user.nombreLastChangedAt);
        const diffMs = Date.now() - lastChanged.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        
        if (diffDays < 14) {
          const remainingDays = Math.ceil(14 - diffDays);
          res.status(400).json({ 
            error: `Por seguridad, solo puedes cambiar tu nombre cada 14 días. Faltan ${remainingDays} día(s).` 
          });
          return;
        }
      }
      updates.nombre = nombre.trim();
      updates.nombreLastChangedAt = new Date();
    }

    // 2. Password update
    if (password !== undefined && password.trim() !== '') {
      if (password.length < 6) {
        res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        return;
      }
      updates.passwordHash = await bcryptjs.hash(password, 10);
    }

    // 3. Avatar update
    if (avatar !== undefined) {
      updates.avatar = avatar; // Base64 or null
    }

    if (Object.keys(updates).length > 0) {
      await updateUser(userId, updates);
    }

    // Retrieve updated user to return
    const updatedUser = await findUserById(userId);
    if (!updatedUser) {
      res.status(500).json({ error: 'Error al recuperar el usuario actualizado' });
      return;
    }

    res.json({
      message: 'Perfil actualizado con éxito',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        nombre: updatedUser.nombre,
        rol: updatedUser.rol,
        business_id: updatedUser.businessId,
        avatar: updatedUser.avatar,
        nombre_last_changed_at: updatedUser.nombreLastChangedAt
      }
    });
  } catch (error) {
    console.error('[ERROR]: Profile update failed:', error);
    res.status(500).json({ error: 'Internal server error during profile update' });
  }
});

export default router;
