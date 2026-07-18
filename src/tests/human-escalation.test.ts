import {
  pool,
  saveMessage,
  getConversationState,
  updateBusinessEscalationThreshold,
} from '../services/db.service';
import { runMigrations } from '../migrations';
import { ConversationalEngine } from '../services/conversational-engine.service';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';
import * as whatsappService from '../services/whatsapp.service';

// Mock the outbound WhatsApp service
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_outgoing_msg_id'),
}));

const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

describe('Human Escalation Safety Rules', () => {
  const testSchema = 'test_human_escalation';
  let engine: ConversationalEngine;
  let mockLLM: MockLLMProvider;

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

    // 3. Populate default business config
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES (1, 'Test Business', '1234567890')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(async () => {
    // Clean up
    await pool.query('SET search_path TO public;');
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.end();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    mockLLM = new MockLLMProvider();
    engine = new ConversationalEngine(mockLLM);

    // Clean tables
    await pool.query('DELETE FROM notifications;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');

    // Reset business escalation threshold to default NULL
    await updateBusinessEscalationThreshold(1, null);
  });

  it('Rule 1: should escalate immediately and bypass LLM when customer message indicates strong dissatisfaction', async () => {
    // 1. Create active conversation in calificacion_necesidad stage
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5009990001', 1, 'activa_ia', 'calificacion_necesidad')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Save incoming user message
    const incomingText = 'Esto es una estafa, pésimo servicio!';
    await saveMessage(conversationId, 'wamid.in_1', 'user', incomingText);

    // Setup LLM mock response just in case (should not be called)
    mockLLM.setResponse({
      text: 'Respuesta LLM incorrecta',
      decision: { accion: 'mantener_estado' },
    });

    // 2. Process message
    await engine.processIncomingMessage(conversationId, '5009990001', incomingText);

    // 3. Verify LLM was bypassed
    expect(mockLLM.lastContext).toBeUndefined();

    // 4. Verify conversation state updated to pausada_humano / escalado_humano
    const state = await getConversationState(conversationId);
    expect(state?.status).toBe('pausada_humano');
    expect(state?.salesState).toBe('escalado_humano');
    expect(state?.consecutiveAttempts).toBe(0);

    // 5. Verify notification record created
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = $1;',
      [conversationId],
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe('dissatisfaction');
    expect(notifications[0].message).toContain('Cliente insatisfecho o con reclamo fuerte');

    // 6. Verify transfer reply sent to user
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5009990001',
      'Te estoy transfiriendo con un agente humano para ayudarte mejor.',
    );
  });

  it('Rule 2: should escalate immediately and bypass LLM when conversation amount exceeds business threshold', async () => {
    // 1. Set escalation threshold for business to 200.00
    await updateBusinessEscalationThreshold(1, 200.0);

    // 2. Create active conversation with amount = 250.00 (above threshold)
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state, amount)
      VALUES ('5009990002', 1, 'activa_ia', 'recomendacion_producto', 250.00)
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Save incoming user message
    const incomingText = 'Me interesa comprar ese producto';
    await saveMessage(conversationId, 'wamid.in_2', 'user', incomingText);

    // Setup LLM mock response (should not be called)
    mockLLM.setResponse({
      text: 'Respuesta LLM incorrecta',
      decision: { accion: 'mantener_estado' },
    });

    // 3. Process message
    await engine.processIncomingMessage(conversationId, '5009990002', incomingText);

    // 4. Verify LLM was bypassed
    expect(mockLLM.lastContext).toBeUndefined();

    // 5. Verify transition
    const state = await getConversationState(conversationId);
    expect(state?.status).toBe('pausada_humano');
    expect(state?.salesState).toBe('escalado_humano');

    // 6. Verify notification
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = $1;',
      [conversationId],
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe('amount_threshold');
    expect(notifications[0].message).toContain(
      'Monto de conversación (250) supera el umbral configurable (200)',
    );

    // 7. Verify transfer reply sent to user
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5009990002',
      'Te estoy transfiriendo con un agente humano para ayudarte mejor.',
    );
  });

  it('Rule 3: should escalate conversation after 3 consecutive attempts without advancing sales state', async () => {
    // 1. Create active conversation in calificacion_necesidad
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5009990003', 1, 'activa_ia', 'calificacion_necesidad')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Mock LLM to always propose maintaining current state
    mockLLM.setResponse({
      text: 'No entendí bien, puedes repetir?',
      decision: { accion: 'mantener_estado' },
    });

    // Attempt 1: State remains calificacion_necesidad
    await saveMessage(conversationId, 'wamid.in_3_1', 'user', 'Hola');
    await engine.processIncomingMessage(conversationId, '5009990003', 'Hola');
    let state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('calificacion_necesidad');
    expect(state?.consecutiveAttempts).toBe(1);
    expect(mockSendTextMessage).toHaveBeenLastCalledWith(
      '5009990003',
      'No entendí bien, puedes repetir?',
    );

    // Setup for Attempt 2
    mockLLM.setResponse({
      text: 'No entendí bien, puedes repetir?',
      decision: { accion: 'mantener_estado' },
    });

    // Attempt 2: State remains calificacion_necesidad
    await saveMessage(conversationId, 'wamid.in_3_2', 'user', 'Hola de nuevo');
    await engine.processIncomingMessage(conversationId, '5009990003', 'Hola de nuevo');
    state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('calificacion_necesidad');
    expect(state?.consecutiveAttempts).toBe(2);
    expect(mockSendTextMessage).toHaveBeenLastCalledWith(
      '5009990003',
      'No entendí bien, puedes repetir?',
    );

    // Setup for Attempt 3
    mockLLM.setResponse({
      text: 'No entendí bien, puedes repetir?',
      decision: { accion: 'mantener_estado' },
    });

    // Attempt 3: Counter hits 3 -> Escalate to human!
    await saveMessage(conversationId, 'wamid.in_3_3', 'user', 'Hola por favor ayuda');
    await engine.processIncomingMessage(conversationId, '5009990003', 'Hola por favor ayuda');
    state = await getConversationState(conversationId);

    // Verify transition to human agent
    expect(state?.status).toBe('pausada_humano');
    expect(state?.salesState).toBe('escalado_humano');
    expect(state?.consecutiveAttempts).toBe(0); // reset

    // Verify notification was created
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = $1;',
      [conversationId],
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe('consecutive_attempts');
    expect(notifications[0].message).toContain(
      "El bot no logró avanzar del estado 'calificacion_necesidad' después de 3 intentos consecutivos",
    );

    // Verify overridden reply was sent to user
    expect(mockSendTextMessage).toHaveBeenLastCalledWith(
      '5009990003',
      'He tenido problemas para entenderte. Te estoy transfiriendo con un agente humano.',
    );
  });

  it('Rule 4: should escalate immediately and bypass LLM when customer explicitly requests a human agent', async () => {
    // 1. Create active conversation in saludo stage
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5009990004', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Save incoming user message asking for operator
    const incomingText = 'Hola, por favor pásame con un operador humano.';
    await saveMessage(conversationId, 'wamid.in_4', 'user', incomingText);

    // Setup LLM mock response (should not be called)
    mockLLM.setResponse({
      text: 'Respuesta LLM incorrecta',
      decision: { accion: 'mantener_estado' },
    });

    // 2. Process message
    await engine.processIncomingMessage(conversationId, '5009990004', incomingText);

    // 3. Verify LLM bypass
    expect(mockLLM.lastContext).toBeUndefined();

    // 4. Verify transition
    const state = await getConversationState(conversationId);
    expect(state?.status).toBe('pausada_humano');
    expect(state?.salesState).toBe('escalado_humano');
    expect(state?.consecutiveAttempts).toBe(0);

    // 5. Verify notification
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = $1;',
      [conversationId],
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe('explicit_request');
    expect(notifications[0].message).toContain('Cliente solicitó agente humano explícitamente');

    // 6. Verify transfer reply sent to user
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5009990004',
      'Te estoy transfiriendo con un agente humano para ayudarte mejor.',
    );
  });

  it('Normal flow: should proceed with standard LLM conversation if no safety rules are met', async () => {
    // 1. Create active conversation in saludo stage with 0 amount
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5009990005', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Save incoming user message
    const incomingText = 'Hola, me gustaría comprar café';
    await saveMessage(conversationId, 'wamid.in_5', 'user', incomingText);

    // Setup LLM mock response to transition to calificacion_necesidad
    mockLLM.setResponse({
      text: 'Hola, claro! Qué tipo de café te gusta?',
      decision: { accion: 'avanzar_a:calificacion_necesidad' },
    });

    // 2. Process message
    await engine.processIncomingMessage(conversationId, '5009990005', incomingText);

    // 3. Verify LLM was called with correct context
    expect(mockLLM.lastContext).toBeDefined();
    expect(mockLLM.lastContext?.currentMessage).toBe(incomingText);

    // 4. Verify transition was successful
    const state = await getConversationState(conversationId);
    expect(state?.status).toBe('activa_ia');
    expect(state?.salesState).toBe('calificacion_necesidad');
    expect(state?.consecutiveAttempts).toBe(0);

    // 5. Verify no safety notifications created
    const { rows: notifications } = await pool.query(
      'SELECT * FROM notifications WHERE conversation_id = $1;',
      [conversationId],
    );
    expect(notifications.length).toBe(0);

    // 6. Verify standard bot reply sent
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5009990005',
      'Hola, claro! Qué tipo de café te gusta?',
    );
  });
});
