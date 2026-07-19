import {
  pool,
  getCatalogItems,
  CatalogItem,
  getMessagesHistory,
  getBusinessConfig,
  saveMessage,
  createNotification,
  updateConversationState,
  logConversationTrace,
  createOrder,
  OrderItem,
  saveSatisfactionRating,
  shouldRecordSatisfactionRating,
} from './db.service';
import {
  validateAndApplyTransition,
  isValidSalesStateTransition,
  ConversationStatus,
  SalesState,
} from './state-machine.service';
import { LLMProvider, LLMMessage, LLMContext } from './llm/llm.provider';
import { sendTextMessage } from './whatsapp.service';

/**
 * Normalizes and filters catalog items to get only active and relevant ones based on keyword matching.
 */
export function filterRelevantCatalogItems(
  items: CatalogItem[],
  userMessage: string,
  limit: number = 8,
): CatalogItem[] {
  // Only active items
  const activeItems = items.filter((item) => item.activo);

  if (activeItems.length === 0) {
    return [];
  }

  // Helper to normalize text (lowercase, remove accents/diacritics)
  const normalize = (text: string): string => {
    return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  };

  const normalizedMessage = normalize(userMessage);

  // Extract search words (length >= 3)
  const searchWords = normalizedMessage
    .split(/\s+/)
    .map((word) => word.replace(/[^a-zA-Z0-9]/g, '')) // remove punctuation
    .filter((word) => word.length >= 3);

  if (searchWords.length === 0) {
    // Fallback: return first few items as context if message is too short/generic
    return activeItems.slice(0, limit);
  }

  // Calculate matching score for each item
  const scoredItems = activeItems.map((item) => {
    const fieldsToMatch = [item.nombre, item.descripcion || '', item.categoria].map((f) =>
      normalize(f),
    );

    let score = 0;
    for (const word of searchWords) {
      for (const field of fieldsToMatch) {
        if (field.includes(word)) {
          score += 1;
        }
      }
    }

    return { item, score };
  });

  // Filter items with at least one match
  const matchedItems = scoredItems
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  if (matchedItems.length > 0) {
    return matchedItems.slice(0, limit);
  }

  // Fallback if no products match
  return activeItems.slice(0, limit);
}

export const DISSATISFACTION_PATTERNS = [
  'esto es una estafa',
  'quiero mi dinero de vuelta',
  'pesimo servicio',
  'pésimo servicio',
  'reembolso',
  'devolucion',
  'devolución',
  'estafadores',
  'pesima atencion',
  'pésima atención',
  'reclamar',
  'reclamo',
  'queja',
  'servicio terrible',
  'servicio horrible',
  'mal servicio',
  'pesimo',
  'pésimo',
  'pesima',
  'pésima',
  'una porqueria',
  'una porquería',
  'es un robo',
  'me estafaron',
  'decepcionado',
  'quiero cancelar',
  'devolver mi dinero',
  'no sirve para nada',
  'no me funciona',
];

export const HUMAN_REQUEST_PATTERNS = [
  'hablar con alguien',
  'operador',
  'humano',
  'agente',
  'soporte humano',
  'hablar con un asesor',
  'asesor humano',
  'persona real',
  'atencion al cliente',
  'atención al cliente',
  'hablar con una persona',
  'hablar con un humano',
  'pasame con alguien',
  'pásame con alguien',
  'contacto directo',
  'comunicarme con una persona',
  'atencion humana',
  'atención humana',
  'atencion de un agente',
  'atención de un agente',
];

export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function matchesPattern(text: string, patterns: string[]): boolean {
  const normalizedText = normalizeText(text);
  return patterns.some((pattern) => normalizedText.includes(normalizeText(pattern)));
}

/**
 * Parses the customer's satisfaction response.
 * - Extracts a number 1 to 5 if present.
 * - Captures the comment if they write something besides the number (or if it's text-only).
 */
export function parseSatisfactionResponse(text: string): { calificacion: number | null; comentario: string | null } {
  const trimmed = text.trim();
  
  // Check if the input is exactly a digit 1-5, or a digit followed by standard punctuation (. or !)
  const exactMatch = trimmed.match(/^([1-5])[\.\!\?]?$/);
  if (exactMatch) {
    return { calificacion: parseInt(exactMatch[1], 10), comentario: null };
  }
  
  // Look for a digit 1-5 bounded by word boundaries in the message
  const wordMatch = trimmed.match(/\b([1-5])\b/);
  if (wordMatch) {
    return { calificacion: parseInt(wordMatch[1], 10), comentario: trimmed };
  }
  
  // Fallback: register full text as free-form comment, rating is null
  return { calificacion: null, comentario: trimmed || null };
}

