import { pool, getConversationState } from '../services/db.service';
import { runMigrations } from '../migrations';
import { ConversationalEngine } from '../services/conversational-engine.service';
import { MockLLMProvider } from '../services/llm/mock-llm.provider';

// Mock the outbound WhatsApp service so we do not make actual Meta API requests
jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn().mockResolvedValue('wamid.test_outgoing_msg_id'),
}));

describe('Orders and Checkout Validation Integration Tests', () => {
  const testSchema = 'test_orders_validation';
  let engine: ConversationalEngine;
  let mockLLM: MockLLMProvider;

  beforeAll(async () => {
    // 1. Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations
    await runMigrations(pool);

    // 3. Configure default business
    await pool.query(`
      UPDATE businesses 
      SET name = 'Cafe Antigravity', brand_prompt = 'Servir el mejor café digital' 
      WHERE id = 1;
    `);

    // 4. Create second business (Tenant 2)
    await pool.query(`
      INSERT INTO businesses (id, name, phone_number_id)
      VALUES (2, 'Secret Café', '222222222222222')
      ON CONFLICT (id) DO NOTHING;
    `);
    await pool.query(`
      SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 2)) FROM businesses;
    `);

    // 5. Seed an item for Business 2 to verify multi-tenant isolation
    await pool.query(`
      INSERT INTO catalog_items (business_id, nombre, descripcion, precio, stock, categoria, activo)
      VALUES (2, 'Café Especial B2', 'Café secreto de Tenant 2', 15.00, 20, 'cafeteria', true);
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

    // Reset tables
    await pool.query('DELETE FROM orders;');
    await pool.query('DELETE FROM messages;');
    await pool.query('DELETE FROM conversations;');
  });

  it('should successfully save order and transition to confirmado on valid checkout', async () => {
    // 1. Create a conversation in 'cierre_y_pago' state
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550201', 1, 'activa_ia', 'cierre_y_pago')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Get active item IDs from business 1 to test (e.g. from seed_catalog.csv)
    const { rows: dbItems } = await pool.query(
      'SELECT id, nombre, precio FROM catalog_items WHERE business_id = 1 AND activo = true ORDER BY id ASC LIMIT 2;'
    );
    expect(dbItems.length).toBeGreaterThan(0);

    const item1 = dbItems[0];
    const item2 = dbItems[1] || item1;

    // Calculated total
    const quantity1 = 2;
    const quantity2 = 1;
    const expectedTotal = Number(item1.precio) * quantity1 + (dbItems[1] ? Number(item2.precio) * quantity2 : 0);

    mockLLM.setResponse({
      text: '¡Muchas gracias! Su pago ha sido confirmado.',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [
            { catalog_item_id: item1.id, cantidad: quantity1 },
            ...(dbItems[1] ? [{ catalog_item_id: item2.id, cantidad: quantity2 }] : []),
          ],
          total: expectedTotal,
        },
      },
    });

    await engine.processIncomingMessage(conversationId, '5005550201', 'Ya transferí');

    // State must be 'confirmado'
    const state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('confirmado');

    // Order must be saved
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE conversation_id = $1;', [
      conversationId,
    ]);
    expect(orders.length).toBe(1);
    expect(orders[0].business_id).toBe(1);
    expect(Number(orders[0].total)).toBe(Math.round(expectedTotal * 100) / 100);

    // Verify order items details
    const orderItems = orders[0].items;
    expect(orderItems.length).toBe(dbItems[1] ? 2 : 1);
    expect(orderItems[0].catalog_item_id).toBe(item1.id);
    expect(orderItems[0].nombre).toBe(item1.nombre);
    expect(Number(orderItems[0].precio_unitario)).toBe(Number(item1.precio));
    expect(orderItems[0].cantidad).toBe(quantity1);
  });

  it('should reject transition and not save order if total price is manipulated', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550202', 1, 'activa_ia', 'cierre_y_pago')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    const { rows: dbItems } = await pool.query(
      'SELECT id, precio FROM catalog_items WHERE business_id = 1 AND activo = true ORDER BY id ASC LIMIT 1;'
    );
    const item = dbItems[0];

    mockLLM.setResponse({
      text: '¡Pago confirmado!',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [{ catalog_item_id: item.id, cantidad: 1 }],
          total: 1.00, // Manipulated! Real price is item.precio (e.g. 89.99)
        },
      },
    });

    await engine.processIncomingMessage(conversationId, '5005550202', 'Listo');

    // State must remain 'cierre_y_pago'
    const state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('cierre_y_pago');

    // No orders in DB
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE conversation_id = $1;', [
      conversationId,
    ]);
    expect(orders.length).toBe(0);
  });

  it('should reject transition and not save order if product ID does not exist', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550203', 1, 'activa_ia', 'cierre_y_pago')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    mockLLM.setResponse({
      text: '¡Confirmado!',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [{ catalog_item_id: 999999, cantidad: 1 }], // Non-existent catalog item
          total: 89.99,
        },
      },
    });

    await engine.processIncomingMessage(conversationId, '5005550203', 'Hecho');

    const state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('cierre_y_pago');

    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE conversation_id = $1;', [
      conversationId,
    ]);
    expect(orders.length).toBe(0);
  });

  it('should reject transition and enforce multi-tenant isolation if product ID belongs to another business', async () => {
    const insertResult = await pool.query(`
      INSERT INTO conversations (customer_number, business_id, status, sales_state)
      VALUES ('5005550204', 1, 'activa_ia', 'cierre_y_pago')
      RETURNING id;
    `);
    const conversationId = insertResult.rows[0].id;

    // Get the item ID that belongs to Business 2
    const { rows: dbItemsB2 } = await pool.query(
      'SELECT id, precio FROM catalog_items WHERE business_id = 2 LIMIT 1;'
    );
    expect(dbItemsB2.length).toBe(1);
    const itemB2 = dbItemsB2[0];

    mockLLM.setResponse({
      text: '¡Listo, confirmado!',
      decision: {
        accion: 'avanzar_a:confirmado',
        pedido: {
          items: [{ catalog_item_id: itemB2.id, cantidad: 1 }], // Belongs to business 2, but conversation belongs to business 1
          total: Number(itemB2.precio),
        },
      },
    });

    await engine.processIncomingMessage(conversationId, '5005550204', 'Confirmar pago');

    // Transition should be rejected
    const state = await getConversationState(conversationId);
    expect(state?.salesState).toBe('cierre_y_pago');

    // No orders saved
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE conversation_id = $1;', [
      conversationId,
    ]);
    expect(orders.length).toBe(0);
  });
});
