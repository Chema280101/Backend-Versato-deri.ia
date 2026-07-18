import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const sslConfig = process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

async function main() {
  try {
    console.log('Querying conversations...');
    const convs = await pool.query('SELECT * FROM conversations ORDER BY id DESC LIMIT 5;');
    console.log('CONVERSATIONS:');
    console.dir(convs.rows, { depth: null });

    console.log('\nQuerying latest traces...');
    const traces = await pool.query('SELECT * FROM conversation_traces ORDER BY id DESC LIMIT 5;');
    console.log('TRACES:');
    console.dir(traces.rows, { depth: null });

    console.log('\n--- QUERY DE EJEMPLO PARA EL DASHBOARD ---');
    console.log('¿Cuántas conversaciones llegaron a "confirmado" vs "escalado_humano" (según el historial de trazas)?');
    const dashboardQuery = `
      SELECT 
        sales_state_after as estado, 
        COUNT(DISTINCT conversation_id) as total_conversaciones
      FROM conversation_traces
      WHERE sales_state_after IN ('confirmado', 'escalado_humano')
      GROUP BY sales_state_after;
    `;
    const result = await pool.query(dashboardQuery);
    console.log('RESULTADOS:');
    console.table(result.rows);
  } catch (err) {
    console.error('Error querying DB:', err);
  } finally {
    await pool.end();
  }
}

main();
