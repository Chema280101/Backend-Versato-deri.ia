import { Pool } from 'pg';
import { config } from '../config';
import { runMigrations } from '../migrations';
import type { SalesState, ConversationStatus } from './state-machine.service';
import { dbEvents } from './events.service';
import { sendTextMessage } from './whatsapp.service';

const sslConfig =
  config.database.url.includes('supabase') || config.database.url.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString: config.database.url,
  ssl: sslConfig,
});

/**
 * Creates and updates tables via versioned migrations.
 */
export async function initializeDatabase(): Promise<void> {
  try {
    console.log('[INFO]: Connecting to database and running migrations...');
    await runMigrations(pool);
    console.log('[INFO]: Database initialization complete.');
  } catch (error) {
    console.error('[ERROR]: Database initialization failed:', error);
    throw error;
  }
}

/**
 * Resolves a business configuration by its unique WhatsApp phone number ID.
 */
export async function getBusinessByPhoneNumberId(phoneNumberId: string): Promise<any> {
  const query = 'SELECT * FROM businesses WHERE phone_number_id = $1;';
  const result = await pool.query(query, [phoneNumberId]);
  return result.rows[0] || null;
}

/**
 * Finds a conversation by customer number and business ID or creates one if it doesn't exist.
 * Returns the conversation's primary key ID.
 */
export async function findOrCreateConversation(
  customerNumber: string,
  businessId: number = 1,
): Promise<number> {
  const selectQuery =
    'SELECT id FROM conversations WHERE customer_number = $1 AND business_id = $2;';
  const findResult = await pool.query(selectQuery, [customerNumber, businessId]);

  if (findResult.rows.length > 0) {
    return findResult.rows[0].id;
  }

  const insertQuery = `
    INSERT INTO conversations (customer_number, business_id, status) 
    VALUES ($1, $2, 'activa_ia') 
    RETURNING id;
  `;
  const insertResult = await pool.query(insertQuery, [customerNumber, businessId]);
  return insertResult.rows[0].id;
}

/**
 * Saves a message (incoming or outgoing) associated with a conversation and its business.
 * Returns the saved message's primary key ID.
 */
