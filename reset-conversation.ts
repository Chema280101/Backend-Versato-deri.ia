import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const sslConfig = process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

async function main() {
  try {
    console.log('Resetting conversation 1 status to activa_ia and state to saludo...');
    await pool.query("UPDATE conversations SET status = 'activa_ia', sales_state = 'saludo', consecutive_attempts = 0 WHERE id = 1;");
    console.log('Conversation reset successfully.');
  } catch (err) {
    console.error('Error resetting conversation:', err);
  } finally {
    await pool.end();
  }
}

main();
