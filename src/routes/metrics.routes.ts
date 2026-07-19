import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import { pool } from '../services/db.service';

const router = Router();

// Secure all routes with authentication middleware
router.use(authMiddleware);

/**
 * Parses and validates date parameters.
 */
function getDates(req: Request): { desde: Date; hasta: Date; error?: string } {
  const now = new Date();
  const defaultDesde = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  let desde = defaultDesde;
  if (req.query.desde) {
    desde = new Date(req.query.desde as string);
    if (isNaN(desde.getTime())) {
      return { desde, hasta: now, error: 'Parámetro "desde" tiene un formato de fecha inválido' };
    }
  }

  let hasta = now;
  if (req.query.hasta) {
    hasta = new Date(req.query.hasta as string);
    if (isNaN(hasta.getTime())) {
      return { desde, hasta: now, error: 'Parámetro "hasta" tiene un formato de fecha inválido' };
    }
  }

  if (desde > hasta) {
    return { desde, hasta, error: 'La fecha "desde" no puede ser posterior a la fecha "hasta"' };
  }

  return { desde, hasta };
}

/**
 * GET /metrics/ventas
 * Returns total confirmed orders, total amount sold, average ticket, conversion rate, and traceability list.
 */
router.get('/metrics/ventas', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Total confirmed orders, total sold, avg ticket
    const salesRes = await pool.query(
      `SELECT 
         COUNT(id)::int AS total_pedidos_confirmados,
         COALESCE(SUM(total), 0)::float AS monto_total_vendido,
         COALESCE(AVG(total), 0)::float AS ticket_promedio
       FROM orders
       WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3;`,
      [businessId, desde, hasta]
    );

    // Conversion rate denominator (total initiated conversations in the range)
    const initiatedRes = await pool.query(
      `SELECT COUNT(id)::int AS total_iniciadas 
       FROM conversations 
       WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3;`,
      [businessId, desde, hasta]
    );

    // Conversion rate numerator (conversations initiated in the range that reached confirmed status)
    const convertedRes = await pool.query(
      `SELECT COUNT(DISTINCT c.id)::int AS total_convertidas 
       FROM conversations c
       WHERE c.business_id = $1 
         AND c.created_at >= $2 
         AND c.created_at <= $3
         AND (
           c.sales_state IN ('confirmado', 'postventa') 
           OR EXISTS (SELECT 1 FROM orders o WHERE o.conversation_id = c.id)
           OR EXISTS (SELECT 1 FROM conversation_traces t WHERE t.conversation_id = c.id AND t.sales_state_after = 'confirmado')
         );`,
      [businessId, desde, hasta]
    );

    // Traceability list of orders
    const detailsRes = await pool.query(
      `SELECT id, conversation_id, total::float as total, created_at
       FROM orders
       WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at DESC;`,
      [businessId, desde, hasta]
    );

    const totalIniciadas = initiatedRes.rows[0].total_iniciadas;
    const totalConvertidas = convertedRes.rows[0].total_convertidas;
    const tasaConversion = totalIniciadas > 0 ? (totalConvertidas / totalIniciadas) : 0.0;

    res.json({
      total_pedidos_confirmados: salesRes.rows[0].total_pedidos_confirmados,
      monto_total_vendido: salesRes.rows[0].monto_total_vendido,
      ticket_promedio: salesRes.rows[0].ticket_promedio,
      tasa_conversion: tasaConversion,
      detalle_pedidos: detailsRes.rows,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to fetch sales metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching sales metrics' });
  }
});

/**
 * GET /metrics/operacion
 * Returns average bot response time, escalation rates grouped by reason, average time spent in pause state, and totals.
 */
