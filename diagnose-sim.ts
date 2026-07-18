import dotenv from 'dotenv';
import { Pool } from 'pg';
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('=== SIM CONVERSATIONS ===');
  const r1 = await pool.query(
    `SELECT id, customer_number, status, sales_state, created_at
     FROM conversations WHERE customer_number LIKE '519999%' ORDER BY id;`
  );
  console.log(`Found ${r1.rows.length} sim conversations`);
  r1.rows.slice(0, 3).forEach(r => console.log(r));

  console.log('\n=== ORDERS ===');
  const r2 = await pool.query(
    `SELECT o.id, o.conversation_id, o.total, o.business_id, o.created_at
     FROM orders o
     WHERE o.conversation_id IN (
       SELECT id FROM conversations WHERE customer_number LIKE '519999%'
     ) ORDER BY o.id;`
  );
  console.log(`Found ${r2.rows.length} orders`);
  r2.rows.forEach(r => console.log(r));

  console.log('\n=== TRACES ESCALATION ===');
  const r3 = await pool.query(
    `SELECT COUNT(*) as cnt, COUNT(CASE WHEN escalation_triggered THEN 1 END) as esc
     FROM conversation_traces
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE customer_number LIKE '519999%'
     );`
  );
  console.log(r3.rows[0]);

  console.log('\n=== SATISFACTION RATINGS ===');
  const r4 = await pool.query(
    `SELECT id, conversation_id, calificacion, business_id, created_at
     FROM satisfaction_ratings
     WHERE conversation_id IN (
       SELECT id FROM conversations WHERE customer_number LIKE '519999%'
     ) ORDER BY id;`
  );
  console.log(`Found ${r4.rows.length} ratings`);
  r4.rows.forEach(r => console.log(r));

  // Simulate the exact ventas query for all time
  console.log('\n=== API VENTAS QUERY (all time, biz 1) ===');
  const desde = new Date('2020-01-01');
  const hasta = new Date('2030-01-01');
  
  const salesRes = await pool.query(
    `SELECT COUNT(id)::int AS total_pedidos_confirmados,
       COALESCE(SUM(total), 0)::float AS monto_total_vendido,
       COALESCE(AVG(total), 0)::float AS ticket_promedio
     FROM orders
     WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3;`,
    [1, desde, hasta]
  );
  console.log('orders result:', salesRes.rows[0]);

  const initiatedRes = await pool.query(
    `SELECT COUNT(id)::int AS total_iniciadas 
     FROM conversations 
     WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3;`,
    [1, desde, hasta]
  );
  console.log('conversations initiated:', initiatedRes.rows[0]);

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
    [1, desde, hasta]
  );
  console.log('conversations converted:', convertedRes.rows[0]);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
