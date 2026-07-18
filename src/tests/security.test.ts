import request from 'supertest';
import bcryptjs from 'bcryptjs';
import app from '../app';
import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import * as whatsappService from '../services/whatsapp.service';

// Mock the outbound WhatsApp service
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_outgoing_msg_id'),
}));

const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

describe('Multi-Tenant Isolation and Security Tests', () => {
  const testSchema = 'test_security';
  let jwtTokenA: string;
  let jwtTokenB: string;
  let conversationIdA: number;
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
    const hashA = bcryptjs.hashSync('passwordA', 10);
    const hashB = bcryptjs.hashSync('passwordB', 10);

    // 5. Populate users
    await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES 
        (10, 'operatorA@test.com', $1, 'Operator A', 'operator'),
        (20, 'operatorB@test.com', $2, 'Operator B', 'operator');
    `,
      [hashA, hashB],
    );

    // 6. Populate conversations
    const resA = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('111222', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdA = resA.rows[0].id;

    const resB = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('333444', 20, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdB = resB.rows[0].id;

    // 7. Seed initial message for each conversation
    await pool.query(
      `
      INSERT INTO messages (conversation_id, sender, body, business_id, generated_by)
      VALUES 
        ($1, 'user', 'Hola negocio A', 10, 'user'),
        ($2, 'user', 'Hola negocio B', 20, 'user');
    `,
      [conversationIdA, conversationIdB],
    );
  });

  afterAll(async () => {
    // Clean up
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication Tests', () => {
    it('should successfully log in and return a JWT for correct credentials', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'operatorA@test.com',
        password: 'passwordA',
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.email).toBe('operatorA@test.com');
      expect(res.body.user.business_id).toBe(10);
      jwtTokenA = res.body.token;
    });

    it('should successfully log in and return a JWT for Business B operator', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'operatorB@test.com',
        password: 'passwordB',
      });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.email).toBe('operatorB@test.com');
      expect(res.body.user.business_id).toBe(20);
      jwtTokenB = res.body.token;
    });

    it('should reject login with incorrect password', async () => {
      const res = await request(app).post('/auth/login').send({
        email: 'operatorA@test.com',
        password: 'wrongpassword',
      });

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });

    it('should block protected endpoints without a token', async () => {
      const res = await request(app).get('/conversations');
      expect(res.status).toBe(401);
    });

    it('should block protected endpoints with an invalid token', async () => {
      const res = await request(app)
        .get('/conversations')
        .set('Authorization', 'Bearer invalid_token');
      expect(res.status).toBe(401);
    });
  });

  describe('Multi-Tenant Isolation and Authorization Tests', () => {
    it('Operator A should only list conversations belonging to Business A', async () => {
      const res = await request(app)
        .get('/conversations')
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].id).toBe(conversationIdA);
      expect(res.body[0].business_id).toBe(10);
      expect(res.body[0].customer_number).toBe('111222');
    });

    it('Operator A should be able to view details of Conversation A', async () => {
      const res = await request(app)
        .get(`/conversations/${conversationIdA}`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(conversationIdA);
      expect(res.body.business_id).toBe(10);
    });

    it('Operator A should NOT be able to view details of Conversation B (should fail with 404)', async () => {
      const res = await request(app)
        .get(`/conversations/${conversationIdB}`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toBe('Conversation not found');
    });

    it('Operator A should be able to view messages of Conversation A', async () => {
      const res = await request(app)
        .get(`/conversations/${conversationIdA}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].body).toBe('Hola negocio A');
      expect(res.body[0].sender).toBe('user');
    });

    it('Operator A should NOT be able to view messages of Conversation B (should fail with 404)', async () => {
      const res = await request(app)
        .get(`/conversations/${conversationIdB}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });

    it('Operator A should NOT be able to pause AI of Conversation B (should fail with 404)', async () => {
      const res = await request(app)
        .post(`/conversations/${conversationIdB}/pause`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(404);
    });

    it('Operator A should NOT be able to send messages to Conversation B (should fail with 404)', async () => {
      const res = await request(app)
        .post(`/conversations/${conversationIdB}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`)
        .send({ body: 'Hack message' });

      expect(res.status).toBe(404);
      expect(mockSendTextMessage).not.toHaveBeenCalled();
    });
  });

  describe('Human Action, Pausing and Auditing Tests', () => {
    it('Operator A should be able to pause AI for Conversation A and generate audit log', async () => {
      const res = await request(app)
        .post(`/conversations/${conversationIdA}/pause`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('paused');

      // Verify DB conversation status is updated
      const { rows: convs } = await pool.query('SELECT status FROM conversations WHERE id = $1;', [
        conversationIdA,
      ]);
      expect(convs[0].status).toBe('pausada_humano');

      // Verify audit log is written
      const { rows: auditLogs } = await pool.query(
        'SELECT * FROM audit_logs WHERE conversation_id = $1;',
        [conversationIdA],
      );
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].action).toBe('pause_ai');
      expect(auditLogs[0].business_id).toBe(10);
    });

    it('Operator A should be able to resume AI for Conversation A and generate audit log', async () => {
      const res = await request(app)
        .post(`/conversations/${conversationIdA}/resume`)
        .set('Authorization', `Bearer ${jwtTokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('resumed');

      // Verify DB conversation status is updated
      const { rows: convs } = await pool.query('SELECT status FROM conversations WHERE id = $1;', [
        conversationIdA,
      ]);
      expect(convs[0].status).toBe('activa_ia');

      // Verify audit log has the resume entry
      const { rows: auditLogs } = await pool.query(
        'SELECT * FROM audit_logs WHERE conversation_id = $1 ORDER BY created_at DESC;',
        [conversationIdA],
      );
      expect(auditLogs.length).toBe(2);
      expect(auditLogs[0].action).toBe('resume_ai');
    });

    it('Operator A sending a message should send to customer, save message, pause AI and trace it as generated_by: humano', async () => {
      mockSendTextMessage.mockResolvedValueOnce('wamid.custom_operator_msg_id');

      const res = await request(app)
        .post(`/conversations/${conversationIdA}/messages`)
        .set('Authorization', `Bearer ${jwtTokenA}`)
        .send({ body: 'Hola, soy el operador humano.' });

      expect(res.status).toBe(201);
      expect(res.body.message_id).toBeDefined();

      // Verify WhatsApp service called
      expect(mockSendTextMessage).toHaveBeenCalledWith('111222', 'Hola, soy el operador humano.');

      // Verify message saved in DB (sender is 'bot')
      const { rows: msgs } = await pool.query(
        'SELECT sender, body, business_id FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1;',
        [conversationIdA],
      );
      expect(msgs[0].body).toBe('Hola, soy el operador humano.');
      expect(msgs[0].sender).toBe('bot');
      expect(msgs[0].business_id).toBe(10);

      // Verify conversation status changed to pausada_humano
      const { rows: convs } = await pool.query('SELECT status FROM conversations WHERE id = $1;', [
        conversationIdA,
      ]);
      expect(convs[0].status).toBe('pausada_humano');

      // Verify trace has generated_by = 'humano'
      const { rows: traces } = await pool.query(
        'SELECT status_after, generated_by FROM conversation_traces WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1;',
        [conversationIdA],
      );
      expect(traces[0].status_after).toBe('pausada_humano');
      expect(traces[0].generated_by).toBe('humano');
    });
  });
});