router.get('/metrics/operacion', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // 1. Average bot response time (in seconds)
    const responseTimeRes = await pool.query(
      `WITH first_user_msg AS (
         SELECT conversation_id, MIN(created_at) AS first_user_time
         FROM messages
         WHERE sender = 'user' AND business_id = $1
         GROUP BY conversation_id
       ),
       first_bot_msg AS (
         SELECT m.conversation_id, MIN(m.created_at) AS first_bot_time
         FROM messages m
         INNER JOIN first_user_msg fum ON m.conversation_id = fum.conversation_id
         WHERE m.sender = 'bot' AND m.created_at > fum.first_user_time AND m.business_id = $1
         GROUP BY m.conversation_id
       )
       SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (fbm.first_bot_time - fum.first_user_time))), 0)::float AS avg_first_response_seconds
       FROM first_user_msg fum
       INNER JOIN first_bot_msg fbm ON fum.conversation_id = fbm.conversation_id
       WHERE fum.first_user_time >= $2 AND fum.first_user_time <= $3;`,
      [businessId, desde, hasta]
    );

    // 2. Escalation rates
    const totalConvsRes = await pool.query(
      `SELECT COUNT(DISTINCT id)::int AS total FROM conversations 
       WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3;`,
      [businessId, desde, hasta]
    );

    const escalationsRes = await pool.query(
      `WITH escalated_conversations AS (
         SELECT DISTINCT ON (conversation_id) conversation_id, escalation_reason, created_at
         FROM conversation_traces
         WHERE business_id = $1 AND escalation_triggered = TRUE
         ORDER BY conversation_id, created_at ASC
       )
       SELECT 
         COALESCE(escalation_reason, 'No especificado') AS reason,
         COUNT(*)::int AS count
       FROM escalated_conversations
       WHERE created_at >= $2 AND created_at <= $3
       GROUP BY escalation_reason;`,
      [businessId, desde, hasta]
    );

    // 3. Average time spent in "pausada_humano" (in seconds)
    const pauseDurationRes = await pool.query(
      `WITH pause_starts AS (
         SELECT id, conversation_id, created_at AS paused_at
         FROM conversation_traces
         WHERE business_id = $1 
           AND status_after = 'pausada_humano'
           AND status_before != 'pausada_humano'
       ),
       pause_ends AS (
         SELECT 
           ps.conversation_id,
           ps.paused_at,
           (
             SELECT MIN(created_at) 
             FROM conversation_traces ct
             WHERE ct.conversation_id = ps.conversation_id
               AND ct.created_at > ps.paused_at
               AND ct.status_before = 'pausada_humano'
               AND ct.status_after != 'pausada_humano'
           ) AS resumed_at
         FROM pause_starts ps
       )
       SELECT 
         COALESCE(AVG(EXTRACT(EPOCH FROM (resumed_at - paused_at))), 0)::float AS avg_paused_seconds
       FROM pause_ends
       WHERE resumed_at IS NOT NULL
         AND paused_at >= $2 
         AND paused_at <= $3;`,
      [businessId, desde, hasta]
    );

    const totalConvs = totalConvsRes.rows[0].total;
    const escalados = escalationsRes.rows.map((row: any) => {
      const percentage = totalConvs > 0 ? (row.count / totalConvs) * 100 : 0.0;
      return {
        motivo: row.reason,
        cantidad: row.count,
        porcentaje: parseFloat(percentage.toFixed(2)),
      };
    });

    const totalEscalated = escalationsRes.rows.reduce((sum: number, row: any) => sum + row.count, 0);
    const totalEscalatedPercentage = totalConvs > 0 ? (totalEscalated / totalConvs) * 100 : 0.0;

    res.json({
      tiempo_promedio_respuesta_bot_segundos: responseTimeRes.rows[0].avg_first_response_seconds,
      porcentaje_conversaciones_escaladas: parseFloat(totalEscalatedPercentage.toFixed(2)),
      escalamientos_por_motivo: escalados,
      tiempo_promedio_pausa_humano_segundos: pauseDurationRes.rows[0].avg_paused_seconds,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to fetch operations metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching operations metrics' });
  }
});

/**
 * GET /metrics/costos
 * Returns total messages sent grouped by category and cost, total estimated period cost, and details list.
 */
router.get('/metrics/costos', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Cost by category
    const costByCategoryRes = await pool.query(
      `SELECT 
         COALESCE(category, 'servicio') AS category,
         COUNT(id)::int AS total_mensajes,
         COALESCE(SUM(cost), 0)::float AS costo_total
       FROM messages
       WHERE business_id = $1 
         AND sender = 'bot'
         AND created_at >= $2 
         AND created_at <= $3
       GROUP BY category;`,
      [businessId, desde, hasta]
    );

    // Overall total cost
    const totalCostRes = await pool.query(
      `SELECT COALESCE(SUM(cost), 0)::float AS costo_total_estimado
       FROM messages
       WHERE business_id = $1 
         AND sender = 'bot'
         AND created_at >= $2 
         AND created_at <= $3;`,
      [businessId, desde, hasta]
    );

    // Detailed message logs for audit/traceability
    const detailsRes = await pool.query(
      `SELECT id, conversation_id, category, cost::float as cost, created_at, generated_by
       FROM messages
       WHERE business_id = $1 
         AND sender = 'bot'
         AND created_at >= $2 
         AND created_at <= $3
       ORDER BY created_at DESC;`,
      [businessId, desde, hasta]
    );

    res.json({
      mensajes_por_categoria: costByCategoryRes.rows.map((row: any) => ({
        categoria: row.category,
        cantidad: row.total_mensajes,
        costo_sumado: row.costo_total,
      })),
      costo_total_estimado: totalCostRes.rows[0].costo_total_estimado,
      detalle_costos: detailsRes.rows,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to fetch cost metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching cost metrics' });
  }
});

