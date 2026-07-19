import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { platformOperatorMiddleware } from '../middlewares/admin.middleware';
import { pool } from '../services/db.service';
import { sanitizeInput } from '../utils/sanitization';

const router = Router();

// Apply authMiddleware and platformOperatorMiddleware to all administrative routes
router.use(authMiddleware);
router.use(platformOperatorMiddleware);

/**
 * POST /admin/pricing
 * Adds or updates a messaging tariff. Updates any overlapping historical rate to prevent duplicate valid rates.
 */
router.post('/admin/pricing', async (req: Request, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    const { pais, categoria, tarifa_usd, vigente_desde, vigente_hasta } = req.body;

    // Validation
    if (!pais || typeof pais !== 'string' || pais.trim() === '') {
      res.status(400).json({ error: 'Field "pais" is required and must be a non-empty string' });
      return;
    }

    const sanitizedPais = sanitizeInput(pais);

    const validCategories = ['marketing', 'utilidad', 'servicio', 'autenticacion'];
    if (!categoria || !validCategories.includes(categoria)) {
      res.status(400).json({ error: `Field "categoria" must be one of: ${validCategories.join(', ')}` });
      return;
    }

    if (tarifa_usd === undefined || typeof tarifa_usd !== 'number' || tarifa_usd < 0) {
      res.status(400).json({ error: 'Field "tarifa_usd" is required and must be a non-negative number' });
      return;
    }

    const desde = vigente_desde ? new Date(vigente_desde) : new Date();
    if (isNaN(desde.getTime())) {
      res.status(400).json({ error: 'Field "vigente_desde" is an invalid date format' });
      return;
    }

    let hasta: Date | null = null;
    if (vigente_hasta) {
      hasta = new Date(vigente_hasta);
      if (isNaN(hasta.getTime())) {
        res.status(400).json({ error: 'Field "vigente_hasta" is an invalid date format' });
        return;
      }
      if (desde > hasta) {
        res.status(400).json({ error: '"vigente_desde" cannot be later than "vigente_hasta"' });
        return;
      }
    }

    await client.query('BEGIN');

    // Capping previous active rate(s) to avoid overlapping
    const updateQuery = `
      UPDATE pricing_config
      SET vigente_hasta = $3
      WHERE pais = $1 AND categoria = $2
        AND vigente_desde < $3
        AND (vigente_hasta IS NULL OR vigente_hasta > $3);
    `;
    await client.query(updateQuery, [sanitizedPais, categoria, desde]);

    // Insert the new rate
    const insertQuery = `
      INSERT INTO pricing_config (pais, categoria, tarifa_usd, vigente_desde, vigente_hasta)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, pais, categoria, tarifa_usd, vigente_desde, vigente_hasta;
    `;
    const result = await client.query(insertQuery, [sanitizedPais, categoria, tarifa_usd, desde, hasta]);

    await client.query('COMMIT');

    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[ERROR]: Failed to update pricing config:', error);
    res.status(500).json({ error: 'Internal server error while saving pricing configuration' });
  } finally {
    client.release();
  }
});

/**
 * GET /admin/pricing
 * Retrieve all historical rates, ordered by country, category and date.
 */
router.get('/admin/pricing', async (_req: Request, res: Response): Promise<void> => {
  try {
    const query = `
      SELECT id, pais, categoria, tarifa_usd, vigente_desde, vigente_hasta
      FROM pricing_config
      ORDER BY pais ASC, categoria ASC, vigente_desde ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch pricing config:', error);
    res.status(500).json({ error: 'Internal server error while fetching pricing configurations' });
  }
});

export default router;
