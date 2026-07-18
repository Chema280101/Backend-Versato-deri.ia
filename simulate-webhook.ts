import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const appSecret = process.env.APP_SECRET || 'mock_app_secret';
const customerNumber = '16315551181';

const getSignatureHeader = (body: string | object): string => {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return `sha256=${hmac}`;
};

async function sendSimulatedMessage(text: string) {
  const payload = {
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
                  profile: { name: 'Test Customer' },
                  wa_id: customerNumber,
                },
              ],
              messages: [
                {
                  from: customerNumber,
                  id: 'wamid.simulated_' + Date.now(),
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
            field: 'messages',
          },
        ],
      },
    ],
  };

  const bodyString = JSON.stringify(payload);
  const signature = getSignatureHeader(bodyString);

  console.log(`Sending message: "${text}"`);
  try {
    const res = await fetch('http://localhost:3000/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
      },
      body: bodyString,
    });
    console.log(`Response status: ${res.status} (${res.statusText})`);
  } catch (err) {
    console.error('Failed to send webhook message:', err);
  }
}

const textArg = process.argv.slice(2).join(' ');
if (!textArg) {
  console.error('Usage: npx tsx simulate-webhook.ts <message text>');
  process.exit(1);
}

sendSimulatedMessage(textArg);
