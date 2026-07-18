import { updateConversationState } from './db.service';

export type ConversationStatus = 'activa_ia' | 'pausada_humano' | 'cerrada';
export type SalesState =
  | 'saludo'
  | 'calificacion_necesidad'
  | 'recomendacion_producto'
  | 'manejo_objeciones'
  | 'cierre_y_pago'
  | 'confirmado'
  | 'postventa'
  | 'escalado_humano'
  | 'cerrada';

// Map of valid transitions for Conversation Status
const VALID_STATUS_TRANSITIONS: Record<ConversationStatus, ConversationStatus[]> = {
  activa_ia: ['pausada_humano', 'cerrada'],
  pausada_humano: ['activa_ia', 'cerrada'],
  cerrada: ['activa_ia'],
};

// Map of valid transitions for Sales State
export const VALID_SALES_STATE_TRANSITIONS: Record<SalesState, SalesState[]> = {
  saludo: ['calificacion_necesidad', 'cerrada'],
  calificacion_necesidad: ['recomendacion_producto', 'cerrada'],
  recomendacion_producto: [
    'manejo_objeciones',
    'cierre_y_pago',
    'calificacion_necesidad',
    'cerrada',
  ],
  manejo_objeciones: [
    'recomendacion_producto',
    'cierre_y_pago',
    'calificacion_necesidad',
    'cerrada',
  ],
  cierre_y_pago: ['confirmado', 'manejo_objeciones', 'recomendacion_producto', 'cerrada'],
  confirmado: ['postventa', 'cerrada'],
  postventa: ['saludo', 'cerrada'],
  escalado_humano: ['saludo', 'postventa', 'cerrada'],
  cerrada: ['saludo'],
};

/**
 * Validates transition from current status to proposed status.
 */
export function isValidStatusTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  if (from === to) return true;
  return VALID_STATUS_TRANSITIONS[from]?.includes(to) || false;
}

/**
 * Validates transition from current sales state to proposed sales state.
 */
export function isValidSalesStateTransition(from: SalesState, to: SalesState): boolean {
  // If the state is the same, it is technically valid (no change)
  if (from === to) return true;
  // Forced transition to escalado_humano is always valid from any state
  if (to === 'escalado_humano') return true;
  return VALID_SALES_STATE_TRANSITIONS[from]?.includes(to) || false;
}

/**
 * Validates and applies state transitions.
 * Returns transition outcome details.
 */
export async function validateAndApplyTransition(
  conversationId: number,
  currentStatus: ConversationStatus,
  currentSalesState: SalesState,
  proposedStatus?: ConversationStatus,
  proposedSalesState?: SalesState,
): Promise<{
  success: boolean;
  error?: string;
  status?: ConversationStatus;
  salesState?: SalesState;
}> {
  let nextStatus = currentStatus;
  let nextSalesState = currentSalesState;

  let actualProposedStatus = proposedStatus;
  let actualProposedSalesState = proposedSalesState;

  // Auto-sync between sales state and status
  if (actualProposedSalesState === 'escalado_humano') {
    actualProposedStatus = 'pausada_humano';
  } else if (actualProposedSalesState === 'cerrada') {
    actualProposedStatus = 'cerrada';
  }

  if (actualProposedStatus === 'pausada_humano' && !actualProposedSalesState) {
    actualProposedSalesState = 'escalado_humano';
  } else if (actualProposedStatus === 'cerrada' && !actualProposedSalesState) {
    actualProposedSalesState = 'cerrada';
  }

  if (
    actualProposedStatus === 'activa_ia' &&
    (currentSalesState === 'escalado_humano' || currentSalesState === 'cerrada') &&
    !actualProposedSalesState
  ) {
    actualProposedSalesState = 'saludo';
  }

  // Validate conversation status transition
  if (actualProposedStatus && actualProposedStatus !== currentStatus) {
    if (!isValidStatusTransition(currentStatus, actualProposedStatus)) {
      return {
        success: false,
        error: `Invalid transition for conversation status from '${currentStatus}' to '${actualProposedStatus}'`,
        status: currentStatus,
        salesState: currentSalesState,
      };
    }
    nextStatus = actualProposedStatus;
  }

  // Validate sales flow state transition
  if (actualProposedSalesState && actualProposedSalesState !== currentSalesState) {
    if (!isValidSalesStateTransition(currentSalesState, actualProposedSalesState)) {
      return {
        success: false,
        error: `Invalid transition for sales state from '${currentSalesState}' to '${actualProposedSalesState}'`,
        status: currentStatus,
        salesState: currentSalesState,
      };
    }
    nextSalesState = actualProposedSalesState;
  }

  // If there are changes, save to the database
  if (nextStatus !== currentStatus || nextSalesState !== currentSalesState) {
    await updateConversationState(conversationId, {
      status: nextStatus,
      salesState: nextSalesState,
    });
  }

  return {
    success: true,
    status: nextStatus,
    salesState: nextSalesState,
  };
}
