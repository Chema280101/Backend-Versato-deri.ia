import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

export interface Migration {
  name: string;
  up: (client: PoolClient) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    name: '001_initial_schema',
    up: async (client: PoolClient) => {
      // Create baseline conversations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id SERIAL PRIMARY KEY,
          wa_id VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create baseline messages table
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          message_id VARCHAR(255) UNIQUE,
          sender VARCHAR(50) NOT NULL,
          body TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    name: '002_phase2_schema',
    up: async (client: PoolClient) => {
      // 1. Create businesses table
      await client.query(`
        CREATE TABLE IF NOT EXISTS businesses (
          id SERIAL PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          phone_number_id VARCHAR(255) UNIQUE NOT NULL,
          catalog_config JSONB DEFAULT '{}'::jsonb,
          brand_prompt TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Insert default business (id=1) for backward compatibility
      await client.query(`
        INSERT INTO businesses (id, name, phone_number_id)
        VALUES (1, 'Default Business', '106540352242922')
        ON CONFLICT (id) DO NOTHING;
      `);

      // Fix the serial sequence increment for businesses table
      await client.query(`
        SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 1)) FROM businesses;
      `);

      // 3. Modify conversations table
      // Add business_id column (initially nullable to allow backfilling)
      await client.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS business_id INT REFERENCES businesses(id) ON DELETE CASCADE;
      `);

      // Backfill existing conversations to default business
      await client.query(`
        UPDATE conversations SET business_id = 1 WHERE business_id IS NULL;
      `);

      // Make business_id NOT NULL
      await client.query(`
        ALTER TABLE conversations ALTER COLUMN business_id SET NOT NULL;
      `);

