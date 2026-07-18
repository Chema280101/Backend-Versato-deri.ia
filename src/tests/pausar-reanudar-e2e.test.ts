import request from 'supertest';
import crypto from 'crypto';
import bcryptjs from 'bcryptjs';
import app from '../app';
import { config } from '../config';
import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import { conversationalEngine } from '../routes/webhook.routes';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';
import * as whatsappService from '../services/whatsapp.service';

// Mock the outbound WhatsApp service so we do not make actual Meta API requests
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_outgoing_msg_id'),
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

describe('Conversations Pause and Resume E2E Tests', () => {
  const testSchema = 'test_pause_resume_e2e';
  const testAppSecret = 'test_app_secret_val';
  let originalConnect: any;
  let originalQuery: any;
  let originalAppSecret: string;
  let mockLLM: MockLLMProvider;
  let jwtToken: string;
  let conversationId: number;
  let operatorUserId: number;

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

    // 3. Populate business
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id, brand_prompt, escalation_threshold)
      VALUES (1, 'Cafe Antigravity', '106540352242922', 'Servir el mejor café', 100.00)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 4. Populate operator user
    const passwordHash = bcryptjs.hashSync('testpassword', 10);
    const userRes = await pool.query(
      `
      INSERT INTO users (business_id, email, password_hash, nombre, rol)
      VALUES (1, 'operator@test.com', $1, 'Operator User', 'operator')
      RETURNING id;
    `,
      [passwordHash],
    );
    operatorUserId = userRes.rows[0].id;

    // Configure mock LLM
    mockLLM = new MockLLMProvider();
    // @ts-ignore
    conversationalEngine.llmProvider = mockLLM;

    // 5. Log in to get authentication token
    const loginRes = await request(app)
      .post('/auth/login')
      .send({ email: 'operator@test.com', password: 'testpassword' });
    jwtToken = loginRes.body.token;
  });

  afterAll(async () => {
    config.whatsapp.appSecret = originalAppSecret;

    // Restore original pool methods
    pool.connect = originalConnect;
    pool.query = originalQuery;

    // Clean up
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLLM.clearQueue();
    mockLLM.lastContext = undefined;

    // Clean tables
    await pool.query('DELETE FROM audit_logs;');
    await pool.query('DELETE FROM conversation_traces;');
    await pool.query('DELETE FROM notifications;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');

    // Create a default active conversation
    const res = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5001112233', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    conversationId = res.rows[0].id;
  });

  const getSignatureHeader = (body: string | object): string => {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = crypto.createHmac('sha256', testAppSecret).update(rawBody).digest('hex');
    return `sha256=${hmac}`;
  };

  const sendWebhookMessage = async (from: string, bodyText: string, messageId: string) => {
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
                  phone_number_id: '106540352242922',
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

  it('should successfully pause conversation, verify that webhook bypasses LLM and doesn\'t reply, then successfully resume', async () => {
    // 1. Pause conversation via POST /conversations/:id/pausar
    const pauseRes = await request(app)
      .post(`/conversations/${conversationId}/pausar`)
      .set('Authorization', `Bearer ${jwtToken}`);

    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.message).toBe('Conversational AI paused successfully');

    // Verify conversation status is updated in database
    const convRes1 = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE id = $1;',
      [conversationId],
    );
    expect(convRes1.rows[0].status).toBe('pausada_humano');

    // Verify audit log entry was created
    const auditRes1 = await pool.query('SELECT * FROM audit_logs WHERE conversation_id = $1;', [
      conversationId,
    ]);
    expect(auditRes1.rows.length).toBe(1);
    expect(auditRes1.rows[0].action).toBe('pause_ai');
    expect(auditRes1.rows[0].user_id).toBe(operatorUserId);
    expect(auditRes1.rows[0].business_id).toBe(1);
    expect(auditRes1.rows[0].created_at).toBeDefined();

    // 2. Simulate webhook message when paused
    // Set a response in mock LLM (should NOT be used because LLM is bypassed)
    mockLLM.setResponse({
      text: 'Esta respuesta no debería enviarse jamás.',
      decision: { accion: 'mantener_estado' },
    });

    const webhookRes = await sendWebhookMessage('5001112233', 'Hola bot pausado', 'wamid.msg_paused_test');
    expect(webhookRes.status).toBe(200);

    // Wait for the async webhook processing to finish by verifying that a trace was logged
    await waitFor(async () => {
      const traces = await pool.query(
        'SELECT * FROM conversation_traces WHERE conversation_id = $1 ORDER BY id DESC;',
        [conversationId],
      );
      // There should be two traces: 1 for manual pause action, 1 for webhook message bypass trace
      expect(traces.rows.length).toBe(2);
    });

    // Verify that the LLM was indeed bypassed
    expect(mockLLM.lastContext).toBeUndefined();

    // Verify that the bot did NOT send any WhatsApp message
    expect(mockSendTextMessage).not.toHaveBeenCalled();

    // Verify that the message was still saved to messages table
    const messagesRes = await pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id DESC;',
      [conversationId],
    );
    expect(messagesRes.rows.length).toBe(1);
    expect(messagesRes.rows[0].body).toBe('Hola bot pausado');
    expect(messagesRes.rows[0].sender).toBe('user');

    // Verify that conversation status remained 'pausada_humano'
    const convRes2 = await pool.query('SELECT status FROM conversations WHERE id = $1;', [
      conversationId,
    ]);
    expect(convRes2.rows[0].status).toBe('pausada_humano');

    // 3. Resume conversation via POST /conversations/:id/reanudar
    const resumeRes = await request(app)
      .post(`/conversations/${conversationId}/reanudar`)
      .set('Authorization', `Bearer ${jwtToken}`);

    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.message).toBe('Conversational AI resumed successfully');

    // Verify conversation status is active again
    const convRes3 = await pool.query('SELECT status FROM conversations WHERE id = $1;', [
      conversationId,
    ]);
    expect(convRes3.rows[0].status).toBe('activa_ia');

    // Verify a second audit log entry was created
    const auditRes2 = await pool.query(
      'SELECT * FROM audit_logs WHERE conversation_id = $1 ORDER BY id ASC;',
      [conversationId],
    );
    expect(auditRes2.rows.length).toBe(2);
    expect(auditRes2.rows[1].action).toBe('resume_ai');
    expect(auditRes2.rows[1].user_id).toBe(operatorUserId);
  });
});