/**
 * GET /metrics/satisfaccion
 * Returns average rating, rating count, and rating distribution (1 to 5 stars).
 */
router.get('/metrics/satisfaccion', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Average rating
    const satisfaccionRes = await pool.query(
      `SELECT 
         COALESCE(AVG(calificacion), 0)::float AS promedio_calificacion,
         COUNT(id)::int AS total_calificaciones
       FROM satisfaction_ratings
       WHERE business_id = $1 
         AND calificacion IS NOT NULL
         AND created_at >= $2 
         AND created_at <= $3;`,
      [businessId, desde, hasta]
    );

    // Distribution
    const distRes = await pool.query(
      `SELECT 
         calificacion,
         COUNT(id)::int AS count
       FROM satisfaction_ratings
       WHERE business_id = $1 
         AND calificacion IS NOT NULL
         AND created_at >= $2 
         AND created_at <= $3
       GROUP BY calificacion
       ORDER BY calificacion ASC;`,
      [businessId, desde, hasta]
    );

    const distribucion: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    distRes.rows.forEach((row: any) => {
      const rating = parseInt(row.calificacion, 10);
      if (rating >= 1 && rating <= 5) {
        distribucion[rating] = row.count;
      }
    });

    res.json({
      promedio_calificacion: satisfaccionRes.rows[0].promedio_calificacion,
      total_calificaciones: satisfaccionRes.rows[0].total_calificaciones,
      distribucion,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to fetch satisfaction metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching satisfaction metrics' });
  }
});

/**
 * GET /metrics/postventa
 * Returns repurchase rate and the count of low ratings without subsequent human follow-up.
 */
router.get('/metrics/postventa', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Repurchase stats
    const repurchaseRes = await pool.query(
      `WITH customer_orders AS (
         SELECT conversation_id, COUNT(id) AS order_count
         FROM orders
         WHERE business_id = $1 
           AND created_at >= $2 
           AND created_at <= $3
         GROUP BY conversation_id
       )
       SELECT 
         COUNT(CASE WHEN order_count > 1 THEN 1 END)::int AS clientes_recompra,
         COUNT(conversation_id)::int AS total_clientes_compradores
       FROM customer_orders;`,
      [businessId, desde, hasta]
    );

    // Low satisfaction alerts without human operator message follow-up
    const alertsRes = await pool.query(
      `SELECT COUNT(sr.id)::int AS alertas_sin_seguimiento
       FROM satisfaction_ratings sr
       WHERE sr.business_id = $1
         AND sr.calificacion IN (1, 2)
         AND sr.created_at >= $2
         AND sr.created_at <= $3
         AND NOT EXISTS (
           SELECT 1 
           FROM messages m
           WHERE m.conversation_id = sr.conversation_id
             AND m.created_at > sr.created_at
             AND m.generated_by = 'humano'
         );`,
      [businessId, desde, hasta]
    );

    const recompra = repurchaseRes.rows[0];
    const totalCompradores = recompra.total_clientes_compradores;
    const clientesRecompra = recompra.clientes_recompra;
    const tasaRecompra = totalCompradores > 0 ? (clientesRecompra / totalCompradores) : 0.0;

    res.json({
      tasa_recompra: tasaRecompra,
      total_clientes_compradores: totalCompradores,
      clientes_recompra: clientesRecompra,
      alertas_satisfaccion_sin_seguimiento: alertsRes.rows[0].alertas_sin_seguimiento,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to fetch post-sales metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching post-sales metrics' });
  }
});

/**
 * GET /metrics/embudo
 * Returns conversation count by stage in the state machine for the business in the date range.
 */
router.get('/metrics/embudo', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    const funnelRes = await pool.query(
      `WITH convs_in_range AS (
         SELECT id FROM conversations WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3
       ),
       reached_stages AS (
         SELECT id AS conversation_id, sales_state AS stage FROM conversations WHERE id IN (SELECT id FROM convs_in_range)
         UNION
         SELECT conversation_id, sales_state_after AS stage FROM conversation_traces WHERE conversation_id IN (SELECT id FROM convs_in_range)
       )
       SELECT stage, COUNT(DISTINCT conversation_id)::int AS count, COALESCE(ARRAY_AGG(DISTINCT conversation_id), '{}') AS conversation_ids
       FROM reached_stages
       GROUP BY stage;`,
      [businessId, desde, hasta]
    );

    res.json(funnelRes.rows);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch funnel metrics:', error);
    res.status(500).json({ error: 'Internal server error while fetching funnel metrics' });
  }
});

