import request from 'supertest';
import bcryptjs from 'bcryptjs';
import app from '../app';
import { pool, saveMessage, updateConversationState } from '../services/db.service';
import { runMigrations } from '../migrations';

describe('Conversations and Messages API Endpoints', () => {
  const testSchema = 'test_conversations_api';
  let jwtTokenA: string;
  let jwtTokenB: string;
  let conversationIdA1: number;
  let conversationIdA2: number;
  let conversationIdB: number;

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

    // 4. Create password hashes
    const passwordHash = bcryptjs.hashSync('testpassword', 10);

    // 5. Populate users
    await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES 
        (10, 'operatorA@test.com', $1, 'Operator A', 'operator'),
        (20, 'operatorB@test.com', $1, 'Operator B', 'operator');
    `,
      [passwordHash],
    );

    // 6. Populate conversations for Business A and Business B
    // Conversation A1
    const resA1 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('111111', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdA1 = resA1.rows[0].id;

    // Conversation A2 (starts with different sales state and status)
    const resA2 = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('222222', 10, 'pausada_humano', 'calificacion_necesidad')
      RETURNING id;
    `);
    conversationIdA2 = resA2.rows[0].id;

    // Conversation B
    const resB = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('333333', 20, 'cerrada', 'cierre_y_pago')
      RETURNING id;
    `);
    conversationIdB = resB.rows[0].id;

    // 7. Seed messages
    // Conversation A1 messages
    await saveMessage(conversationIdA1, 'wamid.a1_1', 'user', 'Hola bot');
    await saveMessage(conversationIdA1, 'wamid.a1_2', 'bot', 'Hola, ¿en qué puedo ayudarte?');

    // Conversation A2 messages (last activity will make A2 more recent initially)
    await saveMessage(conversationIdA2, 'wamid.a2_1', 'user', 'Hola, quiero comprar');
    // Human operator response in conversation A2
    await saveMessage(
      conversationIdA2,
      'wamid.a2_2',
      'bot',
      'Hola, soy un operador humano',
      'humano',
    );

    // Conversation B messages
    await saveMessage(conversationIdB, 'wamid.b_1', 'user', 'Mensaje negocio B');

    // 8. Log in to get tokens
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

  describe('GET /conversations', () => {
    it('should list conversations belonging only to the authenticated business, with correct attributes', async () => {
      const res = await request(app)
        .get('/conversations')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      // Verify that Conversation B is NOT present
      const hasB = res.body.some((c: any) => c.id === conversationIdB);
      expect(hasB).toBe(false);

      // Find conversations A1 and A2 in response
      const convA1 = res.body.find((c: any) => c.id === conversationIdA1);
      const convA2 = res.body.find((c: any) => c.id === conversationIdA2);

      expect(convA1).toBeDefined();
      expect(convA2).toBeDefined();

      // Check fields for A1
      expect(convA1.customer_number).toBe('111111');
      expect(convA1.status).toBe('activa_ia');
      expect(convA1.sales_state).toBe('saludo');
      expect(convA1.last_message).toBe('Hola, ¿en qué puedo ayudarte?');
      expect(convA1.last_message_timestamp).toBeDefined();

      // Check fields for A2
      expect(convA2.customer_number).toBe('222222');
      expect(convA2.status).toBe('pausada_humano');
      expect(convA2.sales_state).toBe('calificacion_necesidad');
      expect(convA2.last_message).toBe('Hola, soy un operador humano');
      expect(convA2.last_message_timestamp).toBeDefined();
    });

    it('should return conversations ordered by recent activity (most recent updated_at first)', async () => {
      // Initially check order. We will trigger an update/message on A1 to bring it to top.
      let res = await request(app)
        .get('/conversations')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      // Save a new message to conversation A1 to make it the most recently active
      await saveMessage(conversationIdA1, 'wamid.a1_3', 'user', 'Quiero ordenar café espresso');

      res = await request(app).get('/conversations').set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      // Now conversation A1 should be first
      expect(res.body[0].id).toBe(conversationIdA1);
      expect(res.body[0].last_message).toBe('Quiero ordenar café espresso');
      expect(res.body[1].id).toBe(conversationIdA2);
    });

    it('should fail to fetch conversations when unauthorized (no token or invalid token)', async () => {
      const resNoToken = await request(app).get('/conversations');
      expect(resNoToken.status).toBe(401);

      const resBadToken = await request(app)
        .get('/conversations')
        .set('Authorization', 'Bearer invalid_token');
      expect(resBadToken.status).toBe(401);
    });
  });

  describe('GET /conversations/:id/messages', () => {
    it('should return the complete history of messages in chronological order, with generated_by status', async () => {
      const res = await request(app)
        .get(`/conversations/${conversationIdA2}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      // Verification of unified chronological order (oldest first)
      expect(res.body[0].body).toBe('Hola, quiero comprar');
      expect(res.body[0].sender).toBe('user');
      expect(res.body[0].generated_by).toBe('user');

      expect(res.body[1].body).toBe('Hola, soy un operador humano');
      expect(res.body[1].sender).toBe('bot');
      expect(res.body[1].generated_by).toBe('humano');
    });

    it('should fail with 404 if attempting to access a conversation of another business', async () => {
      // Operator A attempting to access Conversation B (Business B)
      const res = await request(app)
        .get(`/conversations/${conversationIdB}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBe('Conversation not found');
    });

    it('should fail with 404 if conversation does not exist', async () => {
      const res = await request(app)
        .get('/conversations/999999/messages')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(404);
    });
  });
});
