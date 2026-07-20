import dotenv from 'dotenv';

// Load .env in local dev — in production (Render) env vars come from the platform
dotenv.config();


export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.PHONE_NUMBER_ID || '',
    verifyToken: process.env.VERIFY_TOKEN || '',
    appSecret: process.env.APP_SECRET || '',
  },
  database: {
    url: process.env.DATABASE_URL || '',
  },
  jwtSecret: process.env.JWT_SECRET || 'fallback_secret_key',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  isProduction: process.env.NODE_ENV === 'production',
  alertCheckIntervalMs: parseInt(process.env.ALERT_CHECK_INTERVAL_MS || '300000', 10),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  backup: {
    enabled: process.env.BACKUP_ENABLED === 'true',
    directory: process.env.BACKUP_DIRECTORY || 'backups',
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '7', 10),
  },
};


// Simple validation to ensure key configuration exists
const requiredVars = [
  'WHATSAPP_TOKEN',
  'PHONE_NUMBER_ID',
  'VERIFY_TOKEN',
  'APP_SECRET',
  'DATABASE_URL',
  'JWT_SECRET',
  'GEMINI_API_KEY',
];

requiredVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.warn(`[WARNING]: Environment variable ${varName} is not defined in the environment.`);
  }
});