export class ConversationalEngine {
  private llmProvider: LLMProvider;

  constructor(llmProvider: LLMProvider) {
    this.llmProvider = llmProvider;
  }

  /**
   * Processes an incoming customer message through the conversational engine.
   * Resolves when processing is complete.
   */
  public async processIncomingMessage(
    conversationId: number,
    customerNumber: string,
    messageText: string,
  ): Promise<void> {
    // 1. Get conversation details (business_id, status, sales_state, amount, consecutive_attempts)
    const convResult = await pool.query(
      'SELECT business_id, status, sales_state, amount, consecutive_attempts FROM conversations WHERE id = $1;',
      [conversationId],
    );

    if (convResult.rows.length === 0) {
      console.warn(`[WARNING]: Conversation ${conversationId} not found in DB. Skipping.`);
      return;
    }

    const {
      business_id: businessId,
      status,
      sales_state: salesState,
      amount: rawAmount,
      consecutive_attempts: rawConsecutiveAttempts,
    } = convResult.rows[0];

    const currentAmount = parseFloat(rawAmount || '0');
    const consecutiveAttempts = parseInt(rawConsecutiveAttempts || '0', 10);

    const statusBefore = status as ConversationStatus;
    const salesStateBefore = salesState as SalesState;

    // Intercept and record satisfaction rating if in postventa state
    if (salesState === 'postventa') {
      try {
        const shouldRecord = await shouldRecordSatisfactionRating(conversationId);
        if (shouldRecord) {
          const { calificacion, comentario } = parseSatisfactionResponse(messageText);
          await saveSatisfactionRating(conversationId, businessId, calificacion, comentario);
          console.log(`[INFO]: Recorded satisfaction rating for conversation ${conversationId}: calificacion=${calificacion}, comentario=${comentario}`);
        }
      } catch (err) {
        console.error(`[ERROR]: Failed to capture satisfaction rating for conversation ${conversationId}:`, err);
        // Do not block the rest of the flow
      }
    }

    // 2. Human Interruption Rule: If status is 'pausada_humano', bypass LLM processing entirely
    if (status === 'pausada_humano') {
      console.log(
        `[INFO]: Conversation ${conversationId} is paused (human agent active). Skipping AI processing.`,
      );
      await logConversationTrace(
        conversationId,
        businessId,
        statusBefore,
        salesStateBefore,
        statusBefore,
        salesStateBefore,
        null,
        false,
        'Conversación pausada (humano activo)',
        'humano',
      );
      return;
    }

    // 3. Load business configuration
    const businessConfig = await getBusinessConfig(businessId);
    const businessName = businessConfig?.name || 'Nuestro Negocio';
    const brandPrompt = businessConfig?.brandPrompt || '';
    const escalationThreshold = businessConfig?.escalationThreshold;

    // Check immediate safety human-escalation rules:
    const isDissatisfied = matchesPattern(messageText, DISSATISFACTION_PATTERNS);
    const isExplicitRequest = matchesPattern(messageText, HUMAN_REQUEST_PATTERNS);
    const isAmountExceeded =
      escalationThreshold !== null &&
      escalationThreshold !== undefined &&
      currentAmount > escalationThreshold;

    if (isDissatisfied || isExplicitRequest || isAmountExceeded) {
      let type = '';
      let logMsg = '';
      const botReply = 'Te estoy transfiriendo con un agente humano para ayudarte mejor.';

      if (isDissatisfied) {
        type = 'dissatisfaction';
        logMsg = `Cliente insatisfecho o con reclamo fuerte: "${messageText}"`;
      } else if (isExplicitRequest) {
        type = 'explicit_request';
        logMsg = `Cliente solicitó agente humano explícitamente: "${messageText}"`;
      } else {
        type = 'amount_threshold';
        logMsg = `Monto de conversación (${currentAmount}) supera el umbral configurable (${escalationThreshold})`;
      }

      console.log(
        `[INFO]: Safety human escalation triggered [${type}] for conversation ${conversationId}. Escalating immediately.`,
      );

      // Transition state
      await validateAndApplyTransition(
        conversationId,
        statusBefore,
        salesStateBefore,
        'pausada_humano',
        'escalado_humano',
      );

      // Create internal notification
      await createNotification(conversationId, businessId, type, logMsg);

      // Reset attempts counter to 0
      await updateConversationState(conversationId, { consecutiveAttempts: 0 });

      // Send bot reply
      const outgoingMsgId = await sendTextMessage(customerNumber, botReply);
      await saveMessage(conversationId, outgoingMsgId, 'bot', botReply);

      // Log trace
      await logConversationTrace(
        conversationId,
        businessId,
        statusBefore,
        salesStateBefore,
        'pausada_humano',
        'escalado_humano',
        null,
        true,
        `Escalamiento de seguridad: ${type} - ${logMsg}`,
        'IA',
      );
      return;
    }

    // 4. Load catalog items and filter to active & relevant only
    const allCatalogItems = await getCatalogItems(businessId);
    const relevantCatalogItems = filterRelevantCatalogItems(allCatalogItems, messageText);

    // 5. Load chronological messages history (last 10 messages)
    const rawHistory = await getMessagesHistory(conversationId, 10);
    const llmHistory: LLMMessage[] = rawHistory.map((m) => ({
      role: m.sender === 'bot' ? 'model' : 'user',
      content: m.body,
    }));

    // 6. Invoke LLM Provider with LLMContext
    const context: LLMContext = {
      history: llmHistory,
      currentMessage: messageText,
      state: {
        status: status as ConversationStatus,
        salesState: salesState as SalesState,
      },
      catalog: relevantCatalogItems,
      brandPrompt: brandPrompt || '',
      businessName,
      trainingInfo: businessConfig?.trainingInfo || undefined,
    };

    console.log(
      `[INFO]: Invoking LLM for conversation ${conversationId}. Current sales state: ${salesState}`,
    );
    const llmResponse = await this.llmProvider.generateResponse(context);

    let finalStatus: ConversationStatus = status;
    let finalSalesState: SalesState = salesState;

    // 7. Validate and apply decision code-side (LLM proposes, code decides)
    if (llmResponse.decision?.accion) {
      const action = llmResponse.decision.accion.trim();
      console.log(`[INFO]: LLM proposed action decision: "${action}"`);

      if (action === 'mantener_estado') {
        console.log('[INFO]: Action is to maintain current state.');
      } else if (action.startsWith('avanzar_a:')) {
        const proposedTarget = action.substring('avanzar_a:'.length).trim() as SalesState;

        let proceedTransition = true;

        if (proposedTarget === 'confirmado') {
          const pedido = llmResponse.decision?.pedido;
          if (!pedido || !pedido.items || !Array.isArray(pedido.items) || pedido.items.length === 0) {
            console.warn(`[WARNING]: LLM attempted transition to 'confirmado' for conversation ${conversationId} without order details.`);
            proceedTransition = false;
          } else {
            // Validate items and total
            try {
              const catalogItems = await getCatalogItems(businessId);
              const activeCatalogMap = new Map<number, typeof catalogItems[0]>();
              for (const item of catalogItems) {
                if (item.activo) {
                  activeCatalogMap.set(item.id, item);
                }
              }

              let calculatedTotal = 0;
              const orderItems: OrderItem[] = [];
              let itemsValid = true;

              for (const pItem of pedido.items) {
                const catalogItem = activeCatalogMap.get(pItem.catalog_item_id);
                if (!catalogItem) {
                  console.warn(`[WARNING]: Invalid order item catalog_item_id ${pItem.catalog_item_id} (not found, inactive, or unauthorized tenant) for conversation ${conversationId}.`);
                  itemsValid = false;
                  break;
                }
                if (pItem.cantidad <= 0) {
                  console.warn(`[WARNING]: Invalid quantity ${pItem.cantidad} for catalog_item_id ${pItem.catalog_item_id} in conversation ${conversationId}.`);
                  itemsValid = false;
                  break;
                }
                calculatedTotal += catalogItem.precio * pItem.cantidad;
                orderItems.push({
                  catalog_item_id: catalogItem.id,
                  nombre: catalogItem.nombre,
                  precio_unitario: catalogItem.precio,
                  cantidad: pItem.cantidad,
                });
              }

              if (!itemsValid) {
                proceedTransition = false;
              } else {
                const roundedCalculated = Math.round(calculatedTotal * 100) / 100;
                const roundedProposed = Math.round(pedido.total * 100) / 100;
                if (roundedCalculated !== roundedProposed) {
                  console.warn(`[WARNING]: Order total mismatch. Proposed: ${roundedProposed}, Calculated: ${roundedCalculated} for conversation ${conversationId}.`);
                  proceedTransition = false;
                } else {
                  // Save the order to DB
                  const orderId = await createOrder({
                    conversationId,
                    businessId,
                    items: orderItems,
                    total: roundedCalculated,
                  });
                  console.log(`[INFO]: Order ${orderId} saved successfully for conversation ${conversationId}. Total: ${roundedCalculated}`);
                }
              }
            } catch (err) {
              console.error(`[ERROR]: Failed to validate order for conversation ${conversationId}:`, err);
              proceedTransition = false;
            }
          }
        }

        if (proceedTransition) {
          // Code-side validation using state-machine service:
          const valid = isValidSalesStateTransition(finalSalesState, proposedTarget);
          if (valid) {
            const result = await validateAndApplyTransition(
              conversationId,
              finalStatus,
              finalSalesState,
              undefined,
              proposedTarget,
            );
            if (result.success) {
              console.log(
                `[INFO]: State transition approved. Sales state updated to: ${result.salesState}`,
              );
              finalSalesState = result.salesState!;
              finalStatus = result.status!;
            } else {
              console.warn(`[WARNING]: State transition failed. Error: ${result.error}`);
            }
          } else {
            console.warn(
              `[WARNING]: State transition rejected code-side. Invalid transition from '${finalSalesState}' to '${proposedTarget}'. Reverting to 'mantener_estado'.`,
            );
          }
        } else {
          console.warn(
            `[WARNING]: Order validation failed. Rejecting transition to 'confirmado' and maintaining previous state: '${finalSalesState}'.`,
          );
        }
      } else if (action.startsWith('escalar_humano:')) {
        const result = await validateAndApplyTransition(
          conversationId,
          finalStatus,
          finalSalesState,
          'pausada_humano',
          'escalado_humano',
        );
        if (result.success) {
          console.log(
            `[INFO]: Escalation approved. Conversation status updated to: ${result.status}`,
          );
          finalStatus = result.status!;
          finalSalesState = result.salesState!;
        } else {
          console.warn(`[WARNING]: Escalation failed. Error: ${result.error}`);
        }
      } else {
        console.warn(
          `[WARNING]: Unknown action format proposed: "${action}". Reverting to 'mantener_estado'.`,
        );
      }
    }

    // Evaluate stagnation attempts (Rule 3)
    let newAttempts = consecutiveAttempts;
    let hasEscalatedFromStagnation = false;

    if (finalSalesState === salesState) {
      newAttempts += 1;
      if (newAttempts >= 3) {
        console.log(
          `[INFO]: Consecutive attempts stagnation reached N=3. Escalating conversation ${conversationId}.`,
        );

        // 1. Transition to escalado_humano
        await validateAndApplyTransition(
          conversationId,
          finalStatus,
          finalSalesState,
          'pausada_humano',
          'escalado_humano',
        );

        // 2. Create notification
        const logMsg = `El bot no logró avanzar del estado '${salesState}' después de 3 intentos consecutivos.`;
        await createNotification(conversationId, businessId, 'consecutive_attempts', logMsg);

        // 3. Reset counter in DB
        await updateConversationState(conversationId, { consecutiveAttempts: 0 });

        // 4. Overwrite bot reply to transfer message
        const botReply =
          'He tenido problemas para entenderte. Te estoy transfiriendo con un agente humano.';
        const outgoingMsgId = await sendTextMessage(customerNumber, botReply);
        await saveMessage(conversationId, outgoingMsgId, 'bot', botReply);

        hasEscalatedFromStagnation = true;
        finalStatus = 'pausada_humano';
        finalSalesState = 'escalado_humano';
      } else {
        await updateConversationState(conversationId, { consecutiveAttempts: newAttempts });
      }
    } else {
      await updateConversationState(conversationId, { consecutiveAttempts: 0 });
    }

    if (!hasEscalatedFromStagnation) {
      // 8. Send natural language response if present
      const botReplyText = llmResponse.text;
      if (botReplyText) {
        console.log(`[INFO]: Sending response to customer ${customerNumber}: "${botReplyText}"`);
        const outgoingMsgId = await sendTextMessage(customerNumber, botReplyText);
        await saveMessage(conversationId, outgoingMsgId, 'bot', botReplyText);
      } else {
        console.log('[INFO]: LLM did not return natural language text response.');
      }
    }

    // Traceability logging at the end of LLM flow
    const escalationTriggered =
      finalStatus === 'pausada_humano' && statusBefore !== 'pausada_humano';
    let escalationReason = null;
    if (escalationTriggered) {
      if (hasEscalatedFromStagnation) {
        escalationReason = `Estancamiento (3 intentos en ${salesState})`;
      } else if (llmResponse.decision?.accion?.startsWith('escalar_humano:')) {
        escalationReason = llmResponse.decision.accion.substring('escalar_humano:'.length).trim();
      } else {
        escalationReason = 'Escalamiento propuesto por LLM';
      }
    }

    await logConversationTrace(
      conversationId,
      businessId,
      statusBefore,
      salesStateBefore,
      finalStatus,
      finalSalesState,
      llmResponse.decision || null,
      escalationTriggered,
      escalationReason,
      'IA',
    );
  }
}
