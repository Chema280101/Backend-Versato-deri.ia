import request from 'supertest';
import bcryptjs from 'bcryptjs';
import app from '../app';
import { pool, saveMessage } from '../services/db.service';
import { runMigrations } from '../migrations';

describe('Messaging Tariff and Pricing Config (Phase 4)', () => {
  const testSchema = 'test_pricing_config';
  let operatorToken: string;
  let clientToken: string;
  let conversationId: number;

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

    // Clear any seeded pricing configs for deterministic test results
    await pool.query('TRUNCATE TABLE pricing_config CASCADE;');

    // 3. Populate test businesses
    // business_id = 1 (Platform operator)
    // business_id = 10 (Client business)
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES 
        (1, 'Platform Admin Business', 'phone_admin'),
        (10, 'Client Business A', 'phone_client_a')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 1)) FROM businesses;
    `);

    // 4. Create password hashes
    const passwordHash = bcryptjs.hashSync('testpassword', 10);

    // 5. Populate users
    // Operator user (platform admin, business_id = 1)
    // Client user (business_id = 10)
    await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES 
        (1, 'platform_operator@test.com', $1, 'Daniela Evelyn', 'operator'),
        (10, 'client_operator@test.com', $1, 'Client Operator', 'operator');
    `,
      [passwordHash],
    );

    // 6. Generate JWT tokens
    const opLoginRes = await request(app).post('/auth/login').send({
      email: 'platform_operator@test.com',
      password: 'testpassword',
    });
    operatorToken = opLoginRes.body.token;

    const clLoginRes = await request(app).post('/auth/login').send({
      email: 'client_operator@test.com',
      password: 'testpassword',
    });
    clientToken = clLoginRes.body.token;

    // 7. Create a conversation for a Peruvian customer (prefix 51)
    const convRes = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('51999999999', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationId = convRes.rows[0].id;
  });

  afterAll(async () => {
    // Clean up schema and connection pool
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  describe('Authorization Tests', () => {
    it('should deny access to POST /admin/pricing without auth token', async () => {
      const res = await request(app)
        .post('/admin/pricing')
        .send({
          pais: 'Peru',
          categoria: 'servicio',
          tarifa_usd: 0.0123,
        });
      expect(res.status).toBe(401);
    });

    it('should deny access to POST /admin/pricing for a client business user', async () => {
      const res = await request(app)
        .post('/admin/pricing')
        .set('Authorization', `Bearer ${clientToken}`)
        .send({
          pais: 'Peru',
          categoria: 'servicio',
          tarifa_usd: 0.0123,
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied');
    });

    it('should allow access to POST /admin/pricing for platform operator', async () => {
      const res = await request(app)
        .post('/admin/pricing')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({
          pais: 'Peru',
          categoria: 'servicio',
          tarifa_usd: 0.0100,
          vigente_desde: '2026-07-01T00:00:00.000Z',
        });
      expect(res.status).toBe(201);
      expect(res.body.pais).toBe('Peru');
      expect(res.body.categoria).toBe('servicio');
      expect(parseFloat(res.body.tarifa_usd)).toBe(0.0100);
    });
  });

  describe('Tariff History and Dynamic Calculation', () => {
    it('should overlap/cap existing tariffs correctly and retain historical costs', async () => {
      // 1. Post a new tariff starting later (2026-07-10) using admin endpoint
      const updateRes = await request(app)
        .post('/admin/pricing')
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({
          pais: 'Peru',
          categoria: 'servicio',
          tarifa_usd: 0.0150,
          vigente_desde: '2026-07-10T00:00:00.000Z',
        });
      expect(updateRes.status).toBe(201);
      expect(parseFloat(updateRes.body.tarifa_usd)).toBe(0.0150);

      // 2. Query pricing_config table directly to verify that the first tariff was capped
      const pricingHistory = await pool.query(
        `SELECT * FROM pricing_config WHERE pais = 'Peru' AND categoria = 'servicio' ORDER BY vigente_desde ASC;`
      );

      expect(pricingHistory.rows.length).toBe(2);

      // First tariff (from 2026-07-01 to 2026-07-10)
      const t1 = pricingHistory.rows[0];
      expect(parseFloat(t1.tarifa_usd)).toBe(0.0100);
      expect(new Date(t1.vigente_desde).toISOString()).toBe('2026-07-01T00:00:00.000Z');
      expect(new Date(t1.vigente_hasta).toISOString()).toBe('2026-07-10T00:00:00.000Z');

      // Second tariff (from 2026-07-10 onwards)
      const t2 = pricingHistory.rows[1];
      expect(parseFloat(t2.tarifa_usd)).toBe(0.0150);
      expect(new Date(t2.vigente_desde).toISOString()).toBe('2026-07-10T00:00:00.000Z');
      expect(t2.vigente_hasta).toBeNull();

      // 3. Test historical calculation
      // Send a user message on July 5th
      const t5UserMsgId = await saveMessage(
        conversationId,
        'msg.user_t5',
        'user',
        'Hola',
        'user',
        null,
        undefined,
        new Date('2026-07-05T10:00:00.000Z')
      );

      // Send bot message within 24h window (July 5th, 12:00) -> Should use t1 tariff ($0.0100)
      const msgIdOldTariff = await saveMessage(
        conversationId,
        'msg.bot_old',
        'bot',
        'Respuesta con tarifa vieja',
        'IA',
        null,
        undefined,
        new Date('2026-07-05T12:00:00.000Z')
      );

      // Send a user message on July 12th
      const t12UserMsgId = await saveMessage(
        conversationId,
        'msg.user_t12',
        'user',
        'Hola de nuevo',
        'user',
        null,
        undefined,
        new Date('2026-07-12T10:00:00.000Z')
      );

      // Send bot message within 24h window (July 12th, 12:00) -> Should use t2 tariff ($0.0150)
      const msgIdNewTariff = await saveMessage(
        conversationId,
        'msg.bot_new',
        'bot',
        'Respuesta con tarifa nueva',
        'IA',
        null,
        undefined,
        new Date('2026-07-12T12:00:00.000Z')
      );

      // 4. Retrieve saved messages to check stored costs
      const query = `
        SELECT message_id, category, cost, created_at 
        FROM messages 
        WHERE id IN ($1, $2) 
        ORDER BY created_at ASC;
      `;
      const messagesRes = await pool.query(query, [msgIdOldTariff, msgIdNewTariff]);
      expect(messagesRes.rows.length).toBe(2);

      const msgOld = messagesRes.rows[0];
      expect(msgOld.message_id).toBe('msg.bot_old');
      expect(msgOld.category).toBe('servicio');
      expect(parseFloat(msgOld.cost)).toBe(0.0100); // Must be the old rate!

      const msgNew = messagesRes.rows[1];
      expect(msgNew.message_id).toBe('msg.bot_new');
      expect(msgNew.category).toBe('servicio');
      expect(parseFloat(msgNew.cost)).toBe(0.0150); // Must be the new rate!
    });
  });
});