      // Add status column with check constraint
      await client.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'activa_ia' NOT NULL;
      `);

      // Drop any existing constraint on status and add validation CHECK
      await client.query(`
        ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
      `);
      await client.query(`
        ALTER TABLE conversations ADD CONSTRAINT conversations_status_check CHECK (status IN ('activa_ia', 'pausada_humano', 'cerrada'));
      `);

      // Rename wa_id to customer_number if not already renamed
      const checkCol = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='conversations' AND column_name='customer_number' AND table_schema = CURRENT_SCHEMA;
      `);

      if (checkCol.rows.length === 0) {
        // Drop unique constraint on wa_id first
        await client.query(`
          ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_wa_id_key;
        `);
        // Rename column
        await client.query(`
          ALTER TABLE conversations RENAME COLUMN wa_id TO customer_number;
        `);
      }

      // Add unique constraint on (business_id, customer_number)
      await client.query(`
        ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_business_id_customer_number_key;
      `);
      await client.query(`
        ALTER TABLE conversations ADD CONSTRAINT conversations_business_id_customer_number_key UNIQUE (business_id, customer_number);
      `);

      // 4. Modify messages table
      // Add business_id to messages
      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS business_id INT REFERENCES businesses(id) ON DELETE CASCADE;
      `);

      // Backfill existing messages to default business
      await client.query(`
        UPDATE messages SET business_id = 1 WHERE business_id IS NULL;
      `);

      // Make business_id NOT NULL
      await client.query(`
        ALTER TABLE messages ALTER COLUMN business_id SET NOT NULL;
      `);
    },
  },
  {
    name: '003_phase2_products_and_state',
    up: async (client: PoolClient) => {
      // 1. Add sales_state column to conversations
      await client.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sales_state VARCHAR(50) DEFAULT 'inicio' NOT NULL;
      `);

      // Drop any existing constraint on sales_state and add validation CHECK
      await client.query(`
        ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_sales_state_check;
      `);
      await client.query(`
        ALTER TABLE conversations ADD CONSTRAINT conversations_sales_state_check CHECK (sales_state IN ('inicio', 'seleccion', 'confirmacion', 'completado'));
      `);

      // 2. Create products table
      await client.query(`
        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
          sku VARCHAR(100) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          price DECIMAL(10, 2) NOT NULL,
          stock INT NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 3. Seed default products for default business (id=1)
      await client.query(`
        INSERT INTO products (business_id, sku, name, price, stock, description)
        VALUES 
          (1, 'CAFE_ESPRESSO', 'Café Espresso', 2.50, 50, 'Café negro corto y fuerte.'),
          (1, 'CAPUCHINO', 'Capuchino', 3.50, 30, 'Café espresso con leche y espuma de leche.'),
          (1, 'CROISSANT_JQ', 'Croissant de Jamón y Queso', 4.00, 15, 'Cruasán relleno de jamón y queso derretido.')
        ON CONFLICT (sku) DO NOTHING;
      `);
    },
  },
  {
    name: '004_catalog_items',
    up: async (client: PoolClient) => {
      // 1. Create catalog_items table
      await client.query(`
        CREATE TABLE IF NOT EXISTS catalog_items (
          id SERIAL PRIMARY KEY,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
          nombre VARCHAR(255) NOT NULL,
          descripcion TEXT,
          precio DECIMAL(10, 2) NOT NULL,
          stock INT NOT NULL,
          categoria VARCHAR(255) NOT NULL,
          activo BOOLEAN DEFAULT TRUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Parse and seed from seed_catalog.csv
      const csvPath = path.join(__dirname, 'seed_catalog.csv');
      if (fs.existsSync(csvPath)) {
        const parseCSVLine = (line: string): string[] => {
          const result: string[] = [];
          let current = '';
          let inQuotes = false;
          for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
              if (inQuotes && line[j + 1] === '"') {
                current += '"';
                j++;
              } else {
                inQuotes = !inQuotes;
              }
            } else if (char === ',' && !inQuotes) {
              result.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          result.push(current.trim());
          return result;
        };

        const csvContent = fs.readFileSync(csvPath, 'utf8');
        const lines = csvContent.split(/\r?\n/);
        if (lines.length > 1) {
          const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
          const nameIndex = headers.indexOf('nombre');
          const descIndex = headers.findIndex(
            (h) => h.includes('descrip') || h.includes('descripción'),
          );
          const priceIndex = headers.indexOf('precio');
          const stockIndex = headers.indexOf('stock');
          const catIndex = headers.findIndex(
            (h) => h.includes('categor') || h.includes('categoría'),
          );

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parsedValues = parseCSVLine(line);

            const nombre = parsedValues[nameIndex];
            const descripcion = descIndex !== -1 ? parsedValues[descIndex] : '';
            const precio = priceIndex !== -1 ? parseFloat(parsedValues[priceIndex]) : 0;
            const stock = stockIndex !== -1 ? parseInt(parsedValues[stockIndex], 10) : 0;
            const categoria = catIndex !== -1 ? parsedValues[catIndex] : '';

            if (nombre) {
              await client.query(
                `
                INSERT INTO catalog_items (business_id, nombre, descripcion, precio, stock, categoria, activo)
                VALUES (1, $1, $2, $3, $4, $5, true);
              `,
                [nombre, descripcion, precio, stock, categoria],
              );
            }
          }
        }
      }
    },
  },
  {
    name: '005_update_catalog_seed',
    up: async (client: PoolClient) => {
      // Delete any previously seeded catalog items for business 1 to prevent duplication
      await client.query('DELETE FROM catalog_items WHERE business_id = 1;');

      // Parse and seed from seed_catalog.csv
      const csvPath = path.join(__dirname, 'seed_catalog.csv');
      if (fs.existsSync(csvPath)) {
        const parseCSVLine = (line: string): string[] => {
          const result: string[] = [];
          let current = '';
          let inQuotes = false;
          for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
              if (inQuotes && line[j + 1] === '"') {
                current += '"';
                j++;
              } else {
                inQuotes = !inQuotes;
              }
            } else if (char === ',' && !inQuotes) {
              result.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          result.push(current.trim());
          return result;
        };

        const csvContent = fs.readFileSync(csvPath, 'utf8');
        const lines = csvContent.split(/\r?\n/);
        if (lines.length > 1) {
          const headers = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
          const nameIndex = headers.indexOf('nombre');
          const descIndex = headers.findIndex(
            (h) => h.includes('descrip') || h.includes('descripción'),
          );
          const priceIndex = headers.indexOf('precio');
          const stockIndex = headers.indexOf('stock');
          const catIndex = headers.findIndex(
            (h) => h.includes('categor') || h.includes('categoría'),
          );

          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parsedValues = parseCSVLine(line);

            const nombre = parsedValues[nameIndex];
            const descripcion = descIndex !== -1 ? parsedValues[descIndex] : '';
            const precio = priceIndex !== -1 ? parseFloat(parsedValues[priceIndex]) : 0;
            const stock = stockIndex !== -1 ? parseInt(parsedValues[stockIndex], 10) : 0;
            const categoria = catIndex !== -1 ? parsedValues[catIndex] : '';

            if (nombre) {
              await client.query(
                `
                INSERT INTO catalog_items (business_id, nombre, descripcion, precio, stock, categoria, activo)
                VALUES (1, $1, $2, $3, $4, $5, true);
              `,
                [nombre, descripcion, precio, stock, categoria],
              );
            }
          }
        }
      }
    },
  },
  {
    name: '006_sales_stage_fase2',
    up: async (client: PoolClient) => {
      // 1. Drop existing check constraint on sales_state
      await client.query(`
        ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_sales_state_check;
      `);

      // 2. Update existing rows with obsolete states to 'saludo'
      await client.query(`
        UPDATE conversations 
        SET sales_state = 'saludo' 
        WHERE sales_state NOT IN (
          'saludo', 'calificacion_necesidad', 'recomendacion_producto', 
          'manejo_objeciones', 'cierre_y_pago', 'confirmado', 
          'postventa', 'escalado_humano', 'cerrada'
        );
      `);

      // 3. Alter default value of sales_state to 'saludo'
      await client.query(`
        ALTER TABLE conversations ALTER COLUMN sales_state SET DEFAULT 'saludo';
      `);

      // 4. Add new check constraint
      await client.query(`
        ALTER TABLE conversations ADD CONSTRAINT conversations_sales_state_check CHECK (
          sales_state IN (
            'saludo', 'calificacion_necesidad', 'recomendacion_producto', 
            'manejo_objeciones', 'cierre_y_pago', 'confirmado', 
            'postventa', 'escalado_humano', 'cerrada'
          )
        );
      `);
    },
  },
  {
    name: '007_human_escalation_rules',
    up: async (client: PoolClient) => {
      // 1. Add escalation_threshold column to businesses table
      await client.query(`
        ALTER TABLE businesses ADD COLUMN IF NOT EXISTS escalation_threshold DECIMAL(10, 2) DEFAULT NULL;
      `);

      // 2. Add amount and consecutive_attempts columns to conversations table
      await client.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS amount DECIMAL(10, 2) DEFAULT 0.00 NOT NULL;
      `);
      await client.query(`
        ALTER TABLE conversations ADD COLUMN IF NOT EXISTS consecutive_attempts INT DEFAULT 0 NOT NULL;
      `);

      // 3. Create notifications table
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE,
          type VARCHAR(100) NOT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    name: '008_conversational_traces',
    up: async (client: PoolClient) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversation_traces (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE,
          status_before VARCHAR(50) NOT NULL,
          sales_state_before VARCHAR(50) NOT NULL,
          status_after VARCHAR(50) NOT NULL,
          sales_state_after VARCHAR(50) NOT NULL,
          llm_decision JSONB,
          escalation_triggered BOOLEAN DEFAULT FALSE NOT NULL,
          escalation_reason VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    name: '009_extend_conversation_traces',
    up: async (client: PoolClient) => {
      // 1. Add business_id column (initially nullable to allow backfilling)
      await client.query(`
        ALTER TABLE conversation_traces ADD COLUMN IF NOT EXISTS business_id INT REFERENCES businesses(id) ON DELETE CASCADE;
      `);

      // 2. Backfill business_id from conversations
      await client.query(`
        UPDATE conversation_traces ct
        SET business_id = c.business_id
        FROM conversations c
        WHERE ct.conversation_id = c.id;
      `);

      // In case any trace exists without a conversation (shouldn't happen due to FK), default to 1
      await client.query(`
        UPDATE conversation_traces SET business_id = 1 WHERE business_id IS NULL;
      `);

      // Make business_id NOT NULL
      await client.query(`
        ALTER TABLE conversation_traces ALTER COLUMN business_id SET NOT NULL;
      `);

      // 3. Add generated_by column (initially nullable to allow backfilling)
      await client.query(`
        ALTER TABLE conversation_traces ADD COLUMN IF NOT EXISTS generated_by VARCHAR(50);
      `);

      // 4. Backfill generated_by. If status_before was 'pausada_humano', it was handled by human, otherwise by IA.
      await client.query(`
        UPDATE conversation_traces
        SET generated_by = CASE 
          WHEN status_before = 'pausada_humano' THEN 'humano'
          ELSE 'IA'
        END;
      `);

      // Make generated_by NOT NULL
      await client.query(`
        ALTER TABLE conversation_traces ALTER COLUMN generated_by SET NOT NULL;
      `);

      // 5. Add check constraint to generated_by
      await client.query(`
        ALTER TABLE conversation_traces ADD CONSTRAINT conversation_traces_generated_by_check CHECK (generated_by IN ('IA', 'humano'));
      `);
    },
  },
  {
    name: '010_auth_and_operator_users',
    up: async (client: PoolClient) => {
      // 1. Create users table
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          nombre VARCHAR(255) NOT NULL,
          rol VARCHAR(50) NOT NULL
        );
      `);

      // 2. Create audit_logs table
      await client.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
          user_id INT REFERENCES users(id) ON DELETE SET NULL,
          action VARCHAR(50) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
      `);
    },
  },
  {
    name: '011_messages_generated_by',
    up: async (client: PoolClient) => {
      // 1. Add generated_by column (initially nullable)
      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS generated_by VARCHAR(50);
      `);

      // 2. Backfill existing messages based on sender
      await client.query(`
        UPDATE messages SET generated_by = 'user' WHERE sender = 'user' AND generated_by IS NULL;
      `);
      await client.query(`
        UPDATE messages SET generated_by = 'IA' WHERE sender = 'bot' AND generated_by IS NULL;
      `);

      // 3. Ensure any fallback gets backfilled as 'IA' if still null
      await client.query(`
        UPDATE messages SET generated_by = 'IA' WHERE generated_by IS NULL;
      `);

      // 4. Add constraint, set DEFAULT and set NOT NULL
      await client.query(`
        ALTER TABLE messages ADD CONSTRAINT messages_generated_by_check CHECK (generated_by IN ('user', 'IA', 'humano'));
      `);
      await client.query(`
        ALTER TABLE messages ALTER COLUMN generated_by SET DEFAULT 'IA';
      `);
      await client.query(`
        ALTER TABLE messages ALTER COLUMN generated_by SET NOT NULL;
      `);
    },
  },
  {
    name: '012_messages_user_id',
    up: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;
      `);
    },
  },
  {
    name: '013_business_alert_threshold',
    up: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE businesses ADD COLUMN IF NOT EXISTS alert_pending_threshold_hours INT DEFAULT 2 NOT NULL;
      `);
    },
  },
  {
    name: '014_create_orders_table',
    up: async (client: PoolClient) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
          items JSONB NOT NULL,
          total DECIMAL(10, 2) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
      `);
    },
  },
  {
    name: '015_pricing_and_message_cost',
    up: async (client: PoolClient) => {
      // 1. Create pricing_config table
      await client.query(`
        CREATE TABLE IF NOT EXISTS pricing_config (
          id SERIAL PRIMARY KEY,
          pais VARCHAR(100) NOT NULL,
          categoria VARCHAR(50) NOT NULL CONSTRAINT pricing_config_categoria_check CHECK (categoria IN ('marketing', 'utilidad', 'servicio', 'autenticacion')),
          tarifa_usd DECIMAL(10, 4) NOT NULL,
          vigente_desde TIMESTAMP NOT NULL,
          vigente_hasta TIMESTAMP,
          CONSTRAINT pricing_config_dates_check CHECK (vigente_hasta IS NULL OR vigente_desde <= vigente_hasta)
        );
      `);

      // 2. Create index on pricing_config for fast query lookup
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pricing_config_lookup 
        ON pricing_config (pais, categoria, vigente_desde, vigente_hasta);
      `);

      // 3. Extend messages table with category and cost
      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS category VARCHAR(50) CONSTRAINT messages_category_check CHECK (category IN ('marketing', 'utilidad', 'servicio', 'autenticacion'));
      `);
      await client.query(`
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS cost DECIMAL(10, 4) DEFAULT 0.0000;
      `);

      // 4. Seed initial default tariffs (Perú and Argentina) starting Jan 2026
      await client.query(`
        INSERT INTO pricing_config (pais, categoria, tarifa_usd, vigente_desde, vigente_hasta)
        VALUES 
          ('Peru', 'marketing', 0.0730, '2026-01-01 00:00:00', NULL),
          ('Peru', 'utilidad', 0.0350, '2026-01-01 00:00:00', NULL),
          ('Peru', 'servicio', 0.0100, '2026-01-01 00:00:00', NULL),
          ('Peru', 'autenticacion', 0.0650, '2026-01-01 00:00:00', NULL),
          ('Argentina', 'marketing', 0.0620, '2026-01-01 00:00:00', NULL),
          ('Argentina', 'utilidad', 0.0310, '2026-01-01 00:00:00', NULL),
          ('Argentina', 'servicio', 0.0090, '2026-01-01 00:00:00', NULL),
          ('Argentina', 'autenticacion', 0.0550, '2026-01-01 00:00:00', NULL)
        ON CONFLICT DO NOTHING;
      `);
    },
  },
  {
    name: '016_satisfaction_ratings',
    up: async (client: PoolClient) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS satisfaction_ratings (
          id SERIAL PRIMARY KEY,
          conversation_id INT REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
          business_id INT REFERENCES businesses(id) ON DELETE CASCADE NOT NULL,
          calificacion INT,
          comentario TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
      `);
    },
  },
  {
    name: '017_user_avatar_and_profile_updates',
    up: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS nombre_last_changed_at TIMESTAMP;
      `);
    },
  },
  {
    name: '018_business_training_info_and_policies',
    up: async (client: PoolClient) => {
      await client.query(`
        ALTER TABLE businesses ADD COLUMN IF NOT EXISTS training_info TEXT;
      `);
    },
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
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

    // Fetch already executed migrations
    const { rows } = await client.query('SELECT name FROM migrations ORDER BY id ASC;');
    const executed = new Set(rows.map((r: { name: string }) => r.name));

    for (const migration of migrations) {
      if (!executed.has(migration.name)) {
        console.log(`[INFO]: Executing database migration: ${migration.name}`);
        await migration.up(client);
        await client.query('INSERT INTO migrations (name) VALUES ($1);', [migration.name]);
      }
    }

    await client.query('COMMIT');
    console.log('[INFO]: Database migrations completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[ERROR]: Database migration failed, transaction rolled back:', error);
    throw error;
  } finally {
    client.release();
  }
}
