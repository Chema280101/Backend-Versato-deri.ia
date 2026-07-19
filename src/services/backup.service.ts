import fs from 'fs';
import path from 'path';
import { runBackup } from '../utils/backup';
import { config } from '../config';


let backupIntervalRef: NodeJS.Timeout | null = null;

/**
 * Checks if a backup file already exists for today's date.
 */
function isBackupDoneToday(backupsDir: string): boolean {
  try {
    if (!fs.existsSync(backupsDir)) {
      return false;
    }

    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const files = fs.readdirSync(backupsDir);
    
    // Check if any file starts with backup-YYYY-MM-DD_
    const todayBackupPrefix = `backup-${todayStr}_`;
    return files.some(file => file.startsWith(todayBackupPrefix) && file.endsWith('.sql'));
  } catch (error: any) {
    console.error(`[BACKUP][ERROR]: Failed to read backups directory for status check: ${error.message}`);
    return false;
  }
}

/**
 * Checks if a daily backup is due, and runs it if so.
 */
export async function checkAndRunDailyBackup(): Promise<void> {
  if (!config.backup.enabled) {
    return;
  }

  console.log('[BACKUP]: Running daily backup availability check...');
  const backupsDir = path.resolve(process.cwd(), config.backup.directory);

  if (isBackupDoneToday(backupsDir)) {
    console.log('[BACKUP]: Database backup for today already exists. Skipping.');
    return;
  }

  console.log('[BACKUP]: Today\'s backup not found. Initiating daily database backup...');
  try {
    const backupPath = await runBackup();
    console.log(`[BACKUP]: Daily backup completed and saved at: ${backupPath}`);
  } catch (error: any) {
    console.error('[BACKUP][ERROR]: Daily automatic backup failed:', error);
  }
}

/**
 * Starts the daily database backup scheduler.
 * Runs once immediately and then schedules checks periodically.
 */
export function startBackupScheduler(checkIntervalMs: number = 3600000): void {
  if (!config.backup.enabled) {
    console.log('[BACKUP]: Automatic database backup service is disabled.');
    return;
  }


  if (backupIntervalRef) {
    console.warn('[BACKUP]: Backup scheduler is already running.');
    return;
  }

  console.log(`[BACKUP]: Starting automatic database backup scheduler. Check interval: ${checkIntervalMs / 1000}s.`);
  
  // Run once immediately on startup
  checkAndRunDailyBackup().catch((error) => {
    console.error('[BACKUP][ERROR]: Initial startup backup check failed:', error);
  });

  // Check hourly
  backupIntervalRef = setInterval(() => {
    checkAndRunDailyBackup().catch((error) => {
      console.error('[BACKUP][ERROR]: Periodic backup check failed:', error);
    });
  }, checkIntervalMs);
}

/**
 * Stops the daily backup scheduler.
 */
export function stopBackupScheduler(): void {
  if (backupIntervalRef) {
    clearInterval(backupIntervalRef);
    backupIntervalRef = null;
    console.log('[BACKUP]: Automatic database backup scheduler stopped.');
  }
}
