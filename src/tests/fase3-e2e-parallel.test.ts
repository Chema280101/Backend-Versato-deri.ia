import request from 'supertest';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcryptjs from 'bcryptjs';
import { io as ClientIO, Socket as ClientSocket } from 'socket.io-client';
import app from '../app';
import { config } from '../config';
import { pool, saveMessage, updateConversationState } from '../services/db.service';
import { runMigrations } from '../migrations';
import { initSocketServer } from '../services/socket.service';
import { conversationalEngine } from '../routes/webhook.routes';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';
import * as whatsappService from '../services/whatsapp.service';

let mockMessageCount = 0;
// Mock the outbound WhatsApp service so we do not make actual Meta API requests
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockImplementation(() => {
    mockMessageCount++;
    return Promise.resolve(`wamid.test_outgoing_msg_id_${mockMessageCount}`);
  }),
}));

const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

const waitFor = async (assertion: () => Promise<void> | void, timeout = 2500, interval = 50) => {
  const startTime = Date.now();
  while (true) {
    try {
      await assertion();
      return; // success!
    } catch (error) {
      if (Date.now() - startTime > timeout) {
        throw error; // timeout exceeded, throw last assertion error
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
};

describe('Phase 3 End-to-End Parallel Multi-Tenant Flow', () => {
  const testSchema = 'test_fase3_e2e_parallel';
  const testAppSecret = 'test_app_secret_val';
  let server: http.Server;
  let port: number;
  let originalConnect: any;
  let originalQuery: any;
  let originalAppSecret: string;
  let mockLLM: MockLLMProvider;

  let jwtTokenA: string;
  let jwtTokenB: string;
  let operatorUserIdA: number;
  let operatorUserIdB: number;
  let conversationIdA: number;

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

    originalAppSecret = config.whatsapp.appSecret;
    config.whatsapp.appSecret = testAppSecret;

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
      INSERT INTO businesses (id, name, phone_number_id, brand_prompt)
      VALUES 
        (10, 'Business A', 'phone_number_a', 'Servir el mejor café de A'),
        (20, 'Business B', 'phone_number_b', 'Servir el mejor café de B')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4. Populate users
    const passwordHash = bcryptjs.hashSync('testpassword', 10);
    const userARes = await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES (10, 'operatorA@test.com', $1, 'Operator A', 'operator')
      RETURNING id;
    `,
      [passwordHash],
    );
    operatorUserIdA = userARes.rows[0].id;

    const userBRes = await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES (20, 'operatorB@test.com', $1, 'Operator B', 'operator')
      RETURNING id;
    `,
      [passwordHash],
    );
    operatorUserIdB = userBRes.rows[0].id;

    // JWT Tokens
    jwtTokenA = jwt.sign({ business_id: 10, user_id: operatorUserIdA }, config.jwtSecret);
    jwtTokenB = jwt.sign({ business_id: 20, user_id: operatorUserIdB }, config.jwtSecret);

    // Setup Mock LLM Provider
    mockLLM = new MockLLMProvider();
    // @ts-ignore
    conversationalEngine.llmProvider = mockLLM;

    // 5. Spin up HTTP & WS server
    server = http.createServer(app);
    initSocketServer(server);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === 'string' ? 3000 : addr?.port || 3000;
        console.log(`[TEST]: Parallel E2E test server started on port ${port}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    config.whatsapp.appSecret = originalAppSecret;

    // Restore pool
    pool.connect = originalConnect;
    pool.query = originalQuery;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log('[TEST]: Parallel E2E test server stopped');
          resolve();
        });
      });
    }

    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLLM.clearQueue();
    mockLLM.lastContext = undefined;

    await pool.query('DELETE FROM audit_logs;');
    await pool.query('DELETE FROM conversation_traces;');
    await pool.query('DELETE FROM notifications;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');
  });

  const getSignatureHeader = (body: string | object): string => {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = crypto.createHmac('sha256', testAppSecret).update(rawBody).digest('hex');
    return `sha256=${hmac}`;
  };

  const sendWebhookMessage = async (from: string, bodyText: string, messageId: string, phoneNumberId: string) => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: phoneNumberId,
                },
                contacts: [
                  {
                    profile: { name: 'Test Customer' },
                    wa_id: from,
                  },
                ],
                messages: [
                  {
                    from,
                    id: messageId,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'text',
                    text: { body: bodyText },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const signature = getSignatureHeader(payload);
    return request(app).post('/webhook').set('X-Hub-Signature-256', signature).send(payload);
  };

  it('should run the complete multi-tenant E2E flow in parallel', (done) => {
    // 1. Establish WebSocket connections for Operator A and Operator B
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

    const eventsA: { event: string; data: any }[] = [];
    const eventsB: { event: string; data: any }[] = [];

    // Capture events for Operator A
    socketA.on('nuevo_mensaje', (msg) => {
      console.log('[TEST SOCKET A RECEIVED]: nuevo_mensaje', msg.body);
      eventsA.push({ event: 'nuevo_mensaje', data: msg });
    });
    socketA.on('conversacion_actualizada', (conv) => {
      console.log('[TEST SOCKET A RECEIVED]: conversacion_actualizada', conv.status);
      eventsA.push({ event: 'conversacion_actualizada', data: conv });
    });

    // Capture events for Operator B
    socketB.on('nuevo_mensaje', (msg) => {
      console.log('[TEST SOCKET B RECEIVED]: nuevo_mensaje', msg.body);
      eventsB.push({ event: 'nuevo_mensaje', data: msg });
    });
    socketB.on('conversacion_actualizada', (conv) => {
      console.log('[TEST SOCKET B RECEIVED]: conversacion_actualizada', conv.status);
      eventsB.push({ event: 'conversacion_actualizada', data: conv });
    });

    let connectedCount = 0;
    const runFlow = async () => {
      try {
        const customerNumberA = '5001112233';

        // --- STEP 1: Business A receives a normal message, AI responds normally ---
        mockLLM.setResponse({
          text: 'Hola, bienvenido a Cafe A! ¿Qué te gustaría ordenar hoy?',
          decision: { accion: 'avanzar_a:calificacion_necesidad' },
        });

        // Send webhook message representing customer A sending message to Business A (phone_number_a)
        const webhookRes1 = await sendWebhookMessage(
          customerNumberA,
          'Hola bot',
          'wamid.step1_msg',
          'phone_number_a',
        );
        expect(webhookRes1.status).toBe(200);

        // Wait for async engine execution to save trace and message
        await waitFor(async () => {
          const { rows: traces } = await pool.query(
            'SELECT * FROM conversation_traces ORDER BY id DESC;',
          );
          expect(traces.length).toBe(1);
        });

        // Verify conversation is active and in correct state
        const { rows: convs1 } = await pool.query(
          'SELECT id, status, sales_state FROM conversations WHERE customer_number = $1 AND business_id = 10;',
          [customerNumberA],
        );
        expect(convs1.length).toBe(1);
        conversationIdA = convs1[0].id;
        expect(convs1[0].status).toBe('activa_ia');
        expect(convs1[0].sales_state).toBe('calificacion_necesidad');

        // Verify socket events received by Operator A (only user messages are broadcasted, bot messages are filtered)
        await waitFor(() => {
          const newMsgEvent = eventsA.find((e) => e.event === 'nuevo_mensaje' && e.data.body === 'Hola bot');
          const convUpdateEvent = eventsA.find((e) => e.event === 'conversacion_actualizada');
          expect(newMsgEvent).toBeDefined();
          expect(convUpdateEvent).toBeDefined();
        });

        // Verify bot message is successfully saved to the database
        const botMsgs = await pool.query(
          "SELECT body, sender, generated_by FROM messages WHERE conversation_id = $1 AND sender = 'bot';",
          [conversationIdA],
        );
        expect(botMsgs.rows.length).toBe(1);
        expect(botMsgs.rows[0].body).toBe('Hola, bienvenido a Cafe A! ¿Qué te gustaría ordenar hoy?');
        expect(botMsgs.rows[0].generated_by).toBe('IA');

        // Ensure Operator B received NO events whatsoever from this conversation
        expect(eventsB.length).toBe(0);


        // --- STEP 2: Customer A complaint triggers automatic human escalation (from Phase 2) ---
        // Setup mock LLM response (should NOT be used because LLM is bypassed)
        mockLLM.setResponse({
          text: 'Esta respuesta no debería verse jamás.',
          decision: { accion: 'mantener_estado' },
        });

        // Send complaint message (dissatisfaction trigger)
        const webhookRes2 = await sendWebhookMessage(
          customerNumberA,
          'Esto es una estafa, no me llego el pedido y quiero mi dinero!',
          'wamid.step2_complaint',
          'phone_number_a',
        );
        expect(webhookRes2.status).toBe(200);

        // Wait for async engine execution
        await waitFor(async () => {
          const { rows: traces } = await pool.query(
            'SELECT * FROM conversation_traces ORDER BY id DESC;',
          );
          expect(traces.length).toBe(2);
        });

        // Verify DB states: escalated immediately, status = pausada_humano, sales_state = escalado_humano
        const { rows: convs2 } = await pool.query(
          'SELECT status, sales_state FROM conversations WHERE id = $1;',
          [conversationIdA],
        );
        expect(convs2[0].status).toBe('pausada_humano');
        expect(convs2[0].sales_state).toBe('escalado_humano');

        // Verify WhatsApp reply sent is the human handoff prompt
        expect(mockSendTextMessage).toHaveBeenCalledWith(
          customerNumberA,
          'Te estoy transfiriendo con un agente humano para ayudarte mejor.',
        );

        // Verify socket events for Operator A
        await waitFor(() => {
          const complaintEvent = eventsA.find((e) => e.event === 'nuevo_mensaje' && e.data.body.includes('estafa'));
          const updateToPausedEvent = eventsA.find(
            (e) => e.event === 'conversacion_actualizada' && e.data.status === 'pausada_humano',
          );
          expect(complaintEvent).toBeDefined();
          expect(updateToPausedEvent).toBeDefined();
        });

        // Verify socket events for Operator B: still completely isolated
        expect(eventsB.length).toBe(0);


        // --- STEP 3: Operator A pauses/confirms, writes a manual response, and reanuda ---
        // First confirm pause (idempotent pause endpoint)
        const pauseRes = await request(app)
          .post(`/conversations/${conversationIdA}/pausar`)
          .set('Authorization', `Bearer ${jwtTokenA}`);
        expect(pauseRes.status).toBe(200);

        // Verify audit log for pause action (should be 0 since conversation was already auto-paused, making this call idempotent)
        const auditPause = await pool.query(
          "SELECT * FROM audit_logs WHERE conversation_id = $1 AND action = 'pause_ai';",
          [conversationIdA],
        );
        expect(auditPause.rows.length).toBe(0);

        // Operator A sends manual message
        const manualMsgText = 'Hola, soy el operador de Cafe A. Lamento el inconveniente, reviso tu pedido inmediatamente.';
        const humanMsgRes = await request(app)
          .post(`/conversations/${conversationIdA}/mensajes-humano`)
          .set('Authorization', `Bearer ${jwtTokenA}`)
          .send({ body: manualMsgText });
        
        expect(humanMsgRes.status).toBe(201);
        expect(humanMsgRes.body.message_id).toBeDefined();

        // Verify DB message record
        const { rows: dbMsgs } = await pool.query(
          'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1;',
          [conversationIdA],
        );
        expect(dbMsgs[0].body).toBe(manualMsgText);
        expect(dbMsgs[0].generated_by).toBe('humano');
        expect(dbMsgs[0].user_id).toBe(operatorUserIdA);

        // Verify WhatsApp send function called with human response
        expect(mockSendTextMessage).toHaveBeenCalledWith(customerNumberA, manualMsgText);

        // Verify Operator A receives the new human message event
        await waitFor(() => {
          const humanMsgEvent = eventsA.find(
            (e) => e.event === 'nuevo_mensaje' && e.data.body === manualMsgText && e.data.generated_by === 'humano',
          );
          expect(humanMsgEvent).toBeDefined();
        });

        // Verify socket events for Operator B: still isolated
        expect(eventsB.length).toBe(0);


        // --- STEP 4: Operator A resumes the conversation ---
        const resumeRes = await request(app)
          .post(`/conversations/${conversationIdA}/reanudar`)
          .set('Authorization', `Bearer ${jwtTokenA}`);
        expect(resumeRes.status).toBe(200);

        // Verify DB status is active again
        const { rows: convs3 } = await pool.query(
          'SELECT status FROM conversations WHERE id = $1;',
          [conversationIdA],
        );
        expect(convs3[0].status).toBe('activa_ia');

        // Verify audit log for resume action
        const auditResume = await pool.query(
          "SELECT * FROM audit_logs WHERE conversation_id = $1 AND action = 'resume_ai';",
          [conversationIdA],
        );
        expect(auditResume.rows.length).toBe(1);
        expect(auditResume.rows[0].user_id).toBe(operatorUserIdA);

        // Verify Operator A receives conversation updated back to active
        await waitFor(() => {
          const activeStateEvent = eventsA.find(
            (e) => e.event === 'conversacion_actualizada' && e.data.status === 'activa_ia',
          );
          expect(activeStateEvent).toBeDefined();
        });

        // Verify socket events for Operator B: still isolated
        expect(eventsB.length).toBe(0);


        // --- STEP 5: Multi-Tenant REST API Authorization Checks for Operator B ---
        // Operator B should receive 404 when trying to read or write Business A's conversation
        const getMessagesRes = await request(app)
          .get(`/conversations/${conversationIdA}/messages`)
          .set('Authorization', `Bearer ${jwtTokenB}`);
        expect(getMessagesRes.status).toBe(404);

        const tryPauseRes = await request(app)
          .post(`/conversations/${conversationIdA}/pausar`)
          .set('Authorization', `Bearer ${jwtTokenB}`);
        expect(tryPauseRes.status).toBe(404);

        const tryHumanMsgRes = await request(app)
          .post(`/conversations/${conversationIdA}/mensajes-humano`)
          .set('Authorization', `Bearer ${jwtTokenB}`)
          .send({ body: 'Attack message' });
        expect(tryHumanMsgRes.status).toBe(404);

        const tryResumeRes = await request(app)
          .post(`/conversations/${conversationIdA}/reanudar`)
          .set('Authorization', `Bearer ${jwtTokenB}`);
        expect(tryResumeRes.status).toBe(404);

        // Verify that B has received absolutely 0 events during this whole process
        expect(eventsB.length).toBe(0);

        socketA.disconnect();
        socketB.disconnect();
        done();
      } catch (err) {
        socketA.disconnect();
        socketB.disconnect();
        done(err);
      }
    };

    const checkConnect = () => {
      connectedCount++;
      if (connectedCount === 2) {
        runFlow();
      }
    };

    socketA.on('connect', checkConnect);
    socketB.on('connect', checkConnect);
  });
});