export async function saveMessage(
  conversationId: number,
  messageId: string | null,
  sender: 'user' | 'bot',
  body: string,
  generatedBy?: 'user' | 'IA' | 'humano',
  userId?: number | null,
  templateCategory?: 'marketing' | 'utilidad' | 'servicio' | 'autenticacion',
  createdAt?: Date,
): Promise<number> {
  // Fetch business_id and customer_number from conversation to ensure relational integrity
  const convResult = await pool.query('SELECT business_id, customer_number FROM conversations WHERE id = $1;', [
    conversationId,
  ]);
  if (convResult.rows.length === 0) {
    throw new Error(`Conversation with ID ${conversationId} not found`);
  }
  const { business_id: businessId, customer_number: customerNumber } = convResult.rows[0];

  let category: 'marketing' | 'utilidad' | 'servicio' | 'autenticacion' | null = null;
  let cost = 0.0000;

  if (sender === 'bot') {
    const targetTime = createdAt || new Date();

    if (templateCategory) {
      category = templateCategory;
    } else {
      // Check if there was an incoming message (sender = 'user') in the last 24 hours relative to targetTime
      const windowStart = new Date(targetTime.getTime() - 24 * 60 * 60 * 1000);
      const lastUserMsg = await pool.query(
        `SELECT created_at FROM messages 
         WHERE conversation_id = $1 AND sender = 'user' AND created_at >= $2 AND created_at <= $3
         ORDER BY created_at DESC LIMIT 1;`,
        [conversationId, windowStart, targetTime]
      );
      if (lastUserMsg.rows.length > 0) {
        category = 'servicio';
      } else {
        // Fallback default for outgoing messages
        category = 'servicio';
      }
    }

    // Determine country from prefix
    let country = 'Peru';
    if (customerNumber.startsWith('51')) {
      country = 'Peru';
    } else if (customerNumber.startsWith('54')) {
      country = 'Argentina';
    } else if (customerNumber.startsWith('52')) {
      country = 'Mexico';
    } else if (customerNumber.startsWith('57')) {
      country = 'Colombia';
    } else {
      country = 'Peru';
    }

    // Lookup active tariff at targetTime
    const tariffResult = await pool.query(
      `SELECT tarifa_usd FROM pricing_config 
       WHERE pais = $1 
         AND categoria = $2 
         AND vigente_desde <= $3 
         AND (vigente_hasta IS NULL OR vigente_hasta >= $3)
       ORDER BY vigente_desde DESC LIMIT 1;`,
      [country, category, targetTime]
    );

    if (tariffResult.rows.length > 0) {
      cost = parseFloat(tariffResult.rows[0].tarifa_usd);
    }
  }

  const finalGeneratedBy = generatedBy || (sender === 'user' ? 'user' : 'IA');

  const insertQuery = `
    INSERT INTO messages (conversation_id, message_id, sender, body, business_id, generated_by, user_id, category, cost, created_at) 
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, CURRENT_TIMESTAMP)) 
    ON CONFLICT (message_id) DO NOTHING
    RETURNING id;
  `;
  const insertResult = await pool.query(insertQuery, [
    conversationId,
    messageId,
    sender,
    body,
    businessId,
    finalGeneratedBy,
    userId || null,
    category,
    cost,
    createdAt || null,
  ]);

  let msgId = insertResult.rows[0]?.id;

  // If the message already existed (due to Meta retry or mock test id repetition)
  if (!msgId && messageId) {
    const existingResult = await pool.query('SELECT id FROM messages WHERE message_id = $1;', [
      messageId,
    ]);
    msgId = existingResult.rows[0]?.id;
  }

  // Update conversation's updated_at timestamp
  await pool.query('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1;', [
    conversationId,
  ]);

  if (msgId) {
    try {
      const messageResult = await pool.query(
        'SELECT id, conversation_id, message_id, sender, body, business_id, created_at, generated_by, user_id, category, cost FROM messages WHERE id = $1;',
        [msgId],
      );
      if (messageResult.rows.length > 0) {
        const row = messageResult.rows[0];
        dbEvents.emit('message_saved', {
          id: row.id,
          conversation_id: row.conversation_id,
          message_id: row.message_id,
          sender: row.sender,
          body: row.body,
          business_id: row.business_id,
          created_at: row.created_at,
          generated_by: row.generated_by,
          user_id: row.user_id,
          category: row.category,
          cost: row.cost ? parseFloat(row.cost) : 0.0000,
        });
      }
    } catch (err) {
      console.error('[ERROR]: Failed to emit message_saved event:', err);
    }
  }

  return msgId;
}

export interface Product {
  id: number;
  businessId: number;
  sku: string;
  name: string;
  price: number;
  stock: number;
  description: string | null;
}

export interface ConversationState {
  status: ConversationStatus;
  salesState: SalesState;
  amount?: number;
  consecutiveAttempts?: number;
}

export interface BusinessConfig {
  name: string;
  brandPrompt: string | null;
  escalationThreshold?: number | null;
  trainingInfo?: string | null;
}

export interface HistoricMessage {
  sender: 'user' | 'bot';
  body: string;
}

/**
 * Retrieves all products for a specific business.
 */
export async function getProducts(businessId: number): Promise<Product[]> {
  const query =
    'SELECT id, business_id, sku, name, price, stock, description FROM products WHERE business_id = $1 ORDER BY id ASC;';
  const result = await pool.query(query, [businessId]);
  return result.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    sku: row.sku,
    name: row.name,
    price: parseFloat(row.price),
    stock: row.stock,
    description: row.description,
  }));
}

/**
 * Retrieves the state of a conversation by its ID.
 */
export async function getConversationState(
  conversationId: number,
): Promise<ConversationState | null> {
  const query =
    'SELECT status, sales_state, amount, consecutive_attempts FROM conversations WHERE id = $1;';
  const result = await pool.query(query, [conversationId]);
  if (result.rows.length === 0) {
    return null;
  }
  return {
    status: result.rows[0].status as any,
    salesState: result.rows[0].sales_state as any,
    amount: result.rows[0].amount !== null ? parseFloat(result.rows[0].amount) : 0,
    consecutiveAttempts:
      result.rows[0].consecutive_attempts !== null
        ? parseInt(result.rows[0].consecutive_attempts, 10)
        : 0,
  };
}

