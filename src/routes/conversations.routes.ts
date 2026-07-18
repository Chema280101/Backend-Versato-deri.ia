import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middlewares/auth.middleware';
import {
  getConversationsByBusiness,
  getConversationById,
  getMessagesByConversation,
  saveMessage,
  updateConversationState,
  logConversationTrace,
  logAuditAction,
} from '../services/db.service';
import { sendTextMessage } from '../services/whatsapp.service';

const router = Router();

// Apply authMiddleware to all routes in this router
router.use(authMiddleware);

/**
 * GET /conversations
 * List all conversations of the authenticated user's business.
 */
router.get('/conversations', async (req: Request, res: Response): Promise<void> => {
  try {
    const businessId = req.businessId!;
    const conversations = await getConversationsByBusiness(businessId);
    res.json(conversations);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch conversations:', error);
    res.status(500).json({ error: 'Internal server error while fetching conversations' });
  }
});

/**
 * GET /conversations/:id
 * Retrieve details of a single conversation, ensuring tenant isolation.
 */
router.get('/conversations/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json(conversation);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch conversation:', error);
    res.status(500).json({ error: 'Internal server error while fetching conversation' });
  }
});

/**
 * GET /conversations/:id/messages
 * Retrieve messages of a conversation, ensuring tenant isolation.
 */
router.get('/conversations/:id/messages', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const messages = await getMessagesByConversation(id, businessId);
    res.json(messages);
  } catch (error) {
    console.error('[ERROR]: Failed to fetch messages:', error);
    res.status(500).json({ error: 'Internal server error while fetching messages' });
  }
});

/**
 * POST /conversations/:id/messages
 * Send a message to a conversation from a human operator.
 * This registers the message in the conversation, pauses the AI, and registers it as generated_by: 'humano'.
 */
router.post('/conversations/:id/messages', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const { body } = req.body;
    if (!body || typeof body !== 'string') {
      res.status(400).json({ error: 'Message body is required and must be a string' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // 1. Send the outbound message to WhatsApp API
    const messageId = await sendTextMessage(conversation.customer_number, body);

    // 2. Save the message to database (sender is 'bot' for outgoing channel messages)
    const savedMessageId = await saveMessage(id, messageId, 'bot', body, 'humano');

    // 3. Pause AI for this conversation
    const statusBefore = conversation.status;
    const salesStateBefore = conversation.sales_state;

    if (statusBefore !== 'pausada_humano') {
      await updateConversationState(id, { status: 'pausada_humano' });
      // Log trace of status update to human-paused
      await logConversationTrace(
        id,
        businessId,
        statusBefore,
        salesStateBefore,
        'pausada_humano',
        salesStateBefore,
        null,
        false,
        null,
        'humano',
      );
      // Log action audit
      await logAuditAction(id, businessId, req.userId!, 'pause_ai');
    } else {
      // Even if already paused, log trace for the sent human message itself
      await logConversationTrace(
        id,
        businessId,
        'pausada_humano',
        salesStateBefore,
        'pausada_humano',
        salesStateBefore,
        null,
        false,
        null,
        'humano',
      );
    }

    res.status(201).json({
      message: 'Message sent and conversation paused',
      message_id: savedMessageId,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to send message:', error);
    res.status(500).json({ error: 'Internal server error while sending message' });
  }
});

/**
 * POST /conversations/:id/pause
 * Pause the conversational AI for this conversation.
 */
router.post('/conversations/:id/pause', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const statusBefore = conversation.status;
    const salesStateBefore = conversation.sales_state;

    if (statusBefore !== 'pausada_humano') {
      await updateConversationState(id, { status: 'pausada_humano' });
      await logConversationTrace(
        id,
        businessId,
        statusBefore,
        salesStateBefore,
        'pausada_humano',
        salesStateBefore,
        null,
        false,
        null,
        'humano',
      );
      await logAuditAction(id, businessId, req.userId!, 'pause_ai');
    }

    res.json({ message: 'Conversational AI paused successfully' });
  } catch (error) {
    console.error('[ERROR]: Failed to pause conversation AI:', error);
    res.status(500).json({ error: 'Internal server error while pausing AI' });
  }
});

/**
 * POST /conversations/:id/pausar
 * cambia el estado a "pausada_humano", registra en la tabla "audit_logs" quién lo hizo y cuándo, emite el evento de WebSocket correspondiente.
 */
router.post('/conversations/:id/pausar', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const statusBefore = conversation.status;
    const salesStateBefore = conversation.sales_state;

    if (statusBefore !== 'pausada_humano') {
      await updateConversationState(id, { status: 'pausada_humano' });
      await logConversationTrace(
        id,
        businessId,
        statusBefore,
        salesStateBefore,
        'pausada_humano',
        salesStateBefore,
        null,
        false,
        null,
        'humano',
      );
      await logAuditAction(id, businessId, req.userId!, 'pause_ai');
    }

    res.json({ message: 'Conversational AI paused successfully' });
  } catch (error) {
    console.error('[ERROR]: Failed to pause conversation AI:', error);
    res.status(500).json({ error: 'Internal server error while pausing AI' });
  }
});

