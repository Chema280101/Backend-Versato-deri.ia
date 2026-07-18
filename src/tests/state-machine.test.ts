import { pool } from '../services/db.service';
import { runMigrations } from '../migrations';
import {
  validateAndApplyTransition,
  isValidSalesStateTransition,
  SalesState,
} from '../services/state-machine.service';

describe('Sales Cycle State Machine', () => {
  const testSchema = 'test_state_machine';

  beforeAll(async () => {
    // 1. Setup clean schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchema};`);
    await pool.query(`SET search_path TO ${testSchema};`);

    // 2. Run migrations to initialize all tables (including our new check constraints)
    await runMigrations(pool);

    // 3. Populate a default business for relational integrity
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
    // Reset conversations table before each test
    await pool.query('DELETE FROM conversations;');
  });

  describe('Unit Transition Rules validation', () => {
    it('should validate allowed transitions correctly', () => {
      // saludo -> calificacion_necesidad is allowed
      expect(isValidSalesStateTransition('saludo', 'calificacion_necesidad')).toBe(true);
      // recomendacion_producto -> cierre_y_pago is allowed
      expect(isValidSalesStateTransition('recomendacion_producto', 'cierre_y_pago')).toBe(true);
      // confirmado -> postventa is allowed
      expect(isValidSalesStateTransition('confirmado', 'postventa')).toBe(true);
      // postventa -> saludo is allowed
      expect(isValidSalesStateTransition('postventa', 'saludo')).toBe(true);
    });

    it('should reject invalid transitions correctly', () => {
      // saludo -> confirmado is NOT allowed
      expect(isValidSalesStateTransition('saludo', 'confirmado')).toBe(false);
      // calificacion_necesidad -> postventa is NOT allowed
      expect(isValidSalesStateTransition('calificacion_necesidad', 'postventa')).toBe(false);
      // recomendacion_producto -> confirmado is NOT allowed
      expect(isValidSalesStateTransition('recomendacion_producto', 'confirmado')).toBe(false);
      // postventa -> calificacion_necesidad is NOT allowed
      expect(isValidSalesStateTransition('postventa', 'calificacion_necesidad')).toBe(false);
    });

    it('should allow self-transitions', () => {
      expect(isValidSalesStateTransition('saludo', 'saludo')).toBe(true);
      expect(isValidSalesStateTransition('calificacion_necesidad', 'calificacion_necesidad')).toBe(
        true,
      );
      expect(isValidSalesStateTransition('confirmado', 'confirmado')).toBe(true);
    });

    it('should allow escalation to escalado_humano from any state', () => {
      const states: SalesState[] = [
        'saludo',
        'calificacion_necesidad',
        'recomendacion_producto',
        'manejo_objeciones',
        'cierre_y_pago',
        'confirmado',
        'postventa',
        'escalado_humano',
        'cerrada',
      ];

      for (const state of states) {
        expect(isValidSalesStateTransition(state, 'escalado_humano')).toBe(true);
      }
    });
  });

  describe('validateAndApplyTransition integration with DB', () => {
    const createConversation = async (status: string, salesState: string): Promise<number> => {
      const result = await pool.query(
        `INSERT INTO conversations (customer_number, business_id, status, sales_state) 
         VALUES ('5001110001', 1, $1, $2) RETURNING id;`,
        [status, salesState],
      );
      return result.rows[0].id;
    };

    const getConversation = async (id: number) => {
      const result = await pool.query(
        'SELECT status, sales_state FROM conversations WHERE id = $1;',
        [id],
      );
      return result.rows[0];
    };

    it('should apply valid transitions and update the database', async () => {
      const convId = await createConversation('activa_ia', 'saludo');

      const result = await validateAndApplyTransition(
        convId,
        'activa_ia',
        'saludo',
        undefined,
        'calificacion_necesidad',
      );

      expect(result.success).toBe(true);
      expect(result.salesState).toBe('calificacion_necesidad');

      const dbConv = await getConversation(convId);
      expect(dbConv.sales_state).toBe('calificacion_necesidad');
      expect(dbConv.status).toBe('activa_ia');
    });

    it('should reject invalid transitions, return a clear error, and not modify the database', async () => {
      const convId = await createConversation('activa_ia', 'saludo');

      const result = await validateAndApplyTransition(
        convId,
        'activa_ia',
        'saludo',
        undefined,
        'confirmado',
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        "Invalid transition for sales state from 'saludo' to 'confirmado'",
      );

      const dbConv = await getConversation(convId);
      expect(dbConv.sales_state).toBe('saludo');
      expect(dbConv.status).toBe('activa_ia');
    });

    it('should support forcing escalado_humano from any state and sync status to pausada_humano', async () => {
      const testStates: SalesState[] = [
        'saludo',
        'calificacion_necesidad',
        'recomendacion_producto',
        'confirmado',
      ];

      for (let i = 0; i < testStates.length; i++) {
        const fromState = testStates[i];
        const uniqueCustomer = `500111999${i}`;
        const insertResult = await pool.query(
          `INSERT INTO conversations (customer_number, business_id, status, sales_state) 
           VALUES ($1, 1, 'activa_ia', $2) RETURNING id;`,
          [uniqueCustomer, fromState],
        );
        const convId = insertResult.rows[0].id;

        const result = await validateAndApplyTransition(
          convId,
          'activa_ia',
          fromState,
          undefined,
          'escalado_humano',
        );

        expect(result.success).toBe(true);
        expect(result.salesState).toBe('escalado_humano');
        expect(result.status).toBe('pausada_humano');

        const dbConv = await getConversation(convId);
        expect(dbConv.sales_state).toBe('escalado_humano');
        expect(dbConv.status).toBe('pausada_humano');
      }
    });

    it('should automatically set sales_state to escalado_humano if status is changed to pausada_humano', async () => {
      const convId = await createConversation('activa_ia', 'calificacion_necesidad');

      const result = await validateAndApplyTransition(
        convId,
        'activa_ia',
        'calificacion_necesidad',
        'pausada_humano',
        undefined,
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('pausada_humano');
      expect(result.salesState).toBe('escalado_humano');

      const dbConv = await getConversation(convId);
      expect(dbConv.status).toBe('pausada_humano');
      expect(dbConv.sales_state).toBe('escalado_humano');
    });

    it('should automatically set status to cerrada if sales_state is changed to cerrada', async () => {
      const convId = await createConversation('activa_ia', 'postventa');

      const result = await validateAndApplyTransition(
        convId,
        'activa_ia',
        'postventa',
        undefined,
        'cerrada',
      );

      expect(result.success).toBe(true);
      expect(result.status).toBe('cerrada');
      expect(result.salesState).toBe('cerrada');

      const dbConv = await getConversation(convId);
      expect(dbConv.status).toBe('cerrada');
      expect(dbConv.sales_state).toBe('cerrada');
    });

    it('should reset sales_state to saludo if resuming conversation back to activa_ia from escalado_humano/cerrada without specifying target state', async () => {
      const convId1 = await createConversation('pausada_humano', 'escalado_humano');

      const result1 = await validateAndApplyTransition(
        convId1,
        'pausada_humano',
        'escalado_humano',
        'activa_ia',
        undefined,
      );

      expect(result1.success).toBe(true);
      expect(result1.status).toBe('activa_ia');
      expect(result1.salesState).toBe('saludo');

      const dbConv1 = await getConversation(convId1);
      expect(dbConv1.status).toBe('activa_ia');
      expect(dbConv1.sales_state).toBe('saludo');
    });
  });
});