/**
 * Updates a conversation's status and/or sales_state.
 */
export async function updateConversationState(
  conversationId: number,
  fields: {
    status?: ConversationStatus;
    salesState?: SalesState;
    amount?: number;
    consecutiveAttempts?: number;
  },
): Promise<void> {
  const updates: string[] = [];
  const values: any[] = [];
  let index = 1;

  if (fields.status !== undefined) {
    updates.push(`status = $${index++}`);
    values.push(fields.status);
  }
  if (fields.salesState !== undefined) {
    updates.push(`sales_state = $${index++}`);
    values.push(fields.salesState);
  }
  if (fields.amount !== undefined) {
    updates.push(`amount = $${index++}`);
    values.push(fields.amount);
  }
  if (fields.consecutiveAttempts !== undefined) {
    updates.push(`consecutive_attempts = $${index++}`);
    values.push(fields.consecutiveAttempts);
  }

  if (updates.length === 0) return;

  values.push(conversationId);
  const query = `
    UPDATE conversations 
    SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP 
    WHERE id = $${index};
  `;
  await pool.query(query, values);

  if (fields.status !== undefined || fields.salesState !== undefined) {
    try {
      const updatedConv = await getConversationById(conversationId);
      if (updatedConv) {
        dbEvents.emit('conversation_updated', updatedConv);
      }
    } catch (err) {
      console.error('[ERROR]: Failed to emit conversation_updated event:', err);
    }
  }

  if (fields.salesState === 'postventa') {
    try {
      const conv = await getConversationById(conversationId);
      if (conv) {
        const satisfactionMessage = '¡Gracias por tu compra! Por favor, califica tu experiencia del 1 al 5, donde 1 es muy malo y 5 es excelente.';
        console.log(`[INFO]: Automatically sending satisfaction message to ${conv.customer_number}`);
        const wamid = await sendTextMessage(conv.customer_number, satisfactionMessage);
        if (wamid) {
          await saveMessage(conversationId, wamid, 'bot', satisfactionMessage, 'IA');
        }
      }
    } catch (err) {
      console.error('[ERROR]: Failed to send automatic satisfaction message:', err);
    }
  }
}

/**
 * Retrieves the message history of a conversation, ordered chronologically.
 */
export async function getMessagesHistory(
  conversationId: number,
  limit: number = 10,
): Promise<HistoricMessage[]> {
  const query = `
    SELECT sender, body 
    FROM messages 
    WHERE conversation_id = $1 
    ORDER BY created_at DESC, id DESC 
    LIMIT $2;
  `;
  const result = await pool.query(query, [conversationId, limit]);
  // Reverse to get chronological order (oldest first)
  return result.rows
    .map((row) => ({
      sender: row.sender as 'user' | 'bot',
      body: row.body,
    }))
    .reverse();
}

/**
 * Retrieves business configuration by ID.
 */
export async function getBusinessConfig(businessId: number): Promise<BusinessConfig | null> {
  const query = 'SELECT name, brand_prompt, escalation_threshold, training_info FROM businesses WHERE id = $1;';
  const result = await pool.query(query, [businessId]);
  if (result.rows.length === 0) {
    return null;
  }
  return {
    name: result.rows[0].name,
    brandPrompt: result.rows[0].brand_prompt,
    escalationThreshold:
      result.rows[0].escalation_threshold !== null
        ? parseFloat(result.rows[0].escalation_threshold)
        : null,
    trainingInfo: result.rows[0].training_info || null,
  };
}

/**
 * Updates a business configuration.
 */