/**
 * POST /conversations/:id/resume
 * Resume the conversational AI for this conversation.
 */
router.post('/conversations/:id/resume', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const statusBefore = conversation.status;
    const salesStateBefore = conversation.sales_state;

    if (statusBefore !== 'activa_ia') {
      await updateConversationState(id, { status: 'activa_ia' });
      await logConversationTrace(
        id,
        businessId,
        statusBefore,
        salesStateBefore,
        'activa_ia',
        salesStateBefore,
        null,
        false,
        null,
        'humano', // Resuming is human action
      );
      await logAuditAction(id, businessId, req.userId!, 'resume_ai');
    }

    res.json({ message: 'Conversational AI resumed successfully' });
  } catch (error) {
    console.error('[ERROR]: Failed to resume conversation AI:', error);
    res.status(500).json({ error: 'Internal server error while resuming AI' });
  }
});

/**
 * POST /conversations/:id/reanudar
 * cambia el estado de vuelta a "activa_ia", registra en audit_logs, emite evento de WebSocket.
 */
router.post('/conversations/:id/reanudar', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const statusBefore = conversation.status;
    const salesStateBefore = conversation.sales_state;

    if (statusBefore !== 'activa_ia') {
      await updateConversationState(id, { status: 'activa_ia' });
      await logConversationTrace(
        id,
        businessId,
        statusBefore,
        salesStateBefore,
        'activa_ia',
        salesStateBefore,
        null,
        false,
        null,
        'humano', // Resuming is human action
      );
      await logAuditAction(id, businessId, req.userId!, 'resume_ai');
    }

    res.json({ message: 'Conversational AI resumed successfully' });
  } catch (error) {
    console.error('[ERROR]: Failed to resume conversation AI:', error);
    res.status(500).json({ error: 'Internal server error while resuming AI' });
  }
});

/**
 * POST /conversations/:id/mensajes-humano
 * Permite que un operador autenticado envíe un mensaje de texto al cliente vía la misma función de envío de WhatsApp construida en la Fase 1.
 * El mensaje debe:
 * - Registrarse en la tabla de mensajes con generado_por: "humano" y el user_id de quien lo escribió.
 * - Solo poder enviarse si la conversación está en estado "pausada_humano" (si no lo está, responde con error indicando que primero debe pausar).
 * - Emitir el evento de WebSocket correspondiente para que otros operadores del mismo negocio vean el mensaje en tiempo real también.
 */
router.post('/conversations/:id/mensajes-humano', async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid conversation ID format' });
      return;
    }

    const { body } = req.body;
    if (!body || typeof body !== 'string') {
      res.status(400).json({ error: 'Message body is required and must be a string' });
      return;
    }

    const businessId = req.businessId!;
    const conversation = await getConversationById(id);

    if (!conversation || conversation.business_id !== businessId) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    // Solo poder enviarse si la conversación está en estado "pausada_humano"
    if (conversation.status !== 'pausada_humano') {
      res.status(400).json({ error: 'La conversación no está en modo humano. Primero debe pausar la IA.' });
      return;
    }

    // 1. Send the outbound message to WhatsApp API
    const messageId = await sendTextMessage(conversation.customer_number, body);

    // 2. Save the message to database (sender is 'bot' for outgoing channel messages)
    const savedMessageId = await saveMessage(id, messageId, 'bot', body, 'humano', req.userId!);

    // 3. Log trace of the human message turn
    await logConversationTrace(
      id,
      businessId,
      'pausada_humano',
      conversation.sales_state,
      'pausada_humano',
      conversation.sales_state,
      null,
      false,
      null,
      'humano',
    );

    res.status(201).json({
      message: 'Mensaje de humano enviado con éxito',
      message_id: savedMessageId,
    });
  } catch (error) {
    console.error('[ERROR]: Failed to send human message:', error);
    res.status(500).json({ error: 'Internal server error while sending human message' });
  }
});

export default router;
