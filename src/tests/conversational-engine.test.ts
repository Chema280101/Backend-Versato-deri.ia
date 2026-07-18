import { pool, saveMessage, getConversationState, CatalogItem } from '../services/db.service';
import { runMigrations } from '../migrations';
import {
  ConversationalEngine,
  filterRelevantCatalogItems,
} from '../services/conversational-engine.service';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';
import * as whatsappService from '../services/whatsapp.service';

// Mock the outbound WhatsApp service so we do not make actual Meta API requests
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_outgoing_msg_id'),
}));

const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

describe('Conversational Sales Engine Integration', () => {
  const testSchema = 'test_conversational_engine';
  let engine: ConversationalEngine;
  let mockLLM: MockLLMProvider;

  beforeAll(async () => {
    // 1. Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations to initialize all tables and seed catalog items
    await runMigrations(pool);

    // 3. Populate default business configuration
    await pool.query(`
      UPDATE businesses 
      SET name = 'Cafe Antigravity', brand_prompt = 'Servir el mejor café digital' 
      WHERE id = 1;
    `);

    // Verify catalog items are seeded
    const { rows: items } = await pool.query('SELECT * FROM catalog_items WHERE business_id = 1;');
    console.log(`[INFO]: Loaded ${items.length} test catalog items from DB.`);
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

    // Reset database state for messages and conversations
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');
  });

  it('should format LLMContext and catalog context correctly', async () => {
    // 1. Create a conversation
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550001', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // 2. Setup mock response
    mockLLM.setResponse({
      text: '¡Hola! Bienvenidos a Cafe Antigravity. ¿Deseas ver nuestra selección de cafés?',
      decision: { accion: 'mantener_estado' },
    });

    // Save incoming user message
    await saveMessage(conversationId, 'wamid.incoming_test_1', 'user', 'Hola bot');

    // 3. Process message
    await engine.processIncomingMessage(conversationId, '5005550001', 'Hola bot');

    // 4. Verify context properties
    const context = mockLLM.lastContext;
    expect(context).toBeDefined();
    expect(context?.businessName).toBe('Cafe Antigravity');
    expect(context?.brandPrompt).toBe('Servir el mejor café digital');
    expect(context?.currentMessage).toBe('Hola bot');
    expect(context?.state.salesState).toBe('saludo');
    expect(context?.catalog.length).toBeGreaterThan(0);

    // 5. Verify outbound WhatsApp message was sent and saved to DB
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5005550001',
      '¡Hola! Bienvenidos a Cafe Antigravity. ¿Deseas ver nuestra selección de cafés?',
    );

    const { rows: msgs } = await pool.query('SELECT sender, body FROM messages ORDER BY id ASC;');
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ sender: 'user', body: 'Hola bot' });
    expect(msgs[1]).toEqual({
      sender: 'bot',
      body: '¡Hola! Bienvenidos a Cafe Antigravity. ¿Deseas ver nuestra selección de cafés?',
    });
  });

  it('should filter catalog by relevance (active and keyword matching)', () => {
    const items: CatalogItem[] = [
      {
        id: 1,
        businessId: 1,
        nombre: 'Auriculares Bluetooth X200',
        descripcion: 'Cancelación de ruido activa',
        precio: 89.9,
        stock: 10,
        categoria: 'Electronica',
        activo: true,
      },
      {
        id: 2,
        businessId: 1,
        nombre: 'Teclado Mecánico RGB',
        descripcion: 'Switches rojos silenciosos',
        precio: 59.9,
        stock: 5,
        categoria: 'Computacion',
        activo: true,
      },
      {
        id: 3,
        businessId: 1,
        nombre: 'Inactivo Product',
        descripcion: 'Prueba inactivo',
        precio: 10.0,
        stock: 0,
        categoria: 'Test',
        activo: false,
      },
    ];

    // Case 1: Inactive products are completely excluded
    const activeOnly = filterRelevantCatalogItems(items, 'Prueba');
    expect(activeOnly.map((i) => i.id)).not.toContain(3);

    // Case 2: Matching by keyword in name
    const matchesName = filterRelevantCatalogItems(items, 'Quiero unos auriculares');
    expect(matchesName.length).toBe(1);
    expect(matchesName[0].nombre).toBe('Auriculares Bluetooth X200');

    // Case 3: Matching by keyword in description
    const matchesDesc = filterRelevantCatalogItems(items, 'Busco switches rojos');
    expect(matchesDesc.length).toBe(1);
    expect(matchesDesc[0].nombre).toBe('Teclado Mecánico RGB');

    // Case 4: No matches fallback to returning all active items
    const fallback = filterRelevantCatalogItems(items, 'Hola bot');
    expect(fallback.length).toBe(2);
    expect(fallback.map((i) => i.id)).toContain(1);
    expect(fallback.map((i) => i.id)).toContain(2);
  });

  // --- 3 SIMULATED E2E CONVERSATIONS ---

  it('E2E Conversation 1: Successful valid transitions sequentially (saludo -> calificacion_necesidad -> recomendacion_producto -> cierre_y_pago -> confirmado)', async () => {
    // Create active conversation starting at 'saludo'
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550101', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Turn 1: saludo -> calificacion_necesidad
    mockLLM.setResponse({
      text: '¡Hola! ¿Cómo estás? ¿En qué puedo ayudarte hoy?',
      decision: { accion: 'avanzar_a:calificacion_necesidad' },
    });
    await engine.processIncomingMessage(conversationId, '5005550101', 'Hola');

    let state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('calificacion_necesidad');

    // Turn 2: calificacion_necesidad -> recomendacion_producto
    mockLLM.setResponse({
      text: 'Te recomiendo nuestros auriculares inalámbricos.',
      decision: { accion: 'avanzar_a:recomendacion_producto' },
    });
    await engine.processIncomingMessage(conversationId, '5005550101', 'Busco auriculares');

    state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('recomendacion_producto');

    // Turn 3: recomendacion_producto -> cierre_y_pago
    mockLLM.setResponse({
      text: 'Excelente elección, procedemos con los detalles del pago.',
      decision: { accion: 'avanzar_a:cierre_y_pago' },
    });
    await engine.processIncomingMessage(conversationId, '5005550101', 'Me los llevo');

    state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('cierre_y_pago');

    const { rows: testCatalog } = await pool.query(
      'SELECT id, precio FROM catalog_items WHERE business_id = 1 AND activo = true LIMIT 1;'
    );
    const validItemId = testCatalog[0].id;
    const validItemPrice = parseFloat(testCatalog[0].precio);

    // Turn 4: cierre_y_pago -> confirmado
    mockLLM.setResponse({
      text: '¡Perfecto! Tu compra ha sido confirmada y procesada.',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [{ catalog_item_id: validItemId, cantidad: 1 }],
          total: validItemPrice,
        },
      },
    });
    await engine.processIncomingMessage(conversationId, '5005550101', 'Listo, ya pagué');

    state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('confirmado');
  });

  it('E2E Conversation 2: Invalid transition rejected, reverts to mantener_estado (saludo -> confirmado is invalid)', async () => {
    // Create active conversation starting at 'saludo'
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550102', 1, 'activa_ia', 'saludo')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // LLM proposes invalid transition saludo -> confirmado
    mockLLM.setResponse({
      text: 'Tu pago está listo (falso saludo).',
      decision: { accion: 'avanzar_a:confirmado' },
    });

    await engine.processIncomingMessage(conversationId, '5005550102', 'Cobrame ya');

    // State must remain 'saludo'
    const state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('saludo');
    expect(state?.status).toBe('activa_ia');

    // Bot reply should still be sent
    expect(mockSendTextMessage).toHaveBeenCalledWith(
      '5005550102',
      'Tu pago está listo (falso saludo).',
    );
  });

  it('E2E Conversation 3: Human escalation pauses AI processing and bypasses subsequent messages', async () => {
    // Create active conversation in 'calificacion_necesidad'
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550103', 1, 'activa_ia', 'calificacion_necesidad')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Turn 1: Request human escalation
    mockLLM.setResponse({
      text: 'Te conecto con un agente humano.',
      decision: { accion: 'escalar_humano:cliente solicita soporte' },
    });

    await engine.processIncomingMessage(conversationId, '5005550103', 'Necesito ayuda compleja');

    let state = await getConversationState(conversationId);
    expect(state?.status).toBe('pausada_humano');
    expect(state?.salesState).toBe('escalado_humano');

    // Verify LLM was called on this turn
    expect(mockLLM.lastContext?.currentMessage).toBe('Necesito ayuda compleja');

    // Clear call history and reset mock context
    jest.clearAllMocks();
    mockLLM.lastContext = undefined;

    // Turn 2: Send subsequent message while status is 'pausada_humano'
    await engine.processIncomingMessage(conversationId, '5005550103', 'Hola, ¿hay alguien ahí?');

    // LLM should NOT be called, and no message sent
    expect(mockLLM.lastContext).toBeUndefined();
    expect(mockSendTextMessage).not.toHaveBeenCalled();
  });
});
