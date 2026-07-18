import { Pool } from 'pg';
import bcryptjs from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const sslConfig = process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

async function main() {
  try {
    console.log('Conectando a la base de datos...');
    
    // Check if default business exists
    const bizRes = await pool.query('SELECT id FROM businesses WHERE id = 1;');
    if (bizRes.rows.length === 0) {
      console.log('Creando negocio por defecto (id=1)...');
      await pool.query(`
        INSERT INTO businesses (id, name, phone_number_id)
        VALUES (1, 'Café Antigravity', '1239011389290003')
        ON CONFLICT (id) DO NOTHING;
      `);
      // Update serial sequence
      await pool.query(`
        SELECT setval(pg_get_serial_sequence('businesses', 'id'), COALESCE(MAX(id), 1)) FROM businesses;
      `);
    }
    
    // Check users
    const usersRes = await pool.query('SELECT * FROM users;');
    console.log('Usuarios actuales en la base de datos:', usersRes.rows.length);
    
    if (usersRes.rows.length === 0) {
      console.log('No hay usuarios. Creando usuario operador por defecto...');
      const passwordHash = await bcryptjs.hash('testpassword', 10);
      
      const insertQuery = `
        INSERT INTO users (business_id, email, password_hash, nombre, rol)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email;
      `;
      const newUser = await pool.query(insertQuery, [
        1,
        'operator@test.com',
        passwordHash,
        'Daniela Evelyn',
        'operator'
      ]);
      console.log('Usuario operador creado con éxito:', newUser.rows[0]);
      console.log('Email: operator@test.com');
      console.log('Password: testpassword');
    } else {
      console.log('Usuarios existentes en la DB:');
      console.dir(usersRes.rows, { depth: null });
    }
  } catch (err) {
    console.error('Error al sembrar la base de datos:', err);
  } finally {
    await pool.end();
  }
}

main();
