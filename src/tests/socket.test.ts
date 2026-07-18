import http from 'http';
import jwt from 'jsonwebtoken';
import { io as ClientIO, Socket as ClientSocket } from 'socket.io-client';
import app from '../app';
import { config } from '../config';
import { dbEvents } from '../services/events.service';
import { initSocketServer } from '../services/socket.service';
import { pool, saveMessage, updateConversationState } from '../services/db.service';
import { runMigrations } from '../migrations';

describe('Socket.io Real-time Events and Multi-Tenant Isolation', () => {
  const testSchema = 'test_sockets_isolation';
  let server: http.Server;
  let port: number;
  let jwtTokenA: string;
  let jwtTokenB: string;
  let conversationIdA: number;
  let originalConnect: any;
  let originalQuery: any;

  beforeAll(async () => {
    // Save original pool connection methods
    originalConnect = pool.connect;
    originalQuery = pool.query;

    // Patch pool.connect to automatically set search_path
    // @ts-expect-error: overriding pool method signatures for testing
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

    // Patch pool.query to utilize the path-configured client
    // @ts-expect-error: overriding pool method signatures for testing
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

    // 1. Setup clean schema and migrations for test DB isolation
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runMigrations(pool);

    // Seed businesses
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES 
        (10, 'Business A', 'phone_number_socket_a'),
        (20, 'Business B', 'phone_number_socket_b')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create a conversation for Business A and Business B
    const resA = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('111111', 10, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationIdA = resA.rows[0].id;

    await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('222222', 20, 'activa_ia', 'saludo')
      RETURNING id;
    `);

    // Generate JWT tokens for authentication tests
    jwtTokenA = jwt.sign({ business_id: 10, user_id: 100 }, config.jwtSecret);
    jwtTokenB = jwt.sign({ business_id: 20, user_id: 200 }, config.jwtSecret);

    // 2. Spin up HTTP server on a dynamic port
    server = http.createServer(app);
    initSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'string' ? 3000 : addr?.port || 3000;
        console.log(`[TEST]: Test HTTP & WS server started on port ${port}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Restore original pool methods
    pool.connect = originalConnect;
    pool.query = originalQuery;

    // Clean up connections, database state, and end pool
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log('[TEST]: Test server stopped');
          resolve();
        });
      });
    }
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  it('should reject connection when JWT is missing or invalid', (done) => {
    const socketUrl = `http://localhost:${port}`;
    const invalidSocket = ClientIO(socketUrl, {
      auth: { token: 'Bearer invalid_jwt_token_here' },
      transports: ['websocket'],
      forceNew: true,
    });

    invalidSocket.on('connect_error', (err) => {
      expect(err.message).toContain('Authentication error');
      invalidSocket.disconnect();
      done();
    });
  });

  describe('Authenticated socket client operations', () => {
    let socketA: ClientSocket;
    let socketB: ClientSocket;

    beforeEach((done) => {
      const socketUrl = `http://localhost:${port}`;

      socketA = ClientIO(socketUrl, {
        auth: { token: `Bearer ${jwtTokenA}` },
        transports: ['websocket'],
        forceNew: true,
      });

      socketB = ClientIO(socketUrl, {
        auth: { token: `Bearer ${jwtTokenB}` },
        transports: ['websocket'],
        forceNew: true,
      });

      let connectedCount = 0;
      const checkDone = () => {
        connectedCount++;
        if (connectedCount === 2) {
          done();
        }
      };

      socketA.on('connect', checkDone);
      socketB.on('connect', checkDone);
    });

    afterEach(() => {
      if (socketA && socketA.connected) socketA.disconnect();
      if (socketB && socketB.connected) socketB.disconnect();
    });

    it('should receive nuevo_mensaje only on Business A when a new user message for Business A arrives', (done) => {
      let receivedByA = false;
      let receivedByB = false;

      socketA.on('nuevo_mensaje', (msg) => {
        expect(msg.business_id).toBe(10);
        expect(msg.body).toBe('Test message client A');
        receivedByA = true;
      });

      socketB.on('nuevo_mensaje', () => {
        receivedByB = true;
      });

      // Trigger message_saved event
      dbEvents.emit('message_saved', {
        id: 999,
        conversation_id: conversationIdA,
        message_id: 'wamid.socket_test_a',
        sender: 'user',
        body: 'Test message client A',
        business_id: 10,
        created_at: new Date(),
      });

      setTimeout(() => {
        expect(receivedByA).toBe(true);
        expect(receivedByB).toBe(false);
        done();
      }, 100);
    });

    it('should receive conversacion_actualizada only on Business A when state changes for Business A', (done) => {
      let receivedByA = false;
      let receivedByB = false;

      socketA.on('conversacion_actualizada', (conv) => {
        expect(conv.business_id).toBe(10);
        expect(conv.status).toBe('pausada_humano');
        receivedByA = true;
      });

      socketB.on('conversacion_actualizada', () => {
        receivedByB = true;
      });

      // Trigger conversation_updated event
      dbEvents.emit('conversation_updated', {
        id: conversationIdA,
        customer_number: '111111',
        business_id: 10,
        status: 'pausada_humano',
        sales_state: 'saludo',
      });

      setTimeout(() => {
        expect(receivedByA).toBe(true);
        expect(receivedByB).toBe(false);
        done();
      }, 100);
    });

    it('should trigger events through database functions saveMessage and updateConversationState integration', (done) => {
      let receivedMsgA = false;
      let receivedMsgB = false;
      let receivedStateA = false;
      let receivedStateB = false;

      const checkFinished = () => {
        if (receivedMsgA && receivedStateA) {
          try {
            expect(receivedMsgB).toBe(false);
            expect(receivedStateB).toBe(false);
            done();
          } catch (err) {
            done(err);
          }
        }
      };

      socketA.on('nuevo_mensaje', (msg) => {
        console.log('[TEST CLIENT A RECEIVED MSG]:', JSON.stringify(msg));
        if (msg.body === 'Direct DB save message') {
          receivedMsgA = true;
          checkFinished();
        }
      });

      socketB.on('nuevo_mensaje', (msg) => {
        console.log('[TEST CLIENT B RECEIVED MSG]:', JSON.stringify(msg));
        receivedMsgB = true;
      });

      socketA.on('conversacion_actualizada', (conv) => {
        console.log('[TEST CLIENT A RECEIVED STATE]:', JSON.stringify(conv));
        if (conv.id === conversationIdA && conv.status === 'pausada_humano') {
          receivedStateA = true;
          checkFinished();
        }
      });

      socketB.on('conversacion_actualizada', (conv) => {
        console.log('[TEST CLIENT B RECEIVED STATE]:', JSON.stringify(conv));
        receivedStateB = true;
      });

      // 1. Run actual DB calls
      (async () => {
        try {
          console.log('[TEST]: Saving message to database...');
          // Save an incoming user message to Conversation A (business_id 10)
          const savedMsgId = await saveMessage(
            conversationIdA,
            'wamid.socket_test_integration',
            'user',
            'Direct DB save message',
          );
          console.log('[TEST]: Message saved with ID:', savedMsgId);

          console.log('[TEST]: Updating conversation state...');
          // Update Conversation A state to 'pausada_humano'
          await updateConversationState(conversationIdA, { status: 'pausada_humano' });
          console.log('[TEST]: Conversation state updated');
        } catch (error) {
          console.error('[TEST DB ERROR]:', error);
          done(error);
        }
      })();
    });
  });
});
