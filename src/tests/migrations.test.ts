import { pool } from '../services/db.service';
import { migrations } from '../migrations';

describe('Database Migrations', () => {
  const testSchemaName = 'test_migrations_validation';

  beforeAll(async () => {
    // Create a clean test schema
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchemaName} CASCADE;`);
    await pool.query(`CREATE SCHEMA ${testSchemaName};`);
  });

  afterAll(async () => {
    // Drop the schema to clean up
    await pool.query(`DROP SCHEMA IF EXISTS ${testSchemaName} CASCADE;`);
    // Close the database connection pool
    await pool.end();
  });

  it('should run migrations cleanly on a blank database schema and verify constraints', async () => {
    const client = await pool.connect();
    try {
      // Set the search path so that the migration runner creates tables inside the test schema
      await client.query(`SET search_path TO ${testSchemaName};`);

      // Run migrations tracker table creation & run all migrations
      try {
        await client.query('BEGIN');

        // Create migrations tracker table
        await client.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // Fetch executed migrations (should be empty)
        const { rows } = await client.query('SELECT name FROM migrations ORDER BY id ASC;');
        expect(rows.length).toBe(0);

        // Execute each migration on the client
        for (const m of migrations) {
          await m.up(client);
          await client.query('INSERT INTO migrations (name) VALUES ($1);', [m.name]);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }

      // Verify that the tables exist in our test schema
      const tablesResult = await client.query(
        `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = $1;
      `,
        [testSchemaName],
      );

      const tableNames = tablesResult.rows.map((r: { table_name: string }) => r.table_name);

      expect(tableNames).toContain('migrations');
      expect(tableNames).toContain('businesses');
      expect(tableNames).toContain('conversations');
      expect(tableNames).toContain('messages');
      expect(tableNames).toContain('products');
      expect(tableNames).toContain('catalog_items');
      expect(tableNames).toContain('conversation_traces');

      // Verify columns in 'businesses'
      const businessesColumnsResult = await client.query(
        `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = 'businesses';
      `,
        [testSchemaName],
      );

      const businessesColumns = businessesColumnsResult.rows.reduce(
        (acc: Record<string, string>, row: { column_name: string; data_type: string }) => {
          acc[row.column_name] = row.data_type;
          return acc;
        },
        {},
      );

      expect(businessesColumns).toHaveProperty('id');
      expect(businessesColumns).toHaveProperty('name');
      expect(businessesColumns).toHaveProperty('phone_number_id');
      expect(businessesColumns).toHaveProperty('catalog_config');
      expect(businessesColumns).toHaveProperty('brand_prompt');

      // Verify columns in 'conversations'
      const conversationsColumnsResult = await client.query(
        `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = 'conversations';
      `,
        [testSchemaName],
      );

      const conversationsColumns = conversationsColumnsResult.rows.reduce(
        (acc: Record<string, string>, row: { column_name: string; data_type: string }) => {
          acc[row.column_name] = row.data_type;
          return acc;
        },
        {},
      );

      expect(conversationsColumns).toHaveProperty('id');
      expect(conversationsColumns).toHaveProperty('business_id');
      expect(conversationsColumns).toHaveProperty('customer_number');
      expect(conversationsColumns).toHaveProperty('status');
      expect(conversationsColumns).toHaveProperty('sales_state');

      // Verify constraints on conversations status check
      const statusConstraintResult = await client.query(
        `
        SELECT cc.check_clause
        FROM information_schema.table_constraints tc
        JOIN information_schema.check_constraints cc ON tc.constraint_name = cc.constraint_name
        WHERE tc.table_schema = $1 AND tc.table_name = 'conversations' AND tc.constraint_type = 'CHECK';
      `,
        [testSchemaName],
      );

      const checkClauses = statusConstraintResult.rows.map(
        (r: { check_clause: string }) => r.check_clause,
      );
      expect(checkClauses.length).toBeGreaterThan(0);

      // Verify unique constraint on conversations(business_id, customer_number)
      const uniqueConstraintResult = await client.query(
        `
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        WHERE tc.table_schema = $1 AND tc.table_name = 'conversations' AND tc.constraint_type = 'UNIQUE';
      `,
        [testSchemaName],
      );
      expect(uniqueConstraintResult.rows.length).toBeGreaterThan(0);

      // Verify messages columns
      const messagesColumnsResult = await client.query(
        `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = 'messages';
      `,
        [testSchemaName],
      );
      const messagesColumns = messagesColumnsResult.rows.map(
        (r: { column_name: string }) => r.column_name,
      );
      expect(messagesColumns).toContain('business_id');
      expect(messagesColumns).toContain('conversation_id');
      expect(messagesColumns).toContain('generated_by');

      // Verify products columns
      const productsColumnsResult = await client.query(
        `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = $1 AND table_name = 'products';
      `,
        [testSchemaName],
      );
      const productsColumns = productsColumnsResult.rows.map(
        (r: { column_name: string }) => r.column_name,
      );
      expect(productsColumns).toContain('id');
      expect(productsColumns).toContain('business_id');
      expect(productsColumns).toContain('sku');
      expect(productsColumns).toContain('name');
      expect(productsColumns).toContain('price');
      expect(productsColumns).toContain('stock');
      expect(productsColumns).toContain('description');
    } finally {
      // Revert search path
      await client.query('SET search_path TO public;');
      client.release();
    }
  });
});