export async function updateBusinessConfig(
  businessId: number,
  updates: {
    name?: string;
    brandPrompt?: string | null;
    escalationThreshold?: number | null;
    trainingInfo?: string | null;
  },
): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    params.push(updates.name);
  }
  if (updates.brandPrompt !== undefined) {
    fields.push(`brand_prompt = $${paramIndex++}`);
    params.push(updates.brandPrompt);
  }
  if (updates.escalationThreshold !== undefined) {
    fields.push(`escalation_threshold = $${paramIndex++}`);
    params.push(updates.escalationThreshold);
  }
  if (updates.trainingInfo !== undefined) {
    fields.push(`training_info = $${paramIndex++}`);
    params.push(updates.trainingInfo);
  }

  if (fields.length === 0) return;

  params.push(businessId);
  const query = `UPDATE businesses SET ${fields.join(', ')} WHERE id = $${paramIndex};`;
  await pool.query(query, params);
}

/**
 * Updates an existing catalog item under tenant isolation.
 */
export async function updateCatalogItem(
  id: number,
  businessId: number,
  updates: Partial<Omit<CatalogItem, 'id' | 'businessId'>>,
): Promise<void> {
  const fields: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.nombre !== undefined) {
    fields.push(`nombre = $${paramIndex++}`);
    params.push(updates.nombre);
  }
  if (updates.descripcion !== undefined) {
    fields.push(`descripcion = $${paramIndex++}`);
    params.push(updates.descripcion);
  }
  if (updates.precio !== undefined) {
    fields.push(`precio = $${paramIndex++}`);
    params.push(updates.precio);
  }
  if (updates.stock !== undefined) {
    fields.push(`stock = $${paramIndex++}`);
    params.push(updates.stock);
  }
  if (updates.categoria !== undefined) {
    fields.push(`categoria = $${paramIndex++}`);
    params.push(updates.categoria);
  }
  if (updates.activo !== undefined) {
    fields.push(`activo = $${paramIndex++}`);
    params.push(updates.activo);
  }

  if (fields.length === 0) return;

  params.push(id, businessId);
  const query = `UPDATE catalog_items SET ${fields.join(', ')} WHERE id = $${paramIndex++} AND business_id = $${paramIndex};`;
  await pool.query(query, params);
}

/**
 * Deletes or deactivates a catalog item under tenant isolation.
 * (We do soft delete or hard delete; here we do a hard delete to match routing, or soft delete setting active=false).
 * Let's implement hard delete to clean up DB, checking first.
 */
export async function deleteCatalogItem(id: number, businessId: number): Promise<void> {
  const query = 'DELETE FROM catalog_items WHERE id = $1 AND business_id = $2;';
  await pool.query(query, [id, businessId]);
}

export interface CatalogItem {
  id: number;
  businessId: number;
  nombre: string;
  descripcion: string | null;
  precio: number;
  stock: number;
  categoria: string;
  activo: boolean;
  created_at?: Date;
  updated_at?: Date;
}

/**
 * Retrieves catalog items for a specific business, optionally filtered by category.
 */
export async function getCatalogItems(
  businessId: number,
  categoria?: string,
): Promise<CatalogItem[]> {
  let query =
    'SELECT id, business_id, nombre, descripcion, precio, stock, categoria, activo FROM catalog_items WHERE business_id = $1';
  const params: any[] = [businessId];

  if (categoria) {
    query += ' AND categoria = $2';
    params.push(categoria);
  }

  query += ' ORDER BY id ASC;';
  const result = await pool.query(query, params);
  return result.rows.map((row) => ({
    id: row.id,
    businessId: row.business_id,
    nombre: row.nombre,
    descripcion: row.descripcion,
    precio: parseFloat(row.precio),
    stock: row.stock,
    categoria: row.categoria,
    activo: row.activo,
  }));
}

/**
 * Creates/inserts a new catalog item.
 */
export async function createCatalogItem(
  item: Omit<CatalogItem, 'id' | 'activo'> & { activo?: boolean },
): Promise<number> {
  const query = `
    INSERT INTO catalog_items (business_id, nombre, descripcion, precio, stock, categoria, activo)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id;
  `;
  const activo = item.activo ?? true;
  const result = await pool.query(query, [
    item.businessId,
    item.nombre,
    item.descripcion,
    item.precio,
    item.stock,
    item.categoria,
    activo,
  ]);
  return result.rows[0].id;
}

