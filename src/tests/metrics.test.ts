import request from 'supertest';
import bcryptjs from 'bcryptjs';
import app from '../app';
import { pool, saveMessage } from '../services/db.service';
import { runMigrations } from '../migrations';

jest.setTimeout(60000);

describe('Metrics and Dashboard REST Endpoints', () => {
  const testSchema = 'test_metrics_api';
  let jwtTokenA: string;
  let jwtTokenB: string;
  let conversationIdA1: number;
  let conversationIdA2: number;
  let conversationIdA3: number;
  let conversationIdAOld: number;
  let conversationIdB1: number;

  beforeAll(async () => {
    // 1. Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runMigrations(pool);

    // 3. Populate test businesses
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES 
        (10, 'Business A', 'phone_number_a'),
        (20, 'Business B', 'phone_number_b')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 1)) FROM businesses;
    `);

    // 4. Create password hashes and users
    const passwordHash = bcryptjs.hashSync('testpassword', 10);
    await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES 
        (10, 'operatorA@test.com', $1, 'Operator A', 'operator'),
        (20, 'operatorB@test.com', $1, 'Operator B', 'operator');
    `,
      [passwordHash],
    );

    // 5. Populate conversations (A1, A2, A3, AOld for Business A, and B1 for Business B)
    const resA1 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, created_at)
      VALUES ('51999999901', 10, 'activa_ia', 'saludo', '2026-07-01 10:00:00')
      RETURNING id;
    `);
    conversationIdA1 = resA1.rows[0].id;

    const resA2 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, created_at)
      VALUES ('51999999902', 10, 'activa_ia', 'saludo', '2026-07-01 10:00:00')
      RETURNING id;
    `);
    conversationIdA2 = resA2.rows[0].id;

    const resA3 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, created_at)
      VALUES ('51999999903', 10, 'activa_ia', 'saludo', '2026-07-05 10:00:00')
      RETURNING id;
    `);
    conversationIdA3 = resA3.rows[0].id;

    const resAOld = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, created_at)
      VALUES ('51999999904', 10, 'activa_ia', 'saludo', '2026-05-01 10:00:00')
      RETURNING id;
    `);
    conversationIdAOld = resAOld.rows[0].id;

    const resB1 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, created_at)
      VALUES ('51999999905', 20, 'activa_ia', 'saludo', '2026-07-01 10:00:00')
      RETURNING id;
    `);
    conversationIdB1 = resB1.rows[0].id;

    // 6. Populate orders (Ventas)
    // Order A1_1
    await pool.query(`
      INSERT INTO orders (conversation_id, business_id, items, total, created_at)
      VALUES ($1, 10, '[]'::jsonb, 50.00, '2026-07-02 10:00:00');
    `, [conversationIdA1]);

    // Order A1_2
    await pool.query(`
      INSERT INTO orders (conversation_id, business_id, items, total, created_at)
      VALUES ($1, 10, '[]'::jsonb, 150.00, '2026-07-03 10:00:00');
    `, [conversationIdA1]);

    // Order A2_1
    await pool.query(`
      INSERT INTO orders (conversation_id, business_id, items, total, created_at)
      VALUES ($1, 10, '[]'::jsonb, 100.00, '2026-07-04 10:00:00');
    `, [conversationIdA2]);

    // Order AOld
    await pool.query(`
      INSERT INTO orders (conversation_id, business_id, items, total, created_at)
      VALUES ($1, 10, '[]'::jsonb, 200.00, '2026-05-02 10:00:00');
    `, [conversationIdAOld]);

    // Order B1
    await pool.query(`
      INSERT INTO orders (conversation_id, business_id, items, total, created_at)
      VALUES ($1, 20, '[]'::jsonb, 300.00, '2026-07-02 10:00:00');
    `, [conversationIdB1]);

    // 7. Seed messages for bot response time and costs calculations
    // Conversation A1 messages
    await saveMessage(conversationIdA1, 'wamid.a1_1', 'user', 'Hola', 'user', null, undefined, new Date('2026-07-01T10:00:00Z'));
    await saveMessage(conversationIdA1, 'wamid.a1_2', 'bot', 'Hola, ¿en qué te ayudo?', 'IA', null, 'marketing', new Date('2026-07-01T10:00:15Z'));
    // Update message cost manually for precision testing, because saveMessage calculates rate using pricing_config
    await pool.query("UPDATE messages SET cost = 0.0730 WHERE message_id = 'wamid.a1_2';");

    // Add another bot message to A1 to test multiple messages category aggregation
    await saveMessage(conversationIdA1, 'wamid.a1_3', 'bot', 'Mas info', 'IA', null, 'servicio', new Date('2026-07-01T10:00:30Z'));
    await pool.query("UPDATE messages SET cost = 0.0100 WHERE message_id = 'wamid.a1_3';");

    // Conversation A2 messages
    await saveMessage(conversationIdA2, 'wamid.a2_1', 'user', 'Quiero comprar', 'user', null, undefined, new Date('2026-07-01T10:10:00Z'));
    await saveMessage(conversationIdA2, 'wamid.a2_2', 'bot', 'Qué producto te interesa?', 'IA', null, 'utilidad', new Date('2026-07-01T10:10:45Z'));
    await pool.query("UPDATE messages SET cost = 0.0350 WHERE message_id = 'wamid.a2_2';");

    // Old message for AOld (should be excluded)
    await saveMessage(conversationIdAOld, 'wamid.a_old', 'bot', 'Mensaje viejo', 'IA', null, 'servicio', new Date('2026-05-01T10:00:00Z'));
    await pool.query("UPDATE messages SET cost = 0.0100 WHERE message_id = 'wamid.a_old';");

    // Message for Business B (should be isolated)
    await saveMessage(conversationIdB1, 'wamid.b1_1', 'bot', 'Hola B', 'IA', null, 'marketing', new Date('2026-07-01T10:00:00Z'));
    await pool.query("UPDATE messages SET cost = 0.0730 WHERE message_id = 'wamid.b1_1';");

    // 8. Seed conversation traces (for escalations and pause duration)
    // Trace A1 escalations & pause/resume
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, escalation_triggered, escalation_reason, created_at, generated_by)
      VALUES 
        ($1, 10, 'activa_ia', 'saludo', 'activa_ia', 'calificacion_necesidad', true, 'fuera_de_horario', '2026-07-01 10:01:00', 'IA'),
        ($1, 10, 'activa_ia', 'calificacion_necesidad', 'pausada_humano', 'calificacion_necesidad', false, null, '2026-07-01 12:00:00', 'humano'),
        ($1, 10, 'pausada_humano', 'calificacion_necesidad', 'activa_ia', 'calificacion_necesidad', false, null, '2026-07-01 12:05:00', 'humano');
    `, [conversationIdA1]);

    // Trace A2 escalations & pause/resume
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, escalation_triggered, escalation_reason, created_at, generated_by)
      VALUES 
        ($1, 10, 'activa_ia', 'saludo', 'activa_ia', 'recomendacion_producto', true, 'solicitud_operador', '2026-07-01 10:11:00', 'IA'),
        ($1, 10, 'activa_ia', 'recomendacion_producto', 'pausada_humano', 'recomendacion_producto', false, null, '2026-07-01 13:00:00', 'humano'),
        ($1, 10, 'pausada_humano', 'recomendacion_producto', 'activa_ia', 'recomendacion_producto', false, null, '2026-07-01 13:15:00', 'humano');
    `, [conversationIdA2]);

    // Trace A3 (no escalation, no pause)
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, escalation_triggered, escalation_reason, created_at, generated_by)
      VALUES ($1, 10, 'activa_ia', 'saludo', 'activa_ia', 'saludo', false, null, '2026-07-05 10:05:00', 'IA');
    `, [conversationIdA3]);

    // Trace AOld (old escalation)
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, escalation_triggered, escalation_reason, created_at, generated_by)
      VALUES ($1, 10, 'activa_ia', 'saludo', 'activa_ia', 'saludo', true, 'fuera_de_horario', '2026-05-01 10:05:00', 'IA');
    `, [conversationIdAOld]);

    // Trace B1 (business B escalation)
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, escalation_triggered, escalation_reason, created_at, generated_by)
      VALUES ($1, 20, 'activa_ia', 'saludo', 'activa_ia', 'saludo', true, 'solicitud_operador', '2026-07-01 10:05:00', 'IA');
    `, [conversationIdB1]);

    // 9. Seed satisfaction ratings
    // Rating A1
    await pool.query(`
      INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario, created_at)
      VALUES ($1, 10, 5, 'Excelente servicio', '2026-07-04 12:00:00');
    `, [conversationIdA1]);

    // Rating A2 (Low rating)
    await pool.query(`
      INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario, created_at)
      VALUES ($1, 10, 2, 'Malo', '2026-07-05 12:00:00');
    `, [conversationIdA2]);

    // Add subsequent operator follow-up message to conversation A2
    await saveMessage(conversationIdA2, 'wamid.a2_followup', 'bot', 'Disculpas por el inconveniente', 'humano', null, 'servicio', new Date('2026-07-05T12:10:00Z'));

    // Rating A3 (Low rating)
    await pool.query(`
      INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario, created_at)
      VALUES ($1, 10, 1, 'Pésimo', '2026-07-06 12:00:00');
    `, [conversationIdA3]);
    // NO follow-up message for A3 -> triggers alert!

    // Rating AOld (old rating)
    await pool.query(`
      INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario, created_at)
      VALUES ($1, 10, 5, 'Viejo', '2026-05-04 12:00:00');
    `, [conversationIdAOld]);

    // Rating B
    await pool.query(`
      INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario, created_at)
      VALUES ($1, 20, 4, 'Bueno B', '2026-07-04 12:00:00');
    `, [conversationIdB1]);

    // 10. Log in to get tokens
    const loginA = await request(app)
      .post('/auth/login')
      .send({ email: 'operatorA@test.com', password: 'testpassword' });
    jwtTokenA = loginA.body.token;

    const loginB = await request(app)
      .post('/auth/login')
      .send({ email: 'operatorB@test.com', password: 'testpassword' });
    jwtTokenB = loginB.body.token;
  });

  afterAll(async () => {
    // Clean up
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  describe('GET /metrics/ventas', () => {
    it('should calculate sales metrics correctly for Business A inside range and include details', async () => {
      const res = await request(app)
        .get('/metrics/ventas?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.total_pedidos_confirmados).toBe(3);
      expect(res.body.monto_total_vendido).toBe(300.00);
      expect(res.body.ticket_promedio).toBe(100.00);
      expect(res.body.tasa_conversion).toBeCloseTo(0.6666, 3); // 2 convertidas (A1, A2) / 3 iniciadas (A1, A2, A3)
      expect(Array.isArray(res.body.detalle_pedidos)).toBe(true);
      expect(res.body.detalle_pedidos.length).toBe(3);

      // Verify that Business B's order (id total=300.00) and AOld (id total=200.00) are NOT inside the response details list
      const hasBOrder = res.body.detalle_pedidos.some((o: any) => o.total === 300.00);
      const hasOldOrder = res.body.detalle_pedidos.some((o: any) => o.total === 200.00);
      expect(hasBOrder).toBe(false);
      expect(hasOldOrder).toBe(false);
    });

    it('should isolate metrics from other tenants (Business B)', async () => {
      const res = await request(app)
        .get('/metrics/ventas?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.total_pedidos_confirmados).toBe(1);
      expect(res.body.monto_total_vendido).toBe(300.00);
      expect(res.body.ticket_promedio).toBe(300.00);
      expect(res.body.tasa_conversion).toBe(1.0); // 1 convertida (B1) / 1 iniciada (B1)
    });
  });

  describe('GET /metrics/operacion', () => {
    it('should calculate operations metrics for Business A', async () => {
      const res = await request(app)
        .get('/metrics/operacion?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      // response times: A1 = 15s, A2 = 45s. Average: 30s
      expect(res.body.tiempo_promedio_respuesta_bot_segundos).toBe(30);
      
      // Conversations initiated in range: A1, A2, A3 (3 conversations)
      // Escalated in range: A1, A2 (2 conversations) -> 66.67%
      expect(res.body.porcentaje_conversaciones_escaladas).toBeCloseTo(66.67, 1);
      
      // Escalations reasons details
      expect(Array.isArray(res.body.escalamientos_por_motivo)).toBe(true);
      expect(res.body.escalamientos_por_motivo.length).toBe(2);
      const fueraDeHorario = res.body.escalamientos_por_motivo.find((e: any) => e.motivo === 'fuera_de_horario');
      const solicitudOperador = res.body.escalamientos_por_motivo.find((e: any) => e.motivo === 'solicitud_operador');
      expect(fueraDeHorario.cantidad).toBe(1);
      expect(fueraDeHorario.porcentaje).toBeCloseTo(33.33, 1);
      expect(solicitudOperador.cantidad).toBe(1);
      expect(solicitudOperador.porcentaje).toBeCloseTo(33.33, 1);

      // Pause durations: A1 = 5 min (300s), A2 = 15 min (900s). Average: 10 min (600s)
      expect(res.body.tiempo_promedio_pausa_humano_segundos).toBe(600);
    });

    it('should isolate operations metrics from other tenants (Business B)', async () => {
      const res = await request(app)
        .get('/metrics/operacion?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      // Business B has no user/bot message response time setup
      expect(res.body.tiempo_promedio_respuesta_bot_segundos).toBe(0);
      // Business B initiated 1 conversation, escalated 1 conversation
      expect(res.body.porcentaje_conversaciones_escaladas).toBe(100.0);
      expect(res.body.tiempo_promedio_pausa_humano_segundos).toBe(0);
    });
  });

  describe('GET /metrics/costos', () => {
    it('should calculate historical costs correctly for Business A and include traceability details', async () => {
      const res = await request(app)
        .get('/metrics/costos?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      // Outgoing messages for Business A: marketing (0.0730), servicio (2 messages = 0.0200), utilidad (0.0350)
      // Total: 0.1280
      expect(res.body.costo_total_estimado).toBeCloseTo(0.1280, 4);
      
      const marketingCat = res.body.mensajes_por_categoria.find((c: any) => c.categoria === 'marketing');
      const servicioCat = res.body.mensajes_por_categoria.find((c: any) => c.categoria === 'servicio');
      const utilidadCat = res.body.mensajes_por_categoria.find((c: any) => c.categoria === 'utilidad');
      
      expect(marketingCat.cantidad).toBe(1);
      expect(marketingCat.costo_sumado).toBeCloseTo(0.0730, 4);
      
      expect(servicioCat.cantidad).toBe(2);
      expect(servicioCat.costo_sumado).toBeCloseTo(0.0200, 4);
      
      expect(utilidadCat.cantidad).toBe(1);
      expect(utilidadCat.costo_sumado).toBeCloseTo(0.0350, 4);

      expect(Array.isArray(res.body.detalle_costos)).toBe(true);
      expect(res.body.detalle_costos.length).toBe(4);
    });

    it('should isolate costs from Business B', async () => {
      const res = await request(app)
        .get('/metrics/costos?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.costo_total_estimado).toBeCloseTo(0.0730, 4);
    });
  });

  describe('GET /metrics/satisfaccion', () => {
    it('should aggregate satisfaction ratings and distribution for Business A', async () => {
      const res = await request(app)
        .get('/metrics/satisfaccion?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      // Business A ratings: 5, 2, 1. Avg: (5+2+1)/3 = 2.666...
      expect(res.body.promedio_calificacion).toBeCloseTo(2.6666, 3);
      expect(res.body.total_calificaciones).toBe(3);
      
      expect(res.body.distribucion['1']).toBe(1);
      expect(res.body.distribucion['2']).toBe(1);
      expect(res.body.distribucion['3']).toBe(0);
      expect(res.body.distribucion['4']).toBe(0);
      expect(res.body.distribucion['5']).toBe(1);
    });

    it('should isolate satisfaction metrics from Business B', async () => {
      const res = await request(app)
        .get('/metrics/satisfaccion?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.promedio_calificacion).toBe(4.0);
      expect(res.body.total_calificaciones).toBe(1);
      expect(res.body.distribucion['4']).toBe(1);
    });
  });

  describe('GET /metrics/postventa', () => {
    it('should calculate repurchase rate and low rating alerts for Business A', async () => {
      const res = await request(app)
        .get('/metrics/postventa?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      // total buyers in range: 2 (A1, A2)
      // repurchase buyers (>1 order): 1 (A1 has 2 orders) -> 50%
      expect(res.body.tasa_recompra).toBe(0.5);
      expect(res.body.total_clientes_compradores).toBe(2);
      expect(res.body.clientes_recompra).toBe(1);

      // low rating alerts: Rating A2 (score 2) has follow-up. Rating A3 (score 1) has no follow-up. Total alerts: 1
      expect(res.body.alertas_satisfaccion_sin_seguimiento).toBe(1);
    });

    it('should isolate post-sales metrics from Business B', async () => {
      const res = await request(app)
        .get('/metrics/postventa?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.tasa_recompra).toBe(0); // 1 buyer, 1 order
      expect(res.body.total_clientes_compradores).toBe(1);
      expect(res.body.alertas_satisfaccion_sin_seguimiento).toBe(0); // rating is 4 (not low)
    });
  });

  describe('GET /metrics/embudo', () => {
    it('should return correct funnel state counts for Business A in range', async () => {
      const res = await request(app)
        .get('/metrics/embudo?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const saludo = res.body.find((r: any) => r.stage === 'saludo');
      const calif = res.body.find((r: any) => r.stage === 'calificacion_necesidad');
      const recom = res.body.find((r: any) => r.stage === 'recomendacion_producto');

      expect(saludo).toBeDefined();
      expect(saludo.count).toBe(3); // A1, A2, A3 are initiated in range
      
      expect(calif).toBeDefined();
      expect(calif.count).toBe(1); // A1 reached calificacion_necesidad

      expect(recom).toBeDefined();
      expect(recom.count).toBe(1); // A2 reached recomendacion_producto
    });

    it('should isolate funnel metrics for Business B', async () => {
      const res = await request(app)
        .get('/metrics/embudo?desde=2026-06-15&hasta=2026-07-15')
        .set('Authorization', `Bearer ${jwtTokenB}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);

      const saludo = res.body.find((r: any) => r.stage === 'saludo');
      const calif = res.body.find((r: any) => r.stage === 'calificacion_necesidad');

      expect(saludo).toBeDefined();
      expect(saludo.count).toBe(1); // B1 in range
      expect(calif).toBeUndefined(); // Business B has no conversations in calificacion_necesidad
    });
  });
});