/**
 * GET /metrics/exportar-csv
 * Downloads a CSV file with raw data for the selected date range:
 *   - Sheet 1 (section): Confirmed orders with traceability to conversation
 *   - Sheet 2 (section): Bot outgoing messages with category and cost (traceable to message id)
 *   - Sheet 3 (section): Satisfaction ratings with conversation_id
 *
 * Multi-tenant: filtered strictly by business_id from auth token.
 * Cost data uses the stored cost at send time (not retroactively recalculated).
 */
router.get('/metrics/exportar-csv', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const { desde, hasta, error } = getDates(req);

    if (error) {
      res.status(400).json({ error });
      return;
    }

    // 1. Raw orders
    const ordersRes = await pool.query(
      `SELECT 
         id AS pedido_id,
         conversation_id,
         total::float AS total_soles,
         created_at AS fecha_pedido
       FROM orders
       WHERE business_id = $1
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY created_at ASC;`,
      [businessId, desde, hasta]
    );

    // 2. Bot outgoing messages with stored cost (traceable to message id)
    const messagesRes = await pool.query(
      `SELECT 
         id AS mensaje_id,
         conversation_id,
         COALESCE(category, 'servicio') AS categoria,
         COALESCE(cost, 0)::float AS costo_usd,
         created_at AS fecha_mensaje
       FROM messages
       WHERE business_id = $1
         AND sender = 'bot'
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY created_at ASC;`,
      [businessId, desde, hasta]
    );

    // 3. Satisfaction ratings
    const ratingsRes = await pool.query(
      `SELECT 
         id AS calificacion_id,
         conversation_id,
         calificacion AS estrellas,
         created_at AS fecha_calificacion
       FROM satisfaction_ratings
       WHERE business_id = $1
         AND calificacion IS NOT NULL
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY created_at ASC;`,
      [businessId, desde, hasta]
    );

    // Helper: convert array of objects to CSV rows
    const toCsvRows = (rows: Record<string, any>[]): string => {
      if (rows.length === 0) return '';
      const headers = Object.keys(rows[0]);
      const escape = (val: any): string => {
        const str = val === null || val === undefined ? '' : String(val);
        // Wrap in quotes if it contains commas, quotes, or newlines
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      const headerLine = headers.map(escape).join(',');
      const dataLines = rows.map(row => headers.map(h => escape(row[h])).join(','));
      return [headerLine, ...dataLines].join('\n');
    };

    const desdeStr = desde.toISOString().split('T')[0];
    const hastaStr = hasta.toISOString().split('T')[0];

    // Build unified CSV with labeled sections
    const sections: string[] = [];

    sections.push(`# REPORTE DE DATOS CRUDOS`);
    sections.push(`# Negocio ID: ${businessId}`);
    sections.push(`# Rango: ${desdeStr} al ${hastaStr}`);
    sections.push(`# Generado: ${new Date().toISOString()}`);
    sections.push('');

    sections.push(`## SECCION: PEDIDOS (${ordersRes.rows.length} registros)`);
    sections.push(toCsvRows(ordersRes.rows) || '(sin datos)');
    sections.push('');

    sections.push(`## SECCION: MENSAJES BOT CON COSTO (${messagesRes.rows.length} registros)`);
    sections.push(toCsvRows(messagesRes.rows) || '(sin datos)');
    sections.push('');

    sections.push(`## SECCION: CALIFICACIONES DE SATISFACCION (${ratingsRes.rows.length} registros)`);
    sections.push(toCsvRows(ratingsRes.rows) || '(sin datos)');

    const csvContent = sections.join('\n');

    const filename = `reporte_${businessId}_${desdeStr}_${hastaStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Add BOM for Excel UTF-8 compatibility
    res.send('\uFEFF' + csvContent);
  } catch (error) {
    console.error('[ERROR]: Failed to export CSV:', error);
    res.status(500).json({ error: 'Internal server error while exporting CSV' });
  }
});

/**
 * GET /metrics/tarifas
 * Returns currently active/upcoming Meta rates.
 */
router.get('/metrics/tarifas', async (_req: Request, res: Response): Promise<void> => {
  try {
    const query = `
      SELECT id, pais, categoria, tarifa_usd, vigente_desde, vigente_hasta
      FROM pricing_config
      WHERE vigente_hasta IS NULL OR vigente_hasta >= NOW()
      ORDER BY pais ASC, categoria ASC, vigente_desde ASC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch active tariffs:', error);
    res.status(500).json({ error: 'Internal server error while fetching active tariffs' });
  }
});

export default router;

