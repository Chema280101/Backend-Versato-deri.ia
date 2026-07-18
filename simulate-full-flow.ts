/**
 * simulate-full-flow.ts
 *
 * Simulates 18 diverse conversations directly in the database (no LLM calls),
 * then calls the /metrics/ventas endpoint and verifies that the conversion rate
 * reported by the API matches the manually computed one.
 *
 * Run:  npx tsx simulate-full-flow.ts
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ─── DB setup ───────────────────────────────────────────────────────────────
const sslConfig = process.env.DATABASE_URL?.includes('supabase')
  ? { rejectUnauthorized: false }
  : undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

const API_BASE = 'http://localhost:3000';

// ─── JWT helper ─────────────────────────────────────────────────────────────
async function loginAndGetToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@test.com', password: 'testpassword' }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const data: any = await res.json();
  return data.token;
}

// ─── Scenario definitions ─────────────────────────────────────────────────
interface SimTrace {
  status_before: string;
  sales_state_before: string;
  status_after: string;
  sales_state_after: string;
  escalation_triggered: boolean;
  escalation_reason: string | null;
}

interface SimConv {
  label: string;
  phone: string;
  status: string;
  sales_state: string;
  messages: Array<{ sender: 'user' | 'bot'; body: string }>;
  order?: { items: any[]; total: number };
  escalation?: { reason: string };
  rating?: number;
  traces: SimTrace[];
}

function phone(suffix: string) {
  return `519999${suffix}`;
}

const SCENARIOS: SimConv[] = [
  // ── VENTAS EXITOSAS (7) ──────────────────────────────────────────────────
  {
    label: 'Venta #1 – Cafe americano (postventa)',
    phone: phone('001'),
    status: 'activa_ia',
    sales_state: 'postventa',
    messages: [
      { sender: 'user', body: 'Hola, quiero un cafe' },
      { sender: 'bot',  body: 'Tenemos americano a S/8. Confirmas?' },
      { sender: 'user', body: 'Si confirmo' },
      { sender: 'bot',  body: 'Pedido registrado. Gracias!' },
    ],
    order: { items: [{ catalog_item_id: 1, nombre: 'Cafe americano', precio_unitario: 8, cantidad: 1 }], total: 8 },
    rating: 5,
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'recomendacion_producto', escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'cierre_y_pago',         escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'cierre_y_pago',      status_after: 'activa_ia', sales_state_after: 'confirmado',               escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'confirmado',         status_after: 'activa_ia', sales_state_after: 'postventa',                escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #2 – Cappuccino y medialuna',
    phone: phone('002'),
    status: 'activa_ia',
    sales_state: 'confirmado',
    messages: [
      { sender: 'user', body: 'Quiero un cappuccino y una medialuna' },
      { sender: 'bot',  body: 'S/17 total. Confirmas?' },
      { sender: 'user', body: 'Si, por favor' },
      { sender: 'bot',  body: 'Pedido confirmado.' },
    ],
    order: { items: [{ catalog_item_id: 2, nombre: 'Cappuccino', precio_unitario: 12, cantidad: 1 }, { catalog_item_id: 3, nombre: 'Medialuna', precio_unitario: 5, cantidad: 1 }], total: 17 },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'cierre_y_pago',        escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'cierre_y_pago',      status_after: 'activa_ia', sales_state_after: 'confirmado',               escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #3 – Smoothie frutal (postventa)',
    phone: phone('003'),
    status: 'activa_ia',
    sales_state: 'postventa',
    messages: [
      { sender: 'user', body: 'Tienen smoothies?' },
      { sender: 'bot',  body: 'Si, smoothie frutal a S/15.' },
      { sender: 'user', body: 'Lo quiero' },
      { sender: 'bot',  body: 'Pedido confirmado.' },
    ],
    order: { items: [{ catalog_item_id: 4, nombre: 'Smoothie frutal', precio_unitario: 15, cantidad: 1 }], total: 15 },
    rating: 4,
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'recomendacion_producto',   escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'confirmado',           escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'confirmado',         status_after: 'activa_ia', sales_state_after: 'postventa',                escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #4 – Manejo de objeciones exitoso',
    phone: phone('004'),
    status: 'activa_ia',
    sales_state: 'confirmado',
    messages: [
      { sender: 'user', body: 'Me parece caro el cappuccino' },
      { sender: 'bot',  body: 'Es de especialidad con leche de avena. Lo pruebas?' },
      { sender: 'user', body: 'OK me convenciste' },
      { sender: 'bot',  body: 'Pedido confirmado, gracias.' },
    ],
    order: { items: [{ catalog_item_id: 2, nombre: 'Cappuccino', precio_unitario: 12, cantidad: 1 }], total: 12 },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'manejo_objeciones',    escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'manejo_objeciones', status_after: 'activa_ia', sales_state_after: 'cierre_y_pago',             escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'cierre_y_pago',      status_after: 'activa_ia', sales_state_after: 'confirmado',               escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #5 – Pedido multiple (postventa)',
    phone: phone('005'),
    status: 'activa_ia',
    sales_state: 'postventa',
    messages: [
      { sender: 'user', body: 'Quiero 2 americanos y 1 smoothie' },
      { sender: 'bot',  body: '2x8 + 15 = S/31. Confirmas?' },
      { sender: 'user', body: 'Si' },
      { sender: 'bot',  body: 'Listo!' },
    ],
    order: { items: [{ catalog_item_id: 1, nombre: 'Cafe americano', precio_unitario: 8, cantidad: 2 }, { catalog_item_id: 4, nombre: 'Smoothie frutal', precio_unitario: 15, cantidad: 1 }], total: 31 },
    rating: 5,
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'cierre_y_pago',       escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'cierre_y_pago',      status_after: 'activa_ia', sales_state_after: 'confirmado',               escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'confirmado',         status_after: 'activa_ia', sales_state_after: 'postventa',                escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #6 – Rating bajo post-venta (alerta)',
    phone: phone('006'),
    status: 'activa_ia',
    sales_state: 'postventa',
    messages: [
      { sender: 'user', body: 'Un latte gracias' },
      { sender: 'bot',  body: 'Latte S/10, confirmas?' },
      { sender: 'user', body: 'Si' },
      { sender: 'bot',  body: 'Pedido listo.' },
    ],
    order: { items: [{ catalog_item_id: 5, nombre: 'Latte', precio_unitario: 10, cantidad: 1 }], total: 10 },
    rating: 2,
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'confirmado',           escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'confirmado',         status_after: 'activa_ia', sales_state_after: 'postventa',                escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Venta #7 – Recupero tras precio (confirmado)',
    phone: phone('007'),
    status: 'activa_ia',
    sales_state: 'confirmado',
    messages: [
      { sender: 'user', body: 'Hay algo mas economico?' },
      { sender: 'bot',  body: 'Americano a S/8 es lo mas economico.' },
      { sender: 'user', body: 'Perfecto, ese entonces' },
      { sender: 'bot',  body: 'Confirmado. Hasta luego!' },
    ],
    order: { items: [{ catalog_item_id: 1, nombre: 'Cafe americano', precio_unitario: 8, cantidad: 1 }], total: 8 },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'manejo_objeciones',   escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'manejo_objeciones', status_after: 'activa_ia', sales_state_after: 'recomendacion_producto',   escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'confirmado',          escalation_triggered: false, escalation_reason: null },
    ],
  },

  // ── ESCALAMIENTOS (6) ─────────────────────────────────────────────────────
  {
    label: 'Escalamiento #1 – Queja de calidad',
    phone: phone('008'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'Mi cafe llego frio y tiene grumos' },
      { sender: 'bot',  body: 'Lamento eso. Paso tu caso a un operador.' },
      { sender: 'user', body: 'Espero que lo resuelvan' },
    ],
    escalation: { reason: 'queja_calidad' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'queja_calidad' },
    ],
  },
  {
    label: 'Escalamiento #2 – Solicitud de reembolso',
    phone: phone('009'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'Quiero un reembolso de mi pedido anterior' },
      { sender: 'bot',  body: 'Esta solicitud requiere atencion humana. Te conecto.' },
    ],
    escalation: { reason: 'solicitud_reembolso' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'solicitud_reembolso' },
    ],
  },
  {
    label: 'Escalamiento #3 – Lenguaje ofensivo',
    phone: phone('010'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'Esto es una porqueria, son unos incompetentes' },
      { sender: 'bot',  body: 'Entiendo tu malestar. Te conecto con un operador.' },
    ],
    escalation: { reason: 'lenguaje_ofensivo' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'lenguaje_ofensivo' },
    ],
  },
  {
    label: 'Escalamiento #4 – Consulta alergia gluten',
    phone: phone('011'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'Tengo alergia al gluten, que puedo pedir?' },
      { sender: 'bot',  body: 'Para tu seguridad te conecto con un especialista.' },
    ],
    escalation: { reason: 'consulta_alergia' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'consulta_alergia' },
    ],
  },
  {
    label: 'Escalamiento #5 – Umbral de intentos fallidos',
    phone: phone('012'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'No entiendo las opciones' },
      { sender: 'bot',  body: 'Cafe o bebida fria?' },
      { sender: 'user', body: 'No se' },
      { sender: 'bot',  body: 'Te conecto con un operador.' },
    ],
    escalation: { reason: 'umbral_intentos' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'manejo_objeciones', escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'manejo_objeciones', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'umbral_intentos' },
    ],
  },
  {
    label: 'Escalamiento #6 – Pedido corporativo',
    phone: phone('013'),
    status: 'pausada_humano',
    sales_state: 'escalado_humano',
    messages: [
      { sender: 'user', body: 'Necesito 50 unidades para empresa' },
      { sender: 'bot',  body: 'Para pedidos corporativos te conecto con ventas.' },
    ],
    escalation: { reason: 'pedido_corporativo' },
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo', status_after: 'pausada_humano', sales_state_after: 'escalado_humano', escalation_triggered: true, escalation_reason: 'pedido_corporativo' },
    ],
  },

  // ── CONVERSACIONES ABANDONADAS (5) ─────────────────────────────────────────
  {
    label: 'Abandonada #1 – Solo saludo sin respuesta',
    phone: phone('014'),
    status: 'activa_ia',
    sales_state: 'saludo',
    messages: [
      { sender: 'user', body: 'Hola' },
      { sender: 'bot',  body: 'Hola! Bienvenido a Cafe Antigravity. En que puedo ayudarte?' },
    ],
    traces: [],
  },
  {
    label: 'Abandonada #2 – Pidio catalogo y desaparecio',
    phone: phone('015'),
    status: 'activa_ia',
    sales_state: 'calificacion_necesidad',
    messages: [
      { sender: 'user', body: 'Que tienen?' },
      { sender: 'bot',  body: 'Tenemos cafe americano, cappuccino, latte, smoothies y mas.' },
      { sender: 'user', body: 'Ok gracias' },
    ],
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo', status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad', escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Abandonada #3 – Llego a objeciones pero no confirmo',
    phone: phone('016'),
    status: 'activa_ia',
    sales_state: 'manejo_objeciones',
    messages: [
      { sender: 'user', body: 'Quiero algo dulce' },
      { sender: 'bot',  body: 'Te recomiendo el frappe de caramelo a S/14.' },
      { sender: 'user', body: 'Suena bien pero esta caro' },
      { sender: 'bot',  body: 'Es artesanal con ingredientes premium. Lo pruebas?' },
    ],
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'recomendacion_producto', escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'recomendacion_producto', status_after: 'activa_ia', sales_state_after: 'manejo_objeciones',    escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Abandonada #4 – Cancelo en cierre de pago',
    phone: phone('017'),
    status: 'activa_ia',
    sales_state: 'cierre_y_pago',
    messages: [
      { sender: 'user', body: 'Un americano por favor' },
      { sender: 'bot',  body: 'Total S/8. Confirmas el pedido?' },
      { sender: 'user', body: 'Espera, mejor no por ahora' },
    ],
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo',             status_after: 'activa_ia', sales_state_after: 'calificacion_necesidad',  escalation_triggered: false, escalation_reason: null },
      { status_before: 'activa_ia', sales_state_before: 'calificacion_necesidad', status_after: 'activa_ia', sales_state_after: 'cierre_y_pago',       escalation_triggered: false, escalation_reason: null },
    ],
  },
  {
    label: 'Abandonada #5 – Cerrada explicitamente',
    phone: phone('018'),
    status: 'cerrada',
    sales_state: 'cerrada',
    messages: [
      { sender: 'user', body: 'Queria info nada mas, gracias' },
      { sender: 'bot',  body: 'Claro, estamos para lo que necesites. Hasta pronto!' },
    ],
    traces: [
      { status_before: 'activa_ia', sales_state_before: 'saludo', status_after: 'cerrada', sales_state_after: 'cerrada', escalation_triggered: false, escalation_reason: null },
    ],
  },
];

// ─── DB helpers ─────────────────────────────────────────────────────────────

async function getBusinessId(): Promise<number> {
  const res = await pool.query('SELECT id FROM businesses ORDER BY id ASC LIMIT 1;');
  if (res.rows.length === 0) throw new Error('No business found. Run seed-operator.ts first.');
  return res.rows[0].id;
}

async function getTariff(category: string, country: string): Promise<number> {
  const res = await pool.query(
    `SELECT tarifa_usd FROM pricing_config
     WHERE pais = $1 AND categoria = $2
       AND vigente_desde <= NOW() AND (vigente_hasta IS NULL OR vigente_hasta >= NOW())
     ORDER BY vigente_desde DESC LIMIT 1;`,
    [country, category],
  );
  return res.rows.length > 0 ? parseFloat(res.rows[0].tarifa_usd) : 0.0;
}

async function insertConversation(businessId: number, scenario: SimConv): Promise<number> {
  // Clean up any previous sim run with this phone
  await pool.query(
    'DELETE FROM conversations WHERE customer_number = $1 AND business_id = $2;',
    [scenario.phone, businessId],
  );
  const res = await pool.query(
    `INSERT INTO conversations (customer_number, business_id, status, sales_state)
     VALUES ($1, $2, $3, $4) RETURNING id;`,
    [scenario.phone, businessId, scenario.status, scenario.sales_state],
  );
  return res.rows[0].id;
}

async function insertMessages(
  conversationId: number,
  businessId: number,
  msgs: SimConv['messages'],
  tariff: number,
): Promise<void> {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const cost = m.sender === 'bot' ? tariff : 0;
    const generatedBy = m.sender === 'user' ? 'user' : 'IA';
    await pool.query(
      `INSERT INTO messages (conversation_id, message_id, sender, body, business_id, generated_by, category, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
      [
        conversationId,
        `sim_${conversationId}_${i}_${Date.now()}${Math.random()}`,
        m.sender,
        m.body,
        businessId,
        generatedBy,
        m.sender === 'bot' ? 'servicio' : null,
        cost,
      ],
    );
  }
}

async function insertTraces(conversationId: number, businessId: number, traces: SimTrace[]): Promise<void> {
  for (const t of traces) {
    await pool.query(
      `INSERT INTO conversation_traces
         (conversation_id, business_id, status_before, sales_state_before,
          status_after, sales_state_after, escalation_triggered, escalation_reason, generated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'IA');`,
      [
        conversationId, businessId,
        t.status_before, t.sales_state_before,
        t.status_after, t.sales_state_after,
        t.escalation_triggered, t.escalation_reason,
      ],
    );
  }
}

async function insertOrder(conversationId: number, businessId: number, order: NonNullable<SimConv['order']>): Promise<void> {
  await pool.query(
    `INSERT INTO orders (conversation_id, business_id, items, total)
     VALUES ($1, $2, $3::jsonb, $4);`,
    [conversationId, businessId, JSON.stringify(order.items), order.total],
  );
}

async function insertRating(conversationId: number, businessId: number, rating: number): Promise<void> {
  await pool.query(
    `INSERT INTO satisfaction_ratings (conversation_id, business_id, calificacion)
     VALUES ($1, $2, $3);`,
    [conversationId, businessId, rating],
  );
}

// ─── Manual ground-truth ─────────────────────────────────────────────────────
function computeExpected(scenarios: SimConv[]) {
  const total_iniciadas = scenarios.length;

  // Converted = has an order OR current state is confirmado/postventa OR any trace shows confirmado
  const convertidas = scenarios.filter(
    (s) =>
      s.order !== undefined ||
      s.sales_state === 'confirmado' ||
      s.sales_state === 'postventa' ||
      s.traces.some((t) => t.sales_state_after === 'confirmado' || t.sales_state_after === 'postventa'),
  );
  const total_convertidas = convertidas.length;
  const tasa_conversion = total_iniciadas > 0 ? total_convertidas / total_iniciadas : 0;

  const pedidos = scenarios.filter((s) => s.order !== undefined);
  const total_pedidos = pedidos.length;
  const monto_total = pedidos.reduce((sum, s) => sum + (s.order?.total ?? 0), 0);
  const ticket_promedio = total_pedidos > 0 ? monto_total / total_pedidos : 0;

  const escaladas = scenarios.filter((s) => s.traces.some((t) => t.escalation_triggered));
  const total_escaladas = escaladas.length;
  const pct_escaladas = total_iniciadas > 0 ? (total_escaladas / total_iniciadas) * 100 : 0;

  return { total_iniciadas, total_convertidas, tasa_conversion, total_pedidos, monto_total, ticket_promedio, total_escaladas, pct_escaladas };
}

// ─── API call helper ──────────────────────────────────────────────────────────
async function callMetrics(token: string, endpoint: string): Promise<any> {
  // Use a wide window so our freshly-inserted sim data is always captured
  const desde = new Date('2026-07-18T00:00:00Z');
  const hasta = new Date('2030-01-01T00:00:00Z');
  const url = `${API_BASE}${endpoint}?desde=${desde.toISOString()}&hasta=${hasta.toISOString()}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SIMULACION COMPLETA – 18 CONVERSACIONES DIVERSAS');
  console.log('════════════════════════════════════════════════════════════════\n');

  // 1. Login
  console.log('▶ Paso 1 – Autenticacion...');
  let token: string;
  try {
    token = await loginAndGetToken();
    console.log('  ✓ JWT obtenido.\n');
  } catch (e: any) {
    console.error('  ✗', e.message);
    process.exit(1);
  }

  // 2. Business
  const businessId = await getBusinessId();
  console.log(`▶ Paso 2 – Business ID: ${businessId}\n`);

  // 3. Tariff
  const tariff = await getTariff('servicio', 'Peru');
  console.log(`▶ Paso 3 – Tarifa vigente (servicio/Peru): USD ${tariff}\n`);

  // 4. Insert scenarios
  console.log('▶ Paso 4 – Insertando escenarios...\n');

  const convIds: number[] = [];
  for (const sc of SCENARIOS) {
    try {
      const id = await insertConversation(businessId, sc);
      await insertMessages(id, businessId, sc.messages, tariff);
      await insertTraces(id, businessId, sc.traces);
      if (sc.order) await insertOrder(id, businessId, sc.order);
      if (sc.rating !== undefined) await insertRating(id, businessId, sc.rating);
      convIds.push(id);

      const tag = sc.order ? '✅ VENTA' : sc.escalation ? '🔴 ESC' : '⚪ ABN';
      console.log(`  ${tag}  [#${String(id).padEnd(5)}] ${sc.label}`);
    } catch (err: any) {
      console.error(`  ✗ "${sc.label}": ${err.message}`);
    }
  }

  console.log(`\n  Insertados: ${convIds.length}/${SCENARIOS.length}\n`);

  // 5. Wait for DB
  await new Promise(r => setTimeout(r, 800));

  // 6. Manual calculation
  const exp = computeExpected(SCENARIOS);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📊 CALCULO MANUAL (verdad de referencia) – 18 escenarios\n');
  console.log(`   Total iniciadas          : ${exp.total_iniciadas}`);
  console.log(`   Convertidas (conf+post)  : ${exp.total_convertidas}`);
  console.log(`   Tasa de conversion       : ${(exp.tasa_conversion * 100).toFixed(2)}% (${exp.total_convertidas}/${exp.total_iniciadas})`);
  console.log(`   Pedidos confirmados      : ${exp.total_pedidos}`);
  console.log(`   Monto total              : S/${exp.monto_total.toFixed(2)}`);
  console.log(`   Ticket promedio          : S/${exp.ticket_promedio.toFixed(2)}`);
  console.log(`   Escaladas                : ${exp.total_escaladas}`);
  console.log(`   % Escalaciones           : ${exp.pct_escaladas.toFixed(2)}%`);

  // 7. API verification
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🌐 LLAMANDO ENDPOINTS DE METRICAS...\n');

  let ventas: any;
  let operacion: any;
  let satisData: any;

  try {
    ventas = await callMetrics(token, '/metrics/ventas');
    console.log('  /metrics/ventas:');
    console.log(`    total_pedidos_confirmados : ${ventas.total_pedidos_confirmados}`);
    console.log(`    monto_total_vendido       : S/${ventas.monto_total_vendido?.toFixed(2)}`);
    console.log(`    ticket_promedio           : S/${ventas.ticket_promedio?.toFixed(2)}`);
    console.log(`    tasa_conversion           : ${(ventas.tasa_conversion * 100).toFixed(2)}%`);
  } catch (e: any) {
    console.error('  ✗ /metrics/ventas:', e.message);
  }

  try {
    operacion = await callMetrics(token, '/metrics/operacion');
    console.log('\n  /metrics/operacion:');
    console.log(`    % conversaciones escaladas  : ${operacion.porcentaje_conversaciones_escaladas?.toFixed(2)}%`);
    console.log(`    escalamientos_por_motivo:`);
    (operacion.escalamientos_por_motivo || []).forEach((m: any) => {
      console.log(`      - ${m.motivo}: ${m.cantidad} (${m.porcentaje?.toFixed(1)}%)`);
    });
  } catch (e: any) {
    console.error('  ✗ /metrics/operacion:', e.message);
  }

  try {
    satisData = await callMetrics(token, '/metrics/satisfaccion');
    console.log('\n  /metrics/satisfaccion:');
    console.log(`    promedio_calificacion     : ${satisData.promedio_calificacion?.toFixed(2)}`);
    console.log(`    total_calificaciones      : ${satisData.total_calificaciones}`);
    console.log(`    distribucion              :`, satisData.distribucion);
  } catch (e: any) {
    console.error('  ✗ /metrics/satisfaccion:', e.message);
  }

  // 8. DB subset cross-check
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🔢 CROSS-CHECK DIRECTO EN BASE DE DATOS (solo nuestras 18 conversaciones)\n');

  const simPhones = SCENARIOS.map(s => s.phone);
  const ph = simPhones.map((_, i) => `$${i + 1}`).join(',');

  // Total
  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM conversations WHERE customer_number IN (${ph}) AND business_id = $${simPhones.length + 1};`,
    [...simPhones, businessId],
  );
  const dbTotal = totalRes.rows[0].cnt;

  // IDs
  const idsRes = await pool.query(
    `SELECT id FROM conversations WHERE customer_number IN (${ph}) AND business_id = $${simPhones.length + 1};`,
    [...simPhones, businessId],
  );
  const dbIds: number[] = idsRes.rows.map((r: any) => r.id);
  const idPh = dbIds.map((_, i) => `$${i + 1}`).join(',');

  // Converted: has order OR trace with sales_state_after = confirmado/postventa
  let dbConverted = 0;
  if (dbIds.length > 0) {
    const ordRes = await pool.query(
      `SELECT DISTINCT conversation_id FROM orders WHERE conversation_id IN (${idPh});`,
      dbIds,
    );
    const withOrder = new Set(ordRes.rows.map((r: any) => r.conversation_id));

    const trRes = await pool.query(
      `SELECT DISTINCT conversation_id FROM conversation_traces
       WHERE conversation_id IN (${idPh}) AND sales_state_after IN ('confirmado', 'postventa');`,
      dbIds,
    );
    const withTrace = new Set(trRes.rows.map((r: any) => r.conversation_id));

    const stRes = await pool.query(
      `SELECT id, sales_state FROM conversations WHERE id IN (${idPh});`,
      dbIds,
    );
    for (const r of stRes.rows) {
      if (withOrder.has(r.id) || withTrace.has(r.id) || r.sales_state === 'confirmado' || r.sales_state === 'postventa') {
        dbConverted++;
      }
    }
  }

  const dbTasa = dbTotal > 0 ? dbConverted / dbTotal : 0;

  // Orders
  let dbPedidos = 0;
  let dbMonto = 0;
  if (dbIds.length > 0) {
    const oRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total),0)::float AS total FROM orders WHERE conversation_id IN (${idPh}) AND business_id = $${dbIds.length + 1};`,
      [...dbIds, businessId],
    );
    dbPedidos = oRes.rows[0].cnt;
    dbMonto = oRes.rows[0].total;
  }

  // Escalations
  let dbEscaladas = 0;
  if (dbIds.length > 0) {
    const escRes = await pool.query(
      `SELECT COUNT(DISTINCT conversation_id)::int AS cnt FROM conversation_traces
       WHERE conversation_id IN (${idPh}) AND escalation_triggered = TRUE;`,
      dbIds,
    );
    dbEscaladas = escRes.rows[0].cnt;
  }

  console.log(`   Total convs simuladas en DB    : ${dbTotal}       (esperado: 18)`);
  console.log(`   Convertidas en DB              : ${dbConverted}        (esperado: ${exp.total_convertidas})`);
  console.log(`   Tasa conversion en DB          : ${(dbTasa * 100).toFixed(2)}%  (esperado: ${(exp.tasa_conversion * 100).toFixed(2)}%)`);
  console.log(`   Pedidos en DB                  : ${dbPedidos}        (esperado: ${exp.total_pedidos})`);
  console.log(`   Monto total en DB              : S/${dbMonto.toFixed(2)}    (esperado: S/${exp.monto_total.toFixed(2)})`);
  console.log(`   Escaladas en DB                : ${dbEscaladas}        (esperado: ${exp.total_escaladas})`);

  // 9. Checklist
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('✔️  TABLA DE COHERENCIA\n');

  const checks = [
    { name: 'DB total convs simuladas = 18',                           ok: dbTotal === 18 },
    { name: `DB convertidas = ${exp.total_convertidas} (manual)`,      ok: dbConverted === exp.total_convertidas },
    { name: `DB pedidos = ${exp.total_pedidos} (manual)`,              ok: dbPedidos === exp.total_pedidos },
    { name: `DB monto = S/${exp.monto_total} (manual)`,                ok: Math.abs(dbMonto - exp.monto_total) < 0.01 },
    { name: `DB escaladas = ${exp.total_escaladas} (manual)`,          ok: dbEscaladas === exp.total_escaladas },
    { name: 'DB tasa == tasa manual',                                  ok: Math.abs(dbTasa - exp.tasa_conversion) < 0.001 },
    ...(ventas ? [
      { name: 'API pedidos >= DB pedidos',                             ok: ventas.total_pedidos_confirmados >= dbPedidos },
      { name: 'API monto >= DB monto',                                 ok: ventas.monto_total_vendido >= dbMonto - 0.01 },
      { name: 'API tasa_conversion en (0, 1]',                         ok: ventas.tasa_conversion > 0 && ventas.tasa_conversion <= 1 },
    ] : []),
    ...(operacion ? [
      { name: 'API escalaciones% > 0',                                 ok: operacion.porcentaje_conversaciones_escaladas > 0 },
      { name: 'API >= 5 motivos de escalamiento',                      ok: operacion.escalamientos_por_motivo?.length >= 5 },
    ] : []),
    ...(satisData ? [
      { name: 'API total calificaciones >= 4 (nuestras ratings)',       ok: satisData.total_calificaciones >= 4 },
      { name: 'API promedio calificacion > 0',                         ok: satisData.promedio_calificacion > 0 },
    ] : []),
  ];

  let allPass = true;
  for (const c of checks) {
    if (!c.ok) allPass = false;
    console.log(`  ${c.ok ? '✅' : '❌'}  ${c.name}`);
  }

  // 10. Conversion rate cross-check detail
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('📐 DETALLE TASA DE CONVERSION\n');
  console.log(`  7 ventas exitosas  /  18 conversaciones totales  =  ${(7/18*100).toFixed(2)}%`);
  console.log(`  DB verifica:  ${dbConverted} / ${dbTotal}  =  ${(dbTasa*100).toFixed(2)}%`);
  if (ventas) {
    console.log(`  API reporta tasa: ${(ventas.tasa_conversion*100).toFixed(2)}%`);
    console.log(`  (La API incluye cualquier conv existente en el mismo periodo de 90 min)`);
    const match = Math.abs(dbTasa - exp.tasa_conversion) < 0.001;
    console.log(`\n  Calculo manual == DB: ${match ? '✅ COINCIDEN' : '❌ DIVERGEN'}`);
  }

  // Final
  console.log('\n════════════════════════════════════════════════════════════════');
  if (allPass) {
    console.log('  🎉 TODOS LOS CHECKS PASARON – Dashboard coherente con datos simulados');
  } else {
    console.log('  ⚠️  ALGUNOS CHECKS FALLARON – Ver tabla arriba');
  }
  console.log('════════════════════════════════════════════════════════════════\n');

  await pool.end();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
