import { pool } from './db.service';
import { getSocketServer } from './socket.service';
import { config } from '../config';

let intervalRef: NodeJS.Timeout | null = null;

/**
 * Queries the database for conversations in 'pausada_humano' state that have been
 * waiting for a reply from a human operator for longer than the business-configured
 * threshold (or the default of 2 hours), and emits WebSocket alerts to the connected operators.
 */
export async function checkPendingAlerts(): Promise<void> {
  console.log('[ALERT]: Running periodic operator stagnation check...');
  const query = `
    SELECT c.id, c.business_id 
    FROM conversations c
    JOIN businesses b ON c.business_id = b.id
    WHERE c.status = 'pausada_humano'
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > COALESCE(
            (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
            '1970-01-01 00:00:00'::timestamp
          )
      )
      AND (
        SELECT MIN(created_at) FROM messages m
        WHERE m.conversation_id = c.id
          AND m.created_at > COALESCE(
            (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
            '1970-01-01 00:00:00'::timestamp
          )
      ) < NOW() - (COALESCE(b.alert_pending_threshold_hours, 2) * INTERVAL '1 hour');
  `;

  try {
    const result = await pool.query(query);
    if (result.rows.length === 0) {
      console.log('[ALERT]: No stagnant human-paused conversations detected.');
      return;
    }

    console.log(`[ALERT]: Detected ${result.rows.length} stagnant conversation(s) requiring attention.`);

    let io;
    try {
      io = getSocketServer();
    } catch (wsError) {
      console.warn('[ALERT]: Socket server not initialized yet, skipping WebSocket emission.');
      return;
    }

    for (const row of result.rows) {
      const roomName = `business_${row.business_id}`;
      console.log(`[ALERT]: Emitting 'alerta_pendiente' for conversation ID ${row.id} to room ${roomName}`);
      io.to(roomName).emit('alerta_pendiente', { conversation_id: row.id });
    }
  } catch (error) {
    console.error('[ERROR]: Failed to run periodic operator stagnation check:', error);
  }
}

/**
 * Starts the periodic operator stagnation alert scheduler.
 */
export function startAlertScheduler(): void {
  if (intervalRef) {
    console.warn('[ALERT]: Alert scheduler is already running.');
    return;
  }

  const intervalMs = config.alertCheckIntervalMs;
  console.log(`[ALERT]: Starting alert scheduler with check interval of ${intervalMs}ms (${intervalMs / 1000}s).`);

  // Run once immediately on startup
  checkPendingAlerts().catch((err) => {
    console.error('[ERROR]: Initial alert check failed:', err);
  });

  intervalRef = setInterval(() => {
    checkPendingAlerts().catch((err) => {
      console.error('[ERROR]: Periodic alert check failed:', err);
    });
  }, intervalMs);
}

/**
 * Stops the periodic alert scheduler (primarily useful for clean shutdowns or testing).
 */
export function stopAlertScheduler(): void {
  if (intervalRef) {
    clearInterval(intervalRef);
    intervalRef = null;
    console.log('[ALERT]: Alert scheduler stopped.');
  }
}
