import { Pool } from 'pg';
import bcryptjs from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const sslConfig = process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : undefined;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
});

function printUsage() {
  console.log('\n========================================================================');
  console.log('Versato CLI - Creación Manual de Clientes');
  console.log('========================================================================');
  console.log('Uso:');
  console.log('  npx ts-node create-client.ts --name="[Negocio]" --phone="[Phone ID]" --email="[Email]" --password="[Clave]" --adminName="[Nombre Admin]"');
  console.log('\nEjemplo:');
  console.log('  npx ts-node create-client.ts --name="Boutique Larco" --phone="106540352242999" --email="admin@boutiquelarco.com" --password="SuperClave987" --adminName="Maria Fernandez"');
  console.log('========================================================================\n');
}

async function main() {
  const args = process.argv.slice(2);
  
  const getArg = (flag: string): string | null => {
    const prefix = `--${flag}=`;
    const arg = args.find(a => a.startsWith(prefix));
    return arg ? arg.substring(prefix.length).replace(/^['"]|['"]$/g, '') : null;
  };

  const businessName = getArg('name');
  const phoneNumberId = getArg('phone');
  const email = getArg('email');
  const password = getArg('password');
  const adminName = getArg('adminName');

  if (!businessName || !phoneNumberId || !email || !password || !adminName) {
    console.error('\x1b[31m[ERROR]: Todos los campos son obligatorios.\x1b[0m');
    printUsage();
    process.exit(1);
  }

  const isPasswordComplex = (pwd: string): boolean => {
    if (pwd.length < 8) return false;
    const hasUppercase = /[A-Z]/.test(pwd);
    const hasLowercase = /[a-z]/.test(pwd);
    const hasDigit = /[0-9]/.test(pwd);
    const hasSpecial = /[^A-Za-z0-9]/.test(pwd);
    return hasUppercase && hasLowercase && hasDigit && hasSpecial;
  };

  if (!isPasswordComplex(password)) {
    console.error('\x1b[31m[ERROR]: La contraseña no cumple con los requisitos mínimos de complejidad:\x1b[0m');
    console.error('- Mínimo 8 caracteres');
    console.error('- Al menos una letra mayúscula');
    console.error('- Al menos una letra minúscula');
    console.error('- Al menos un número');
    console.error('- Al menos un carácter especial (ej. @, $, !, %, *, ?, &, #, ., etc.)');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Validar duplicado de email
    const emailCheck = await client.query('SELECT id FROM users WHERE email = $1;', [email]);
    if (emailCheck.rows.length > 0) {
      throw new Error(`El correo electrónico "${email}" ya está registrado.`);
    }

    // 2. Validar duplicado de phone_number_id
    const phoneCheck = await client.query('SELECT id FROM businesses WHERE phone_number_id = $1;', [phoneNumberId]);
    if (phoneCheck.rows.length > 0) {
      throw new Error(`El WhatsApp Phone Number ID "${phoneNumberId}" ya está registrado en otro negocio.`);
    }

    console.log(`[INFO]: Creando negocio: "${businessName}" con Phone ID: ${phoneNumberId}...`);
    const bizRes = await client.query(
      'INSERT INTO businesses (name, phone_number_id) VALUES ($1, $2) RETURNING id;',
      [businessName, phoneNumberId]
    );
    const businessId = bizRes.rows[0].id;

    console.log(`[INFO]: Hasheando contraseña para el administrador...`);
    const passwordHash = await bcryptjs.hash(password, 10);

    console.log(`[INFO]: Creando usuario administrador: "${adminName}" (${email})...`);
    await client.query(
      'INSERT INTO users (business_id, email, password_hash, nombre, rol) VALUES ($1, $2, $3, $4, $5);',
      [businessId, email, passwordHash, adminName, 'admin']
    );

    await client.query('COMMIT');
    console.log('\n\x1b[32m========================================================================');
    console.log('¡CLIENTE CREADO CON ÉXITO!');
    console.log('========================================================================');
    console.log(` Negocio:    ${businessName} (ID: ${businessId})`);
    console.log(` Phone ID:   ${phoneNumberId}`);
    console.log(` Admin Name: ${adminName}`);
    console.log(` Email:      ${email}`);
    console.log(` Password:   ${password}`);
    console.log('========================================================================\x1b[0m\n');
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('\n\x1b[31m[ERROR EN LA CREACIÓN DEL CLIENTE]:', error.message || error, '\x1b[0m\n');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
