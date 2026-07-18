import request from 'supertest';
import crypto from 'crypto';
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

describe('Webhook End-to-End Tests', () => {
  const testSchema = 'test_webhook_e2e';
  const testAppSecret = 'test_app_secret_val';
  let originalConnect: any;
  let originalQuery: any;
  let originalAppSecret: string;
  let mockLLM: MockLLMProvider;

  beforeAll(async () => {
    originalConnect = pool.connect;
    originalQuery = pool.query;

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

    // 2. Run migrations
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await runMigrations(pool);

    // 3. Populate default business configuration
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id, brand_prompt, escalation_threshold)
      VALUES (1, 'Cafe Antigravity', '106540352242922', 'Servir el mejor café', 100.00)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Configure the engine to use MockLLMProvider
    mockLLM = new MockLLMProvider();
    // @ts-ignore
    conversationalEngine.llmProvider = mockLLM;
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
    // Clean dynamic tables
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

  it('E2E Case 1: Complete successful sale flow (greeting -> need -> product recommendation -> checkout -> confirmed)', async () => {
    const customerNumber = '5001112233';

    // --- Turn 1: Greeting ("Hola") ---
    mockLLM.setResponse({
      text: '¡Hola! Bienvenido a Cafe Antigravity. ¿Qué te gustaría ordenar hoy?',
      decision: { accion: 'avanzar_a:calificacion_necesidad' },
    });

    let response = await sendWebhookMessage(customerNumber, 'Hola', 'wamid.msg1');
    expect(response.status).toBe(200);

    // Wait for async processing to write the trace log
    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(1);
    });

    // Verify DB states and tracing
    let { rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    );
    expect(convs.length).toBe(1);
    expect(convs[0].status).toBe('activa_ia');
    expect(convs[0].sales_state).toBe('calificacion_necesidad');

    let { rows: traces } = await pool.query('SELECT * FROM conversation_traces ORDER BY id DESC;');
    expect(traces[0].status_before).toBe('activa_ia');
    expect(traces[0].sales_state_before).toBe('saludo');
    expect(traces[0].status_after).toBe('activa_ia');
    expect(traces[0].sales_state_after).toBe('calificacion_necesidad');
    expect(traces[0].escalation_triggered).toBe(false);
    expect(traces[0].llm_decision).toEqual({ accion: 'avanzar_a:calificacion_necesidad' });

    expect(mockSendTextMessage).toHaveBeenLastCalledWith(
      customerNumber,
      '¡Hola! Bienvenido a Cafe Antigravity. ¿Qué te gustaría ordenar hoy?',
    );

    // --- Turn 2: Describe need ("Busco algo dulce") ---
    mockLLM.setResponse({
      text: 'Te recomiendo nuestro Croissant de Jamón y Queso o un delicioso Capuchino.',
      decision: { accion: 'avanzar_a:recomendacion_producto' },
    });

    response = await sendWebhookMessage(customerNumber, 'Busco algo dulce', 'wamid.msg2');
    expect(response.status).toBe(200);

    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(2);
    });

    ({ rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    ));
    expect(convs[0].sales_state).toBe('recomendacion_producto');

    ({ rows: traces } = await pool.query('SELECT * FROM conversation_traces ORDER BY id DESC;'));
    expect(traces[0].sales_state_before).toBe('calificacion_necesidad');
    expect(traces[0].sales_state_after).toBe('recomendacion_producto');

    // --- Turn 3: Checkout / payment details ("Me llevo el croissant y capuchino, cobrar") ---
    mockLLM.setResponse({
      text: 'Perfecto, el total es $7.50. ¿Deseas proceder al pago?',
      decision: { accion: 'avanzar_a:cierre_y_pago' },
    });

    // Update conversation amount to simulate order value
    await pool.query('UPDATE conversations SET amount = 7.50 WHERE customer_number = $1;', [
      customerNumber,
    ]);

    response = await sendWebhookMessage(
      customerNumber,
      'Me llevo el croissant y capuchino, cobrar',
      'wamid.msg3',
    );
    expect(response.status).toBe(200);

    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(3);
    });

    ({ rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    ));
    expect(convs[0].sales_state).toBe('cierre_y_pago');

    ({ rows: traces } = await pool.query('SELECT * FROM conversation_traces ORDER BY id DESC;'));
    expect(traces[0].sales_state_before).toBe('recomendacion_producto');
    expect(traces[0].sales_state_after).toBe('cierre_y_pago');

    const { rows: testCatalog } = await pool.query(
      'SELECT id, precio FROM catalog_items WHERE business_id = 1 AND activo = true LIMIT 1;'
    );
    const validItemId = testCatalog[0].id;
    const validItemPrice = parseFloat(testCatalog[0].precio);

    // --- Turn 4: Confirmation ("Listo, ya transferí") ---
    mockLLM.setResponse({
      text: '¡Muchas gracias! Pago confirmado. Tu orden está en preparación.',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [{ catalog_item_id: validItemId, cantidad: 1 }],
          total: validItemPrice,
        },
      },
    });

    response = await sendWebhookMessage(customerNumber, 'Listo, ya transferí', 'wamid.msg4');
    expect(response.status).toBe(200);

    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(4);
    });

    ({ rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    ));
    expect(convs[0].sales_state).toBe('confirmado');

    ({ rows: traces } = await pool.query('SELECT * FROM conversation_traces ORDER BY id DESC;'));
    expect(traces[0].sales_state_before).toBe('cierre_y_pago');
    expect(traces[0].sales_state_after).toBe('confirmado');
  });

  it('E2E Case 2: Human escalation triggered immediately by strong complaint (dissatisfaction)', async () => {
    const customerNumber = '5004445555';

    // Send complaint message
    const response = await sendWebhookMessage(
      customerNumber,
      'Esto es una estafa, no me llego el pedido y quiero mi dinero!',
      'wamid.complaint1',
    );
    expect(response.status).toBe(200);

    // Wait for async processing to write the trace
    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(1);
    });

    // Verify DB states: escalated immediately, LLM bypassed
    const { rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    );
    expect(convs.length).toBe(1);
    expect(convs[0].status).toBe('pausada_humano');
    expect(convs[0].sales_state).toBe('escalado_humano');

    // LLM should not have been called
    expect(mockLLM.lastContext).toBeUndefined();

    // Verify tracing log details
    const { rows: traces } = await pool.query(
      'SELECT * FROM conversation_traces ORDER BY id DESC;',
    );
    expect(traces[0].status_before).toBe('activa_ia');
    expect(traces[0].sales_state_before).toBe('saludo');
    expect(traces[0].status_after).toBe('pausada_humano');
    expect(traces[0].sales_state_after).toBe('escalado_humano');
    expect(traces[0].escalation_triggered).toBe(true);
    expect(traces[0].escalation_reason).toContain('Escalamiento de seguridad: dissatisfaction');

    // Verify notifications table
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = (SELECT id FROM conversations WHERE customer_number = $1);',
      [customerNumber],
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe('dissatisfaction');

    // Verify WhatsApp reply sent is the human handoff prompt
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      customerNumber,
      'Te estoy transfiriendo con un agente humano para ayudarte mejor.',
    );
  });

  it('E2E Case 3: Off-topic / out-of-scope query (Meta policy compliance)', async () => {
    const customerNumber = '5007778888';

    // Mock LLM response to simulate off-topic response: maintains current state and gives off-topic message
    mockLLM.setResponse({
      text: 'Lo siento, solo puedo ayudarte con información de Cafe Antigravity (productos, pedidos y políticas). ¿Deseas ver nuestro catálogo?',
      decision: { accion: 'mantener_estado' },
    });

    const response = await sendWebhookMessage(
      customerNumber,
      '¿Cuál es la capital de Francia?',
      'wamid.offtopic1',
    );
    expect(response.status).toBe(200);

    // Wait for async processing to write the trace
    await waitFor(async () => {
      const { rows: traces } = await pool.query(
        'SELECT * FROM conversation_traces ORDER BY id DESC;',
      );
      expect(traces.length).toBe(1);
    });

    // Verify state remained the same
    const { rows: convs } = await pool.query(
      'SELECT status, sales_state FROM conversations WHERE customer_number = $1;',
      [customerNumber],
    );
    expect(convs.length).toBe(1);
    expect(convs[0].status).toBe('activa_ia');
    expect(convs[0].sales_state).toBe('saludo'); // Initial state did not change

    // Verify trace logged details
    const { rows: traces } = await pool.query(
      'SELECT * FROM conversation_traces ORDER BY id DESC;',
    );
    expect(traces[0].status_before).toBe('activa_ia');
    expect(traces[0].sales_state_before).toBe('saludo');
    expect(traces[0].status_after).toBe('activa_ia');
    expect(traces[0].sales_state_after).toBe('saludo');
    expect(traces[0].escalation_triggered).toBe(false);
    expect(traces[0].llm_decision).toEqual({ accion: 'mantener_estado' });

    // Verify standard reply was sent
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      customerNumber,
      'Lo siento, solo puedo ayudarte con información de Cafe Antigravity (productos, pedidos y políticas). ¿Deseas ver nuestro catálogo?',
    );
  });
});
