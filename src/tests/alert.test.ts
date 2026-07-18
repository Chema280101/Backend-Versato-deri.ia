import http from 'http';
import jwt from 'jsonwebtoken';
import { io as ClientIO } from 'socket.io-client';
import app from '../app';
import { config } from '../config';
import { pool, getConversationsByBusiness, getConversationById, saveMessage } from '../services/db.service';
import { runMigrations } from '../migrations';
import { initSocketServer } from '../services/socket.service';
import { checkPendingAlerts } from '../services/alert.service';

describe('Stagnant Operator Response Alert Tests', () => {
  const testSchema = 'test_operator_alerts';
  let server: http.Server;
  let port: number;
  let jwtTokenA: string;
  let jwtTokenB: string;
  let conversationIdA: number;
  let conversationIdB: number;
  let originalConnect: any;
  let originalQuery: any;

  beforeAll(async () => {
    originalConnect = pool.connect;
    originalQuery = pool.query;

    // Patch pool.connect to run under the isolated test schema
    // @ts-ignore
    pool.connect = function (this: any, ...args: any[]) {
      const callback = typeof args[0] === 'function' ? args[0] : null;
      if (callback) {
        return originalConnect.call(this, (err: any, client: any, release: any) => {
          if (err) return callback(err);
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

    // Patch pool.query to run under the isolated test schema
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
          if (err) return actualCallback(err);
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

    // 3. Populate businesses with custom configurations
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id, alert_pending_threshold_hours)
      VALUES 
        (10, 'Business A (2h limit)', 'phone_a', 2),
        (20, 'Business B (1h limit)', 'phone_b', 1)
      ON CONFLICT (id) DO NOTHING;
    `);

    // JWT Tokens
    jwtTokenA = jwt.sign({ business_id: 10, user_id: 100 }, config.jwtSecret);
    jwtTokenB = jwt.sign({ business_id: 20, user_id: 200 }, config.jwtSecret);

    // 4. Spin up HTTP & WS server
    server = http.createServer(app);
    initSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'string' ? 3000 : addr?.port || 3000;
        resolve();
      });
    });
  });

  afterAll(async () => {
    pool.connect = originalConnect;
    pool.query = originalQuery;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }

    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');

    // Setup default conversations
    const resA = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('500111', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdA = resA.rows[0].id;

    const resB = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('500222', 20, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdB = resB.rows[0].id;
  });

  describe('Database On-the-fly Alert Pending Calculation', () => {
    it('should return alert_pending as false when status is activa_ia', async () => {
      // Even if messages are very old, if status is activa_ia it should be false
      const msgId = await saveMessage(conversationIdA, 'msg_1', 'user', 'Hola', 'user');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'5 hours\' WHERE id = $1;', [msgId]);

      const convs = await getConversationsByBusiness(10);
      expect(convs.length).toBe(1);
      expect(convs[0].alert_pending).toBe(false);

      const convSingle = await getConversationById(conversationIdA);
      expect(convSingle?.alert_pending).toBe(false);
    });

    it('should return alert_pending as false when status is pausada_humano but the user message is recent', async () => {
      // Pause AI
      await pool.query('UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;', [conversationIdA]);
      
      // User message sent 10 minutes ago (less than 2 hours threshold)
      const msgId = await saveMessage(conversationIdA, 'msg_2', 'user', 'Hola de nuevo', 'user');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'10 minutes\' WHERE id = $1;', [msgId]);

      const convs = await getConversationsByBusiness(10);
      expect(convs[0].alert_pending).toBe(false);
    });

    it('should return alert_pending as true when status is pausada_humano and last message is from user and exceeds threshold', async () => {
      // Pause AI
      await pool.query('UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;', [conversationIdA]);
      
      // User message sent 3 hours ago (more than 2 hours threshold)
      const msgId = await saveMessage(conversationIdA, 'msg_3', 'user', 'Tengo una duda', 'user');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'3 hours\' WHERE id = $1;', [msgId]);

      const convs = await getConversationsByBusiness(10);
      expect(convs[0].alert_pending).toBe(true);

      const convSingle = await getConversationById(conversationIdA);
      expect(convSingle?.alert_pending).toBe(true);
    });

    it('should respect custom business thresholds: Business B has 1h limit', async () => {
      // Pause Business B
      await pool.query('UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;', [conversationIdB]);

      // Message from user sent 1.5 hours ago (exceeds Business B threshold of 1h)
      const msgId = await saveMessage(conversationIdB, 'msg_4', 'user', 'Alguien ahí?', 'user');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'90 minutes\' WHERE id = $1;', [msgId]);

      const convs = await getConversationsByBusiness(20);
      expect(convs[0].alert_pending).toBe(true);
    });

    it('should return alert_pending as false if the last message is from human, even if it is old', async () => {
      // Pause AI
      await pool.query('UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;', [conversationIdA]);

      // Operator replies 3 hours ago
      const msgId = await saveMessage(conversationIdA, 'msg_5', 'bot', 'En qué le ayudo?', 'humano');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'3 hours\' WHERE id = $1;', [msgId]);

      const convs = await getConversationsByBusiness(10);
      expect(convs[0].alert_pending).toBe(false);
    });

    it('should handle user replies after human operator messages correctly', async () => {
      // Pause AI
      await pool.query('UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;', [conversationIdA]);

      // 1. Operator replies 4 hours ago (clears alert)
      const msgId1 = await saveMessage(conversationIdA, 'msg_6', 'bot', 'Hola', 'humano');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'4 hours\' WHERE id = $1;', [msgId1]);

      // 2. User replies 1 hour ago (starts timer, but less than 2 hours)
      const msgId2 = await saveMessage(conversationIdA, 'msg_7', 'user', 'Hola operador', 'user');
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'1 hour\' WHERE id = $1;', [msgId2]);

      let convs = await getConversationsByBusiness(10);
      expect(convs[0].alert_pending).toBe(false);

      // 3. Update user message to 2.5 hours ago (exceeds 2 hours)
      await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'150 minutes\' WHERE id = $1;', [msgId2]);

      convs = await getConversationsByBusiness(10);
      expect(convs[0].alert_pending).toBe(true);
    });
  });

  describe('WebSocket alerta_pendiente Emission and Periodic Scheduler Integration', () => {
    it('should emit alerta_pendiente via socket when checkPendingAlerts detects stagnant chats', (done) => {
      // Pause conversation and insert stagnant message
      pool.query(
        'UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;',
        [conversationIdA],
        async (updateErr) => {
          if (updateErr) return done(updateErr);

          const msgId = await saveMessage(conversationIdA, 'msg_ws', 'user', 'Hola', 'user');
          await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'3 hours\' WHERE id = $1;', [msgId]);

          // Connect client socket
          const socketUrl = `http://localhost:${port}`;
          const socketA = ClientIO(socketUrl, {
            auth: { token: `Bearer ${jwtTokenA}` },
            transports: ['websocket'],
            forceNew: true,
          });

          socketA.on('connect', async () => {
            // Trigger checkPendingAlerts manually
            await checkPendingAlerts();
          });

          socketA.on('alerta_pendiente', (data) => {
            try {
              expect(data.conversation_id).toBe(conversationIdA);
              socketA.disconnect();
              done();
            } catch (e) {
              socketA.disconnect();
              done(e);
            }
          });
        }
      );
    });

    it('should NOT emit alert to Business B room for Business A conversations', (done) => {
      // Pause Business A conversation and make stagnant
      pool.query(
        'UPDATE conversations SET status = \'pausada_humano\' WHERE id = $1;',
        [conversationIdA],
        async (updateErr) => {
          if (updateErr) return done(updateErr);

          const msgId = await saveMessage(conversationIdA, 'msg_ws_isolation', 'user', 'Hola', 'user');
          await pool.query('UPDATE messages SET created_at = NOW() - INTERVAL \'3 hours\' WHERE id = $1;', [msgId]);

          const socketUrl = `http://localhost:${port}`;
          
          // Connect Client B (should NOT receive alert)
          const socketB = ClientIO(socketUrl, {
            auth: { token: `Bearer ${jwtTokenB}` },
            transports: ['websocket'],
            forceNew: true,
          });

          let receivedByB = false;
          socketB.on('alerta_pendiente', () => {
            receivedByB = true;
          });

          socketB.on('connect', async () => {
            await checkPendingAlerts();
            
            // Wait to ensure client B receives nothing
            setTimeout(() => {
              try {
                expect(receivedByB).toBe(false);
                socketB.disconnect();
                done();
              } catch (e) {
                socketB.disconnect();
                done(e);
              }
            }, 100);
          });
        }
      );
    });
  });
});
