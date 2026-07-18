import { CatalogItem, ConversationState } from '../db.service';

export interface LLMMessage {
  role: 'user' | 'model' | 'system';
  content: string;
}

export interface LLMResponse {
  text: string;
  decision?: {
    accion: string;
    pedido?: {
      items: {
        catalog_item_id: number;
        cantidad: number;
      }[];
      total: number;
    };
  };
}

export interface LLMContext {
  history: LLMMessage[];
  currentMessage: string;
  state: ConversationState;
  catalog: CatalogItem[];
  brandPrompt: string;
  businessName: string;
}

export interface LLMProvider {
  generateResponse(context: LLMContext): Promise<LLMResponse>;
}
