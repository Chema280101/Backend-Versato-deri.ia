import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import { ConversationalEngine } from '../services/conversational-engine.service';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';
import { updateConversationState } from '../services/db.service';

// Mock the outbound WhatsApp service so we do not make actual Meta API requests
const mockSendTextMessage = jest.fn().mockResolvedValue('wamid.test_satisfaction_msg_id');
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: (...args: any[]) => mockSendTextMessage(...args),
}));

describe('Satisfaction Ratings Integration Tests', () => {
  const testSchema = 'test_satisfaction_ratings';
  let engine: ConversationalEngine;
  let mockLLM: MockLLMProvider;

  beforeAll(async () => {
    // 1. Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations
    await runMigrations(pool);
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

    // Reset tables
    await pool.query('DELETE FROM satisfaction_ratings;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversation_traces;');
    await pool.query('DELETE FROM conversations;');
  });

  it('should automatically send satisfaction message when transitioning to postventa state', async () => {
    // 1. Create a conversation in 'confirmado' state
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550202', 1, 'activa_ia', 'confirmado')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // 2. Transition state to 'postventa'
    await updateConversationState(conversationId, { salesState: 'postventa' });

    // Verify WhatsApp mock was called with satisfaction survey text
    expect(mockSendTextMessage).toHaveBeenCalled();
    const calls = mockSendTextMessage.mock.calls;
    const sentText = calls[calls.length - 1][1];
    expect(sentText).toContain('califica');
    expect(sentText).toContain('1 al 5');

    // Verify the bot message is saved in DB messages
    const { rows: savedMsgs } = await pool.query(
      'SELECT id, conversation_id, sender, body FROM messages WHERE conversation_id = $1;',
      [conversationId]
    );
    expect(savedMsgs.length).toBe(1);
    expect(savedMsgs[0].body).toContain('califica');
  });

  it('should capture a valid numeric rating (exactly 5) and save it with no comment', async () => {
    // 1. Create a conversation in 'postventa' state
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550203', 1, 'activa_ia', 'postventa')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Insert a dummy trace to satisfy shouldRecordSatisfactionRating query
    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, generated_by)
      VALUES ($1, 1, 'activa_ia', 'confirmado', 'activa_ia', 'postventa', 'IA');
    `, [conversationId]);

    // 2. Process incoming response from customer: exactly '5'
    mockLLM.setResponse({
      text: 'Gracias por calificar.',
      decision: { accion: 'avanzar_a:cerrada' }
    });

    await engine.processIncomingMessage(conversationId, '5005550203', '5');

    // 3. Assert rating was saved correctly in database
    const { rows: ratings } = await pool.query(
      'SELECT calificacion, comentario FROM satisfaction_ratings WHERE conversation_id = $1;',
      [conversationId]
    );

    expect(ratings.length).toBe(1);
    expect(ratings[0].calificacion).toBe(5);
    expect(ratings[0].comentario).toBeNull();
  });

  it('should capture a rating with extra comments (e.g. "4 excelente servicio") and save both', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550204', 1, 'activa_ia', 'postventa')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, generated_by)
      VALUES ($1, 1, 'activa_ia', 'confirmado', 'activa_ia', 'postventa', 'IA');
    `, [conversationId]);

    mockLLM.setResponse({
      text: 'Muchas gracias por tus comentarios.',
      decision: { accion: 'avanzar_a:cerrada' }
    });

    await engine.processIncomingMessage(conversationId, '5005550204', '4 excelente servicio');

    const { rows: ratings } = await pool.query(
      'SELECT calificacion, comentario FROM satisfaction_ratings WHERE conversation_id = $1;',
      [conversationId]
    );

    expect(ratings.length).toBe(1);
    expect(ratings[0].calificacion).toBe(4);
    expect(ratings[0].comentario).toBe('4 excelente servicio');
  });

  it('should capture a free-form non-numeric rating and save calificacion as null and message as comentario', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550205', 1, 'activa_ia', 'postventa')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, generated_by)
      VALUES ($1, 1, 'activa_ia', 'confirmado', 'activa_ia', 'postventa', 'IA');
    `, [conversationId]);

    mockLLM.setResponse({
      text: 'Entendido, muchas gracias por tu mensaje.',
      decision: { accion: 'mantener_estado' }
    });

    // Client responds with text only
    await engine.processIncomingMessage(conversationId, '5005550205', 'Me encantó mucho el servicio, gracias');

    const { rows: ratings } = await pool.query(
      'SELECT calificacion, comentario FROM satisfaction_ratings WHERE conversation_id = $1;',
      [conversationId]
    );

    expect(ratings.length).toBe(1);
    expect(ratings[0].calificacion).toBeNull();
    expect(ratings[0].comentario).toBe('Me encantó mucho el servicio, gracias');
  });

  it('should not record duplicate satisfaction ratings for subsequent messages in the same postventa session', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550206', 1, 'activa_ia', 'postventa')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    await pool.query(`
      INSERT INTO conversation_traces (conversation_id, business_id, status_before, sales_state_before, status_after, sales_state_after, generated_by)
      VALUES ($1, 1, 'activa_ia', 'confirmado', 'activa_ia', 'postventa', 'IA');
    `, [conversationId]);

    // Send first response (satisfaction rating)
    mockLLM.setResponse({
      text: '¡Gracias!',
      decision: { accion: 'mantener_estado' }
    });
    await engine.processIncomingMessage(conversationId, '5005550206', '5');

    // Send second response (subsequent query)
    mockLLM.setResponse({
      text: 'Claro, dime.',
      decision: { accion: 'mantener_estado' }
    });
    await engine.processIncomingMessage(conversationId, '5005550206', '¿Tienen delivery mañana?');

    const { rows: ratings } = await pool.query(
      'SELECT calificacion, comentario FROM satisfaction_ratings WHERE conversation_id = $1;',
      [conversationId]
    );

    // Verify only the first response was stored as a rating
    expect(ratings.length).toBe(1);
    expect(ratings[0].calificacion).toBe(5);
  });
});
