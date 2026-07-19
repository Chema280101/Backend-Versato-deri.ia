import https from 'https';
import { config } from '../config';

export type AlertLevel = 'info' | 'warn' | 'error' | 'fatal';

// Color codes for Discord embeds
const DISCORD_COLORS = {
  fatal: 16711680, // Red
  error: 16733440, // Orange
  warn: 16763904,  // Yellow
  info: 34981,     // Blue
};

/**
 * Sends a real-time notification alert to the configured Discord/Slack webhook.
 * Falls back to console output if no webhook is configured.
 */
export async function sendAlert(
  title: string,
  message: string,
  level: AlertLevel = 'error'
): Promise<boolean> {
  const webhookUrl = config.alertWebhookUrl;

  // Local print format
  const timestamp = new Date().toISOString();
  const consolePrefix = `[ALERT][${level.toUpperCase()}][${timestamp}]`;
  
  if (!webhookUrl) {
    if (level === 'fatal' || level === 'error') {
      console.error(`${consolePrefix} ${title}: ${message}`);
    } else if (level === 'warn') {
      console.warn(`${consolePrefix} ${title}: ${message}`);
    } else {
      console.log(`${consolePrefix} ${title}: ${message}`);
    }
    return false;
  }

  // Determine platform type
  const isDiscord = webhookUrl.includes('discord.com');
  const isSlack = webhookUrl.includes('slack.com') || webhookUrl.includes('hooks.slack.com');

  let payload: any = {};

  if (isDiscord) {
    payload = {
      embeds: [
        {
          title: `🔔 ${title}`,
          description: message,
          color: DISCORD_COLORS[level] || DISCORD_COLORS.error,
          timestamp: timestamp,
          footer: {
            text: 'Versato Bot Monitor',
          },
        },
      ],
    };
  } else if (isSlack) {
    const emojiMap = {
      fatal: '🚨',
      error: '❌',
      warn: '⚠️',
      info: 'ℹ️',
    };
    const emoji = emojiMap[level] || '❌';
    payload = {
      text: `${emoji} *${title}*\n${message}\n_Level: ${level.toUpperCase()}_`,
    };
  } else {
    // Generic webhook fallback
    payload = {
      title,
      message,
      level,
      timestamp,
    };
  }

  return new Promise((resolve) => {
    try {
      const dataStr = JSON.stringify(payload);
      const urlObj = new URL(webhookUrl);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataStr),
        },
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            console.error(`[ERROR]: Alert webhook returned status code ${res.statusCode}: ${responseData}`);
            resolve(false);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[ERROR]: Failed to send alert webhook request:', err);
        resolve(false);
      });

      req.write(dataStr);
      req.end();
    } catch (err) {
      console.error('[ERROR]: Error parsing or invoking alert webhook:', err);
      resolve(false);
    }
  });
}
