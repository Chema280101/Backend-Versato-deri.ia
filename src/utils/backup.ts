import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Parses a PostgreSQL connection string into individual connection parameters.
 */
export function parseConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      sslmode: url.searchParams.get('sslmode') || 'require',
    };
  } catch (error: any) {
    throw new Error(`Failed to parse DATABASE_URL: ${error.message}`);
  }
}

/**
 * Finds the absolute path to pg_dump.exe on Windows or returns 'pg_dump' for path lookup.
 */
function getPgDumpPath(): string {
  if (process.env.PG_DUMP_PATH) {
    return process.env.PG_DUMP_PATH;
  }

  if (process.platform === 'win32') {
    // Check PostgreSQL 18 first, then fall back to other common versions
    const commonPaths = [
      'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe',
      'C:\\Program Files\\PostgreSQL\\15\\bin\\pg_dump.exe',
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return `"${p}"`;
      }
    }
  }

  return 'pg_dump';
}

/**
 * Performs database rotation keeping only the last N backup files.
 */
function rotateBackups(backupsDir: string, retentionDays: number) {
  try {
    const files = fs.readdirSync(backupsDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.sql'))
      .map(f => ({
        name: f,
        path: path.join(backupsDir, f),
        stat: fs.statSync(path.join(backupsDir, f))
      }))
      .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime()); // Newer first

    console.log(`[BACKUP]: Found ${files.length} existing backup(s).`);
    if (files.length > retentionDays) {
      const toDelete = files.slice(retentionDays);
      console.log(`[BACKUP]: Retention is configured to ${retentionDays} days. Deleting ${toDelete.length} old backup(s)...`);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
        console.log(`[BACKUP]: Deleted old backup: ${file.name}`);
      }
    }
  } catch (error: any) {
    console.warn(`[BACKUP][WARNING]: Failed to rotate backups: ${error.message}`);
  }
}

export async function runBackup(): Promise<string> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL is not set in environment.');
  }

  const { host, port, user, password, database, sslmode } = parseConnectionString(dbUrl);
  
  // Configure backups directory
  const backupsDirName = process.env.BACKUP_DIRECTORY || 'backups';
  const backupsDir = path.resolve(process.cwd(), backupsDirName);
  
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    console.log(`[BACKUP]: Created backup directory at ${backupsDir}`);
  }

  // Format filename with timestamp
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/T/, '_')
    .replace(/\..+/, '')
    .replace(/:/g, '-');
  
  const backupFileName = `backup-${timestamp}.sql`;
  const backupFilePath = path.join(backupsDir, backupFileName);

  const pgDumpBin = getPgDumpPath();
  console.log(`[BACKUP]: Starting database dump for database '${database}' on host '${host}'...`);
  console.log(`[BACKUP]: Using backup tool path: ${pgDumpBin}`);

  // Construct command arguments
  const cmd = `${pgDumpBin} -h ${host} -p ${port} -U ${user} --clean --if-exists --no-owner --no-privileges -f "${backupFilePath}" ${database}`;

  // Execute pg_dump, passing the password and sslmode securely via environment variables
  execSync(cmd, {
    env: {
      ...process.env,
      PGPASSWORD: password,
      PGSSLMODE: sslmode
    },
    stdio: 'inherit'
  });

  console.log(`[BACKUP]: Database backup completed successfully.`);
  console.log(`[BACKUP]: Saved to: ${backupFilePath}`);

  // Run backup rotation
  const retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10);
  rotateBackups(backupsDir, retentionDays);

  return backupFilePath;
}
