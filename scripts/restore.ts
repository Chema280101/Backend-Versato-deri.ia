import { execSync } from 'child_process';
import fs from 'fs';
import { Client } from 'pg';
import { parseConnectionString } from '../src/utils/backup';
import dotenv from 'dotenv';


// Load environment variables
dotenv.config();

/**
 * Finds the absolute path to psql.exe on Windows or returns 'psql' for path lookup.
 */
function getPsqlPath(): string {
  if (process.env.PSQL_PATH) {
    return process.env.PSQL_PATH;
  }

  if (process.platform === 'win32') {
    const commonPaths = [
      'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\psql.exe',
      'C:\\Program Files\\PostgreSQL\\15\\bin\\psql.exe',
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return `"${p}"`;
      }
    }
  }

  return 'psql';
}

/**
 * Drops and recreates the target database to ensure a clean slate.
 */
async function recreateDatabase(host: string, port: string, user: string, password: string, dbName: string, sslmode: string) {
  const sslConfig = sslmode === 'require' ? { rejectUnauthorized: false } : undefined;
  
  // Connect to the default 'postgres' database to perform the creation
  const client = new Client({
    host,
    port: parseInt(port, 10),
    user,
    password,
    database: 'postgres',
    ssl: sslConfig,
  });

  try {
    console.log(`[RESTORE]: Connecting to 'postgres' database on ${host}:${port} to recreate target database '${dbName}'...`);
    await client.connect();

    // Terminate active connections to the target database to allow dropping it
    await client.query(`
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid();
    `, [dbName]);

    await client.query(`DROP DATABASE IF EXISTS ${dbName};`);
    console.log(`[RESTORE]: Dropped database '${dbName}' if it existed.`);

    await client.query(`CREATE DATABASE ${dbName};`);
    console.log(`[RESTORE]: Created database '${dbName}'.`);
  } catch (error: any) {
    throw new Error(`Failed to recreate database '${dbName}': ${error.message}`);
  } finally {
    await client.end();
  }
}

export async function runRestore(backupFilePath: string, targetDbUrl: string, recreate: boolean = false): Promise<void> {
  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`Backup file not found at path: ${backupFilePath}`);
  }

  const { host, port, user, password, database, sslmode } = parseConnectionString(targetDbUrl);

  if (recreate) {
    await recreateDatabase(host, port, user, password, database, sslmode);
  }

  const psqlBin = getPsqlPath();
  console.log(`[RESTORE]: Restoring backup ${backupFilePath} into database '${database}' on host '${host}'...`);
  console.log(`[RESTORE]: Using restore tool path: ${psqlBin}`);

  // Construct command arguments
  // -f executes queries from file
  // -q runs quietly (saves output noise)
  const cmd = `${psqlBin} -h ${host} -p ${port} -U ${user} -d ${database} -q -f "${backupFilePath}"`;

  // Execute psql, passing credentials securely
  execSync(cmd, {
    env: {
      ...process.env,
      PGPASSWORD: password,
      PGSSLMODE: sslmode
    },
    stdio: 'inherit'
  });

  console.log(`[RESTORE]: Database restoration completed successfully.`);
}

// Execute restore if run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const backupFile = args[0];
  const targetUrl = args[1] || process.env.DATABASE_URL;
  const recreate = args.includes('--recreate');

  if (!backupFile || !targetUrl) {
    console.log('Usage: npx tsx scripts/restore.ts <backup_file_path> [target_database_url] [--recreate]');
    process.exit(1);
  }

  runRestore(backupFile, targetUrl, recreate).catch((error) => {
    console.error('[RESTORE][ERROR]: Restoration process failed:', error);
    process.exit(1);
  });
}