/**
 * Creates an internal notification in the notifications table.
 */
export async function createNotification(
  conversationId: number,
  businessId: number,
  type: string,
  message: string,
): Promise<number> {
  const query = `
    INSERT INTO notifications (conversation_id, business_id, type, message)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
  `;
  const result = await pool.query(query, [conversationId, businessId, type, message]);
  return result.rows[0].id;
}

/**
 * Updates the escalation threshold of a business.
 */
export async function updateBusinessEscalationThreshold(
  businessId: number,
  threshold: number | null,
): Promise<void> {
  const query = 'UPDATE businesses SET escalation_threshold = $1 WHERE id = $2;';
  await pool.query(query, [threshold, businessId]);
}

/**
 * Logs a trace of a conversation turn for auditing and traceability.
 */
export async function logConversationTrace(
  conversationId: number,
  businessId: number,
  statusBefore: ConversationStatus,
  salesStateBefore: SalesState,
  statusAfter: ConversationStatus,
  salesStateAfter: SalesState,
  llmDecision: any | null,
  escalationTriggered: boolean,
  escalationReason: string | null,
  generatedBy: 'IA' | 'humano',
): Promise<number> {
  const query = `
    INSERT INTO conversation_traces (
      conversation_id, business_id, status_before, sales_state_before, 
      status_after, sales_state_after, llm_decision, 
      escalation_triggered, escalation_reason, generated_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id;
  `;
  const result = await pool.query(query, [
    conversationId,
    businessId,
    statusBefore,
    salesStateBefore,
    statusAfter,
    salesStateAfter,
    llmDecision ? JSON.stringify(llmDecision) : null,
    escalationTriggered,
    escalationReason,
    generatedBy,
  ]);
  return result.rows[0].id;
}

export interface User {
  id: number;
  businessId: number;
  email: string;
  passwordHash: string;
  nombre: string;
  rol: string;
  avatar?: string | null;
  nombreLastChangedAt?: Date | null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const query =
    'SELECT id, business_id, email, password_hash, nombre, rol, avatar, nombre_last_changed_at FROM users WHERE email = $1;';
  const result = await pool.query(query, [email]);
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    businessId: row.business_id,
    email: row.email,
    passwordHash: row.password_hash,
    nombre: row.nombre,
    rol: row.rol,
    avatar: row.avatar,
    nombreLastChangedAt: row.nombre_last_changed_at ? new Date(row.nombre_last_changed_at) : null,
  };
}

export async function findUserById(id: number): Promise<User | null> {
  const query =
    'SELECT id, business_id, email, password_hash, nombre, rol, avatar, nombre_last_changed_at FROM users WHERE id = $1;';
  const result = await pool.query(query, [id]);
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    businessId: row.business_id,
    email: row.email,
    passwordHash: row.password_hash,
    nombre: row.nombre,
    rol: row.rol,
    avatar: row.avatar,
    nombreLastChangedAt: row.nombre_last_changed_at ? new Date(row.nombre_last_changed_at) : null,
  };
}

