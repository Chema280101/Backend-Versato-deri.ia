import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { findOrCreateConversation, saveMessage, getBusinessByPhoneNumberId } from '../services/db.service';
import { GeminiLLMProvider } from '../services/llm/gemini-llm.provider';
import { ConversationalEngine } from '../services/conversational-engine.service';
import { rateLimitMiddleware } from '../middlewares/rate-limit.middleware';
import { sanitizeInput } from '../utils/sanitization';
import { sendAlert } from '../utils/notifier';

const router = Router();
const geminiProvider = new GeminiLLMProvider();
export const conversationalEngine = new ConversationalEngine(geminiProvider);

// Webhook monitoring state and helper methods for test validation
export let consecutiveWebhookFailures = 0;
export const FAILURE_ALERT_THRESHOLD = 5;

export const resetConsecutiveWebhookFailures = (): void => {
  consecutiveWebhookFailures = 0;
};

export const setConsecutiveWebhookFailures = (val: number): void => {
  consecutiveWebhookFailures = val;
};

/**
 * Middleware to verify Meta X-Hub-Signature-256 header.
 */
const verifySignature = (req: Request, res: Response, next: NextFunction): void => {
  const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;

  if (!signatureHeader) {
    console.warn('[WARNING]: Missing X-Hub-Signature-256 header.');
    res.sendStatus(401);
    return;
  }

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    console.warn('[WARNING]: Invalid X-Hub-Signature-256 header format.');
    res.sendStatus(401);
    return;
  }

  const signature = parts[1];
  const rawBody = req.rawBody;

  if (!rawBody) {
    console.warn('[WARNING]: Raw body is missing for verification.');
    res.sendStatus(401);
    return;
  }

  const appSecret = config.whatsapp.appSecret;
  if (!appSecret) {
    console.error('[CRITICAL]: APP_SECRET is not configured in the environment.');
    res.sendStatus(500);
    return;
  }

  const expectedSignature = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  const signatureBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    console.warn('[WARNING]: Signature verification failed. HMAC mismatch.');
    res.sendStatus(401);
    return;
  }

  next();
};

/**
 * GET /webhook
 * WhatsApp webhook verification endpoint.
 * Meta verification requests send hub.mode, hub.verify_token, and hub.challenge as query params.
 */
router.get(
  '/webhook',
  rateLimitMiddleware({
    windowMs: 60 * 1000,
    max: 200,
    message: 'Demasiadas peticiones al webhook. Por favor intente más tarde.',
  }),
  (req: Request, res: Response): void => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
      console.log('[INFO]: Webhook verified successfully.');
      res.status(200).send(challenge);
      return;
    }

    console.warn('[WARNING]: Webhook verification failed. Token mismatch or invalid mode.');
    res.sendStatus(403);
  },
);

/**
 * POST /webhook
 * Receives incoming WhatsApp webhook notifications from Meta.
 */
router.post(
  '/webhook',
  rateLimitMiddleware({
    windowMs: 60 * 1000,
    max: 200,
    message: 'Demasiadas peticiones al webhook. Por favor intente más tarde.',
  }),
  verifySignature,
  (req: Request, res: Response): void => {
    try {
      console.log('[INFO]: Received WhatsApp webhook payload:', JSON.stringify(req.body, null, 2));

      // Meta expects a rapid 200 OK response to prevent retries.
      res.status(200).send('EVENT_RECEIVED');

      // Verify structure of the payload
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      // If there are no messages (e.g. status updates or list changes), skip processing
      if (!message) {
        console.log('[INFO]: Webhook event does not contain a message. Skipping processing.');
        return;
      }

      // Asynchronously process the message
      (async () => {
        try {
          const senderNumber = message.from;
          const messageId = message.id;
          const messageText = message.text?.body ? sanitizeInput(message.text.body) : undefined;

          if (!senderNumber || !messageId) {
            console.warn('[WARNING]: Missing essential message fields (from, id). Skipping.');
            return;
          }

          const bodyText = messageText || `[Received non-text message of type: ${message.type}]`;

          console.log(`[INFO]: Processing incoming message from ${senderNumber}: "${bodyText}"`);

          // Resolve the business ID dynamically using the phone_number_id from metadata
          let businessId = 1;
          const phoneNumberId = value?.metadata?.phone_number_id;
          if (phoneNumberId) {
            const business = await getBusinessByPhoneNumberId(phoneNumberId);
            if (business) {
              businessId = business.id;
            }
          }

          // 1. Get or create the conversation record
          const conversationId = await findOrCreateConversation(senderNumber, businessId);

          // 2. Save incoming message to Postgres
          await saveMessage(conversationId, messageId, 'user', bodyText);

          // 3. Process the message through the conversational engine if it is text
          if (messageText) {
            const startTime = Date.now();
            await conversationalEngine.processIncomingMessage(
              conversationId,
              senderNumber,
              messageText,
            );
            const durationSeconds = (Date.now() - startTime) / 1000;
            console.log(`[INFO]: Conversational engine took ${durationSeconds.toFixed(2)}s for conversation ${conversationId}`);

            if (durationSeconds > 10) {
              sendAlert(
                'Bot Response Latency Alert',
                `El tiempo de respuesta del bot superó los 10 segundos.\n` +
                `• Duración: **${durationSeconds.toFixed(2)}s**\n` +
                `• Conversación ID: **${conversationId}**\n` +
                `• Cliente: **${senderNumber}**\n` +
                `• Mensaje: "${messageText}"`,
                'warn'
              ).catch((err) => console.error('[ERROR]: Failed to send latency alert:', err));
            }
          } else {
            console.log('[INFO]: Message was not text. Did not process with Conversational Engine.');
          }

          // Reset consecutive failure count on successful execution
          consecutiveWebhookFailures = 0;
        } catch (error) {
          consecutiveWebhookFailures++;
          console.error('[ERROR]: Error during async webhook message processing:', error);

          const errorMsg = error instanceof Error ? error.message : String(error);
          const errorStack = error instanceof Error && error.stack ? error.stack : '';

          if (consecutiveWebhookFailures === FAILURE_ALERT_THRESHOLD) {
            sendAlert(
              'CRITICAL: WhatsApp Webhook Failing Consistently',
              `El webhook de WhatsApp ha fallado **${FAILURE_ALERT_THRESHOLD}** veces consecutivas.\n` +
              `Último error en procesamiento asíncrono:\n\`\`\`\n${errorMsg}\n${errorStack.substring(0, 500)}\n\`\`\``,
              'fatal'
            ).catch((err) => console.error('[ERROR]: Failed to send critical alert:', err));
          }
        }
      })();
    } catch (error) {
      consecutiveWebhookFailures++;
      console.error('[ERROR]: Error in webhook route wrapper:', error);

      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error && error.stack ? error.stack : '';

      if (consecutiveWebhookFailures === FAILURE_ALERT_THRESHOLD) {
        sendAlert(
          'CRITICAL: WhatsApp Webhook Failing Consistently',
          `El webhook de WhatsApp ha fallado **${FAILURE_ALERT_THRESHOLD}** veces consecutivas.\n` +
          `Último error en wrapper de ruta:\n\`\`\`\n${errorMsg}\n${errorStack.substring(0, 500)}\n\`\`\``,
          'fatal'
        ).catch((err) => console.error('[ERROR]: Failed to send critical alert:', err));
      }
    }
  }
);

export default router;
