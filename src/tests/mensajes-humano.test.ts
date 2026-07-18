import request from 'supertest';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { io as ClientIO } from 'socket.io-client';
import app from '../app';
import { config } from '../config';
import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import { initSocketServer } from '../services/socket.service';
import * as whatsappService from '../services/whatsapp.service';

// Mock the outbound WhatsApp service so we do not make actual Meta API requests
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_human_outgoing_msg_id'),
}));

const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

describe('POST /conversations/:id/mensajes-humano E2E Tests', () => {
  const testSchema = 'test_mensajes_humano_e2e';
  let server: http.Server;
  let port: number;
  let originalConnect: any;
  let originalQuery: any;

  let jwtTokenA: string;
  let jwtTokenB: string;
  let operatorUserIdA: number;
  let operatorUserIdB: number;

  let conversationIdA: number;

  beforeAll(async () => {
    originalConnect = pool.connect;
    originalQuery = pool.query;

    // Patch pool.connect to use the test schema
    // @ts-ignore
    pool.connect = function (this: any, ...args: any[]) {
      const callback = typeof args[0] === 'function' ? args[0] : null;
      if (callback) {
        return originalConnect.call(this, (err: any, client: any, release: any) => {
          if (err) {
            return callback(err);
          }
          if (client._currentSearchPath !== testSchema) {
            client.query(`SET search_path TO ${testSchema};`, (queryErr: any) => {
              if (queryErr) {
                release();
                return callback(queryErr);
              }
              client._currentSearchPath = testSchema;
              callback(null, client, release);
            });
          } else {
            callback(null, client, release);
          }
        });
      } else {
        return originalConnect.apply(this).then(async (client: any) => {
          if (client._currentSearchPath !== testSchema) {
            await client.query(`SET search_path TO ${testSchema};`);
            client._currentSearchPath = testSchema;
          }
          return client;
        });
      }
    };

    // Patch pool.query to use the path-configured client
    // @ts-ignore
    pool.query = async function (this: any, text: any, values: any, callback: any) {
      let actualText = text;
      let actualValues = values;
      let actualCallback = callback;
      if (typeof values === 'function') {
        actualCallback = values;
        actualValues = undefined;
      }

      if (actualCallback) {
        pool.connect((err: any, client: any, release: any) => {
          if (err) {
            return actualCallback(err);
          }
          client.query(actualText, actualValues, (queryErr: any, res: any) => {
            release(queryErr);
            actualCallback(queryErr, res);
          });
        });
      } else {
        const client = await pool.connect();
        try {
          const res = await client.query(actualText, actualValues);
          client.release();
          return res;
        } catch (err) {
          client.release(err as any);
          throw err;
        }
      }
    };

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

    // 3. Populate businesses
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES 
        (10, 'Business A', 'phone_number_a'),
        (20, 'Business B', 'phone_number_b')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4. Populate operator users
    const passwordHash = bcryptjs.hashSync('testpassword', 10);
    const userA = await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES (10, 'operatorA@test.com', $1, 'Operator A', 'operator')
      RETURNING id;
    `,
      [passwordHash],
    );
    operatorUserIdA = userA.rows[0].id;

    const userB = await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES (20, 'operatorB@test.com', $1, 'Operator B', 'operator')
      RETURNING id;
    `,
      [passwordHash],
    );
    operatorUserIdB = userB.rows[0].id;

    // Tokens
    jwtTokenA = jwt.sign({ business_id: 10, user_id: operatorUserIdA }, config.jwtSecret);
    jwtTokenB = jwt.sign({ business_id: 20, user_id: operatorUserIdB }, config.jwtSecret);

    // 5. Spin up HTTP & WS server
    server = http.createServer(app);
    initSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'string' ? 3000 : addr?.port || 3000;
        console.log(`[TEST]: Test server for messages-humano started on port ${port}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Restore original pool methods
    pool.connect = originalConnect;
    pool.query = originalQuery;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log('[TEST]: Test server stopped');
          resolve();
        });
      });
    }

    // Clean up
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    // Clean tables
    await pool.query('DELETE FROM audit_logs;');
    await pool.query('DELETE FROM conversation_traces;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');

    // Create a conversation for Business A
    const resA = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5001112233', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdA = resA.rows[0].id;

    // Create a conversation for Business B
    await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5004445555', 20, 'activa_ia', 'saludo')
    `);
  });

  it('should NOT allow operator to send a human message if the conversation is still in AI mode', async () => {
    // POST to /conversations/:id/mensajes-humano when in status 'activa_ia'
    const res = await request(app)
      .post(`/conversations/${conversationIdA}/mensajes-humano`)
      .set('Authorization', `Bearer ${jwtTokenA}`)
      .send({ body: 'Hola cliente desde humano' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('La conversación no está en modo humano');

    // Confirm that no message was saved to database
    const dbMsgs = await pool.query('SELECT * FROM messages WHERE conversation_id = $1;', [
      conversationIdA,
    ]);
    expect(dbMsgs.rows.length).toBe(0);

    // Confirm that sendTextMessage was not called
    expect(mockSendTextMessage).not.toHaveBeenCalled();
  });

  it('should successfully send human message if paused, registers with user_id and generated_by = humano, and emits websocket event', (done) => {
    // 1. First pause the conversation
    pool.query(
      `UPDATE conversations SET status = 'pausada_humano' WHERE id = $1;`,
      [conversationIdA],
      async (err) => {
        if (err) return done(err);

        // 2. Connect WebSocket client for Business A and Business B
        const socketUrl = `http://localhost:${port}`;
        const socketA = ClientIO(socketUrl, {
          auth: { token: `Bearer ${jwtTokenA}` },
          transports: ['websocket'],
          forceNew: true,
        });

        const socketB = ClientIO(socketUrl, {
          auth: { token: `Bearer ${jwtTokenB}` },
          transports: ['websocket'],
          forceNew: true,
        });

        let receivedByA = false;
        let receivedByB = false;

        socketA.on('nuevo_mensaje', (msg) => {
          try {
            expect(msg.conversation_id).toBe(conversationIdA);
            expect(msg.body).toBe('Hola de parte del operador humano');
            expect(msg.generated_by).toBe('humano');
            expect(msg.user_id).toBe(operatorUserIdA);
            receivedByA = true;
          } catch (e) {
            socketA.disconnect();
            socketB.disconnect();
            done(e);
          }
        });

        socketB.on('nuevo_mensaje', () => {
          receivedByB = true;
        });

        // Wait for sockets to connect
        let connectedCount = 0;
        const onConnect = async () => {
          connectedCount++;
          if (connectedCount === 2) {
            // Trigger human message POST
            try {
              const res = await request(app)
                .post(`/conversations/${conversationIdA}/mensajes-humano`)
                .set('Authorization', `Bearer ${jwtTokenA}`)
                .send({ body: 'Hola de parte del operador humano' });

              expect(res.status).toBe(201);
              expect(res.body.message_id).toBeDefined();

              // Verify database record
              const dbMsgs = await pool.query('SELECT * FROM messages WHERE conversation_id = $1;', [
                conversationIdA,
              ]);
              expect(dbMsgs.rows.length).toBe(1);
              expect(dbMsgs.rows[0].body).toBe('Hola de parte del operador humano');
              expect(dbMsgs.rows[0].generated_by).toBe('humano');
              expect(dbMsgs.rows[0].user_id).toBe(operatorUserIdA);

              // Check if WhatsApp function was called
              expect(mockSendTextMessage).toHaveBeenCalledWith('5001112233', 'Hola de parte del operador humano');

              // Wait slightly for WebSocket emission
              setTimeout(() => {
                try {
                  expect(receivedByA).toBe(true);
                  expect(receivedByB).toBe(false);
                  socketA.disconnect();
                  socketB.disconnect();
                  done();
                } catch (e) {
                  socketA.disconnect();
                  socketB.disconnect();
                  done(e);
                }
              }, 150);
            } catch (postErr) {
              socketA.disconnect();
              socketB.disconnect();
              done(postErr);
            }
          }
        };

        socketA.on('connect', onConnect);
        socketB.on('connect', onConnect);
      }
    );
  });

  it('should enforce multi-tenant isolation: operator B cannot send human message to conversation A', async () => {
    // 1. Pause conversation A
    await pool.query(`UPDATE conversations SET status = 'pausada_humano' WHERE id = $1;`, [
      conversationIdA,
    ]);

    // 2. Operator B tries to post to conversation A
    const res = await request(app)
      .post(`/conversations/${conversationIdA}/mensajes-humano`)
      .set('Authorization', `Bearer ${jwtTokenB}`)
      .send({ body: 'Hack message' });

    expect(res.status).toBe(404); // Conversation not found for Business B
    expect(res.body.error).toContain('Conversation not found');
  });
});
