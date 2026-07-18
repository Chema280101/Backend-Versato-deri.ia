import { config } from '../config';

/**
 * Sends a text message to a WhatsApp number.
 * Returns the message ID (wamid) from Meta's response or null if it fails.
 */
export async function sendTextMessage(to: string, text: string): Promise<string | null> {
  const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: {
      preview_url: false,
      body: text,
    },
  };

  try {
    console.log(`[INFO]: Sending WhatsApp message to ${to}...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as {
      messages?: Array<{ id: string }>;
      error?: { message: string };
    };

    if (!response.ok) {
      console.error('[ERROR]: WhatsApp API error response:', data);
      const errorMsg =
        data.error?.message || `Failed to send WhatsApp message (status: ${response.status})`;
      if (config.isProduction) {
        throw new Error(errorMsg);
      } else {
        console.warn(
          `[WARNING]: WhatsApp API call failed in development. Continuing with mock message ID. Error: ${errorMsg}`,
        );
        return `wamid.dev_mock_outgoing_${Date.now()}`;
      }
    }

    const messageId = data?.messages?.[0]?.id;
    if (messageId) {
      console.log(`[INFO]: WhatsApp message sent successfully. ID: ${messageId}`);
      return messageId;
    }

    return null;
  } catch (error) {
    console.error('[ERROR]: Error calling WhatsApp Graph API:', error);
    throw error;
  }
}
