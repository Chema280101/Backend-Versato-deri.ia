import { runBackup } from '../src/utils/backup';

// Execute backup
runBackup().catch((error) => {
  console.error('[BACKUP][ERROR]: Backup process failed:', error);
  process.exit(1);
});
