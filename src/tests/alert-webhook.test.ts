import request from 'supertest';
import crypto from 'crypto';
import app from '../app';
import { config } from '../config';
import * as dbService from '../services/db.service';
import * as notifier from '../utils/notifier';
import {
  conversationalEngine,
  consecutiveWebhookFailures,
  setConsecutiveWebhookFailures,
  resetConsecutiveWebhookFailures,
  FAILURE_ALERT_THRESHOLD,
} from '../routes/webhook.routes';

// Mock DB service and notifier utility
jest.mock('../services/db.service', () => ({
  findOrCreateConversation: jest.fn(),
  saveMessage: jest.fn(),
  getBusinessByPhoneNumberId: jest.fn(),
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../utils/notifier', () => ({
  sendAlert: jest.fn().mockResolvedValue(true),
}));

describe('Webhook and Latency Alerts Integration Tests', () => {
  const originalAppSecret = config.whatsapp.appSecret;
  const originalVerifyToken = config.whatsapp.verifyToken;
  const testSecret = 'test_webhook_secret';
  let sendAlertSpy: jest.SpyInstance;
  let dateNowSpy: jest.SpyInstance;

  beforeAll(() => {
    config.whatsapp.appSecret = testSecret;
    config.whatsapp.verifyToken = 'test_verify_token';
  });

  afterAll(() => {
    config.whatsapp.appSecret = originalAppSecret;
    config.whatsapp.verifyToken = originalVerifyToken;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetConsecutiveWebhookFailures();
    sendAlertSpy = jest.spyOn(notifier, 'sendAlert').mockResolvedValue(true);
    dateNowSpy = jest.spyOn(Date, 'now');
  });

  afterEach(() => {
    if (sendAlertSpy) sendAlertSpy.mockRestore();
    if (dateNowSpy) dateNowSpy.mockRestore();
  });

  function getSignedRequest(payload: any) {
    const rawBody = JSON.stringify(payload);
    const signature = crypto
      .createHmac('sha256', testSecret)
      .update(rawBody)
      .digest('hex');

    return request(app)
      .post('/webhook')
      .set('x-hub-signature-256', `sha256=${signature}`)
      .set('Content-Type', 'application/json')
      .send(rawBody);
  }

  describe('Webhook Signature and Base Flow', () => {
    it('should fail with 401 when signature header is missing', async () => {
      const response = await request(app)
        .post('/webhook')
        .send({ entry: [] });

      expect(response.status).toBe(401);
      // Signature checks should not count towards backend runtime crashes/failures
      expect(consecutiveWebhookFailures).toBe(0);
    });

    it('should pass signature verification with a correct HMAC', async () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '51999999999',
                      id: 'wamid.test_msg_id',
                      text: { body: 'Hola bot' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      (dbService.getBusinessByPhoneNumberId as jest.Mock).mockResolvedValue({ id: 1 });
      (dbService.findOrCreateConversation as jest.Mock).mockResolvedValue(100);
      (dbService.saveMessage as jest.Mock).mockResolvedValue(200);
      
      const processSpy = jest
        .spyOn(conversationalEngine, 'processIncomingMessage')
        .mockResolvedValue(undefined);

      const response = await getSignedRequest(payload);

      expect(response.status).toBe(200);
      expect(response.text).toBe('EVENT_RECEIVED');
      
      // Allow async code to resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(processSpy).toHaveBeenCalledWith(100, '51999999999', 'Hola bot');
      expect(consecutiveWebhookFailures).toBe(0);
      expect(sendAlertSpy).not.toHaveBeenCalled();
      
      processSpy.mockRestore();
    });
  });

  describe('Consecutive Webhook Failures Tracking', () => {
    it('should increment failures and trigger a fatal alert on the 5th consecutive failure', async () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '51999999999',
                      id: 'wamid.error_trigger',
                      text: { body: 'Throw error' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      // Mock DB call to fail/throw
      (dbService.findOrCreateConversation as jest.Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      // Execute webhook 4 times
      for (let i = 0; i < 4; i++) {
        await getSignedRequest(payload);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(consecutiveWebhookFailures).toBe(4);
      expect(sendAlertSpy).not.toHaveBeenCalled();

      // 5th failure
      await getSignedRequest(payload);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consecutiveWebhookFailures).toBe(5);
      expect(sendAlertSpy).toHaveBeenCalledTimes(1);
      expect(sendAlertSpy).toHaveBeenCalledWith(
        'CRITICAL: WhatsApp Webhook Failing Consistently',
        expect.stringContaining('ha fallado **5** veces consecutivas'),
        'fatal'
      );
    });

    it('should reset consecutive failures to 0 when a webhook succeeds', async () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '51999999999',
                      id: 'wamid.reset_trigger',
                      text: { body: 'Success' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      setConsecutiveWebhookFailures(3);

      (dbService.findOrCreateConversation as jest.Mock).mockResolvedValue(100);
      (dbService.saveMessage as jest.Mock).mockResolvedValue(200);
      const processSpy = jest
        .spyOn(conversationalEngine, 'processIncomingMessage')
        .mockResolvedValue(undefined);

      await getSignedRequest(payload);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(consecutiveWebhookFailures).toBe(0);
      expect(sendAlertSpy).not.toHaveBeenCalled();
      
      processSpy.mockRestore();
    });
  });

  describe('Bot Response Latency Warning Threshold', () => {
    it('should trigger a latency alert when bot response takes more than 10 seconds', async () => {
      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '51999999999',
                      id: 'wamid.latency_trigger',
                      text: { body: 'Slow response' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      (dbService.findOrCreateConversation as jest.Mock).mockResolvedValue(100);
      (dbService.saveMessage as jest.Mock).mockResolvedValue(200);
      
      const processSpy = jest
        .spyOn(conversationalEngine, 'processIncomingMessage')
        .mockResolvedValue(undefined);

      // Mock Date.now to travel 12 seconds in time between starting and completing processIncomingMessage
      let dateNowCalls = 0;
      dateNowSpy.mockImplementation(() => {
        dateNowCalls++;
        if (dateNowCalls === 2) {
          // 12 seconds later (12000 milliseconds)
          return 13000;
        }
        return 1000;
      });

      await getSignedRequest(payload);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(sendAlertSpy).toHaveBeenCalledTimes(1);
      expect(sendAlertSpy).toHaveBeenCalledWith(
        'Bot Response Latency Alert',
        expect.stringContaining('El tiempo de respuesta del bot superó los 10 segundos'),
        'warn'
      );

      processSpy.mockRestore();
    });
  });

  describe('POST /health/report-error (Frontend Error Forwarding)', () => {
    it('should reject with 400 when message is missing', async () => {
      const response = await request(app)
        .post('/health/report-error')
        .send({ stack: 'Some stack trace' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('El campo "message" es obligatorio.');
    });

    it('should accept the error report and forward to notifier webhook', async () => {
      const payload = {
        message: 'Uncaught TypeError: Cannot read property of undefined',
        stack: 'at App.tsx:10:20\nat main.tsx:5:10',
        url: 'http://localhost:5173/dashboard',
      };

      const response = await request(app)
        .post('/health/report-error')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('error_logged');
      
      expect(sendAlertSpy).toHaveBeenCalledTimes(1);
      expect(sendAlertSpy).toHaveBeenCalledWith(
        'Frontend Runtime Error Logged',
        expect.stringContaining('Uncaught TypeError: Cannot read property of undefined'),
        'error'
      );
    });
  });
});