export async function updateUser(
  id: number,
  fields: {
    nombre?: string;
    passwordHash?: string;
    avatar?: string | null;
    nombreLastChangedAt?: Date | null;
  }
): Promise<void> {
  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (fields.nombre !== undefined) {
    updates.push(`nombre = $${idx++}`);
    values.push(fields.nombre);
  }
  if (fields.passwordHash !== undefined) {
    updates.push(`password_hash = $${idx++}`);
    values.push(fields.passwordHash);
  }
  if (fields.avatar !== undefined) {
    updates.push(`avatar = $${idx++}`);
    values.push(fields.avatar);
  }
  if (fields.nombreLastChangedAt !== undefined) {
    updates.push(`nombre_last_changed_at = $${idx++}`);
    values.push(fields.nombreLastChangedAt);
  }

  if (updates.length === 0) return;

  values.push(id);
  const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx};`;
  await pool.query(query, values);
}

export async function createUser(
  businessId: number,
  email: string,
  passwordHash: string,
  nombre: string,
  rol: string,
): Promise<number> {
  const query = `
    INSERT INTO users (business_id, email, password_hash, nombre, rol)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id;
  `;
  const result = await pool.query(query, [businessId, email, passwordHash, nombre, rol]);
  return result.rows[0].id;
}

export interface ConversationInfo {
  id: number;
  customer_number: string;
  business_id: number;
  status: ConversationStatus;
  sales_state: SalesState;
  amount: number;
  consecutive_attempts: number;
  created_at: Date;
  updated_at: Date;
  last_message?: string | null;
  last_message_timestamp?: Date | null;
  alert_pending?: boolean;
}

export async function getConversationsByBusiness(businessId: number): Promise<ConversationInfo[]> {
  const query = `
    SELECT 
      c.id, 
      c.customer_number, 
      c.business_id, 
      c.status, 
      c.sales_state, 
      c.amount, 
      c.consecutive_attempts, 
      c.created_at, 
      c.updated_at,
      m.body AS last_message,
      m.created_at AS last_message_timestamp,
      COALESCE(
        (
          SELECT TRUE 
          FROM businesses b
          WHERE b.id = c.business_id
            AND c.status = 'pausada_humano'
            AND EXISTS (
              SELECT 1 FROM messages m
              WHERE m.conversation_id = c.id
                AND m.created_at > COALESCE(
                  (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
                  '1970-01-01 00:00:00'::timestamp
                )
            )
            AND (
              SELECT MIN(created_at) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.created_at > COALESCE(
                  (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
                  '1970-01-01 00:00:00'::timestamp
                )
            ) < NOW() - (COALESCE(b.alert_pending_threshold_hours, 2) * INTERVAL '1 hour')
        ),
        FALSE
      ) AS alert_pending
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT body, created_at
      FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) m ON TRUE
    WHERE c.business_id = $1
    ORDER BY c.updated_at DESC, c.id DESC;
  `;
  const result = await pool.query(query, [businessId]);
  return result.rows.map((row) => ({
    id: row.id,
    customer_number: row.customer_number,
    business_id: row.business_id,
    status: row.status,
    sales_state: row.sales_state,
    amount: parseFloat(row.amount),
    consecutive_attempts: row.consecutive_attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message: row.last_message || null,
    last_message_timestamp: row.last_message_timestamp || null,
    alert_pending: row.alert_pending,
  }));
}

export async function getConversationById(id: number): Promise<ConversationInfo | null> {
  const query = `
    SELECT 
      c.id, 
      c.customer_number, 
      c.business_id, 
      c.status, 
      c.sales_state, 
      c.amount, 
      c.consecutive_attempts, 
      c.created_at, 
      c.updated_at,
      m.body AS last_message,
      m.created_at AS last_message_timestamp,
      COALESCE(
        (
          SELECT TRUE 
          FROM businesses b
          WHERE b.id = c.business_id
            AND c.status = 'pausada_humano'
            AND EXISTS (
              SELECT 1 FROM messages m
              WHERE m.conversation_id = c.id
                AND m.created_at > COALESCE(
                  (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
                  '1970-01-01 00:00:00'::timestamp
                )
            )
            AND (
              SELECT MIN(created_at) FROM messages m
              WHERE m.conversation_id = c.id
                AND m.created_at > COALESCE(
                  (SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id AND generated_by = 'humano'),
                  '1970-01-01 00:00:00'::timestamp
                )
            ) < NOW() - (COALESCE(b.alert_pending_threshold_hours, 2) * INTERVAL '1 hour')
        ),
        FALSE
      ) AS alert_pending
    FROM conversations c
    LEFT JOIN LATERAL (
      SELECT body, created_at
      FROM messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) m ON TRUE
    WHERE c.id = $1;
  `;
  const result = await pool.query(query, [id]);
  if (result.rows.length === 0) {
    return null;
  }
  const row = result.rows[0];
  return {
    id: row.id,
    customer_number: row.customer_number,
    business_id: row.business_id,
    status: row.status,
    sales_state: row.sales_state,
    amount: parseFloat(row.amount),
    consecutive_attempts: row.consecutive_attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message: row.last_message || null,
    last_message_timestamp: row.last_message_timestamp || null,
    alert_pending: row.alert_pending,
  };
}

export interface MessageInfo {
  id: number;
  conversation_id: number;
  message_id: string | null;
  sender: 'user' | 'bot';
  body: string;
  business_id: number;
  created_at: Date;
  generated_by?: 'user' | 'IA' | 'humano';
  user_id?: number | null;
  category?: 'marketing' | 'utilidad' | 'servicio' | 'autenticacion' | null;
  cost?: number;
}

export async function getMessagesByConversation(
  conversationId: number,
  businessId: number,
): Promise<MessageInfo[]> {
  const query = `
    SELECT id, conversation_id, message_id, sender, body, business_id, created_at, generated_by, user_id, category, cost
    FROM messages
    WHERE conversation_id = $1 AND business_id = $2
    ORDER BY created_at ASC, id ASC;
  `;
  const result = await pool.query(query, [conversationId, businessId]);
  return result.rows.map((row) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    sender: row.sender,
    body: row.body,
    business_id: row.business_id,
    created_at: row.created_at,
    generated_by: row.generated_by,
    user_id: row.user_id,
    category: row.category,
    cost: row.cost ? parseFloat(row.cost) : 0.0000,
  }));
}

export async function logAuditAction(
  conversationId: number,
  businessId: number,
  userId: number | null,
  action: string,
): Promise<number> {
  const query = `
    INSERT INTO audit_logs (conversation_id, business_id, user_id, action)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
  `;
  const result = await pool.query(query, [conversationId, businessId, userId, action]);
  return result.rows[0].id;
}

export interface OrderItem {
  catalog_item_id: number;
  nombre: string;
  precio_unitario: number;
  cantidad: number;
}

export interface Order {
  id?: number;
  conversationId: number;
  businessId: number;
  items: OrderItem[];
  total: number;
  createdAt?: Date;
}

export async function createOrder(order: Order): Promise<number> {
  const query = `
    INSERT INTO orders (conversation_id, business_id, items, total)
    VALUES ($1, $2, $3::jsonb, $4)
    RETURNING id;
  `;
  const result = await pool.query(query, [
    order.conversationId,
    order.businessId,
    JSON.stringify(order.items),
    order.total,
  ]);
  return result.rows[0].id;
}

/**
 * Checks if a satisfaction rating should be recorded for this conversation.
 * Returns true if no rating exists since the most recent transition to 'postventa'.
 */
export async function shouldRecordSatisfactionRating(conversationId: number): Promise<boolean> {
  // Get the most recent transition to 'postventa' from another state
  const traceRes = await pool.query(
    `SELECT created_at FROM conversation_traces 
     WHERE conversation_id = $1 
       AND sales_state_after = 'postventa' 
       AND sales_state_before != 'postventa'
     ORDER BY created_at DESC LIMIT 1;`,
    [conversationId]
  );
  
  if (traceRes.rows.length === 0) {
    // Fallback: check if any rating exists for this conversation
    const ratingRes = await pool.query(
      `SELECT id FROM satisfaction_ratings WHERE conversation_id = $1 LIMIT 1;`,
      [conversationId]
    );
    return ratingRes.rows.length === 0;
  }
  
  const postventaTime = traceRes.rows[0].created_at;
  
  // Check if a rating exists since that time
  const ratingRes = await pool.query(
    `SELECT id FROM satisfaction_ratings 
     WHERE conversation_id = $1 AND created_at >= $2 LIMIT 1;`,
    [conversationId, postventaTime]
  );
  
  return ratingRes.rows.length === 0;
}

/**
 * Saves a customer's satisfaction rating.
 */
export async function saveSatisfactionRating(
  conversationId: number,
  businessId: number,
  calificacion: number | null,
  comentario: string | null
): Promise<number> {
  const query = `
    INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion, comentario)
    VALUES ($1, $2, $3, $4)
    RETURNING id;
  `;
  const result = await pool.query(query, [conversationId, businessId, calificacion, comentario]);
  return result.rows[0].id;
}
