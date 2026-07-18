import request from 'supertest';
import crypto from 'crypto';
import app from '../app';
import { config } from '../config';
import * as dbService from '../services/db.service';
import * as whatsappService from '../services/whatsapp.service';

// Mock the services to run tests without database or API connectivity
jest.mock('../services/db.service', () => ({
  findOrCreateConversation: jest.fn(),
  saveMessage: jest.fn(),
  initializeDatabase: jest.fn(),
  getBusinessByPhoneNumberId: jest.fn(),
}));

jest.mock('../services/whatsapp.service', () => ({
  sendTextMessage: jest.fn(),
}));

jest.mock('../services/conversational-engine.service', () => {
  return {
    ConversationalEngine: jest.fn().mockImplementation(() => {
      return {
        processIncomingMessage: jest.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

import { conversationalEngine } from '../routes/webhook.routes';

const mockFindOrCreateConversation = dbService.findOrCreateConversation as jest.Mock;
const mockSaveMessage = dbService.saveMessage as jest.Mock;
const mockSendTextMessage = whatsappService.sendTextMessage as jest.Mock;

describe('GET /webhook', () => {
  let originalVerifyToken: string;

  beforeAll(() => {
    originalVerifyToken = config.whatsapp.verifyToken;
  });

  afterAll(() => {
    config.whatsapp.verifyToken = originalVerifyToken;
  });

  it('should return 200 OK and challenge when token and mode are correct', async () => {
    config.whatsapp.verifyToken = 'test_secret_token';
    const challenge = 'test_challenge_12345';

    const response = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test_secret_token',
      'hub.challenge': challenge,
    });

    expect(response.status).toBe(200);
    expect(response.text).toBe(challenge);
  });

  it('should return 403 Forbidden when token is incorrect', async () => {
    config.whatsapp.verifyToken = 'test_secret_token';

    const response = await request(app).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong_token',
      'hub.challenge': 'some_challenge',
    });

    expect(response.status).toBe(403);
  });

  it('should return 403 Forbidden when mode is not subscribe', async () => {
    config.whatsapp.verifyToken = 'test_secret_token';

    const response = await request(app).get('/webhook').query({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'test_secret_token',
      'hub.challenge': 'some_challenge',
    });

    expect(response.status).toBe(403);
  });
});

describe('POST /webhook', () => {
  let originalAppSecret: string;
  const testAppSecret = 'test_app_secret';

  beforeAll(() => {
    originalAppSecret = config.whatsapp.appSecret;
    config.whatsapp.appSecret = testAppSecret;
  });

  afterAll(() => {
    config.whatsapp.appSecret = originalAppSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const getSignatureHeader = (body: string | object): string => {
    const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = crypto.createHmac('sha256', testAppSecret).update(rawBody).digest('hex');
    return `sha256=${hmac}`;
  };

  it('should respond 200 OK immediately and process incoming message asynchronously', async () => {
    // Setup mock returns
    mockFindOrCreateConversation.mockResolvedValue(42); // Mock conversation ID
    mockSaveMessage.mockResolvedValue(100); // Mock message primary key ID
    mockSendTextMessage.mockResolvedValue('wamid.MockOutgoingMsgId123456');

    // Real payload format from Meta Developer documentation
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                contacts: [
                  {
                    profile: {
                      name: 'Sheena Nelson',
                    },
                    wa_id: '16505551234',
                  },
                ],
                messages: [
                  {
                    from: '16505551234',
                    id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
                    timestamp: '1749416383',
                    type: 'text',
                    text: {
                      body: 'Does it come in another color?',
                    },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const signature = getSignatureHeader(metaPayload);

    const response = await request(app)
      .post('/webhook')
      .set('X-Hub-Signature-256', signature)
      .send(metaPayload);

    // Verify immediate response
    expect(response.status).toBe(200);
    expect(response.text).toBe('EVENT_RECEIVED');

    // Wait a brief moment for async handlers to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify DB operations
    expect(mockFindOrCreateConversation).toHaveBeenCalledWith('16505551234', 1);

    // Save incoming message ('user')
    expect(mockSaveMessage).toHaveBeenNthCalledWith(
      1,
      42,
      'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
      'user',
      'Does it come in another color?',
    );

    // Process message through conversational engine
    expect(conversationalEngine.processIncomingMessage).toHaveBeenCalledWith(
      42,
      '16505551234',
      'Does it come in another color?',
    );
  });

  it('should respond 200 OK and skip processing if the payload does not contain messages (e.g. status updates)', async () => {
    // Real payload format for a status update from Meta Developer documentation
    const metaStatusPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                statuses: [
                  {
                    id: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
                    status: 'delivered',
                    timestamp: '1749416385',
                    recipient_id: '16505551234',
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const signature = getSignatureHeader(metaStatusPayload);

    const response = await request(app)
      .post('/webhook')
      .set('X-Hub-Signature-256', signature)
      .send(metaStatusPayload);

    expect(response.status).toBe(200);
    expect(response.text).toBe('EVENT_RECEIVED');

    // Wait a brief moment to make sure async handlers aren't called
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFindOrCreateConversation).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSendTextMessage).not.toHaveBeenCalled();
  });

  it('should reject requests with a missing X-Hub-Signature-256 header with 401', async () => {
    const metaPayload = { object: 'whatsapp_business_account', entry: [] };

    const response = await request(app).post('/webhook').send(metaPayload);

    expect(response.status).toBe(401);
  });

  it('should reject requests with an invalid X-Hub-Signature-256 signature with 401', async () => {
    const metaPayload = { object: 'whatsapp_business_account', entry: [] };

    const response = await request(app)
      .post('/webhook')
      .set('X-Hub-Signature-256', 'sha256=invalidsignaturehere')
      .send(metaPayload);

    expect(response.status).toBe(401);
  });

  it('should verify signature against raw body when formatted with extra whitespace', async () => {
    const rawBodyString =
      '{\n  "object": "whatsapp_business_account",\n  "entry": [\n    {\n      "id": "102290129340398",\n      "changes": []\n    }\n  ]\n}';
    const signature = getSignatureHeader(rawBodyString);

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(rawBodyString);

    expect(response.status).toBe(200);
    expect(response.text).toBe('EVENT_RECEIVED');
  });

  it('should reject request if the signature is calculated on minified JSON but the raw body has custom formatting', async () => {
    const rawBodyString =
      '{\n  "object": "whatsapp_business_account",\n  "entry": [\n    {\n      "id": "102290129340398",\n      "changes": []\n    }\n  ]\n}';

    // Parse it and re-stringify minified, then sign the minified version
    const minifiedBody = JSON.stringify(JSON.parse(rawBodyString));
    const minifiedSignature = getSignatureHeader(minifiedBody);

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', minifiedSignature)
      .send(rawBodyString);

    // Should fail because the server validates against the formatted rawBody,
    // which has a different HMAC than the minified JSON
    expect(response.status).toBe(401);
  });
});
