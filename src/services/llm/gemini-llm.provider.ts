import { LLMProvider, LLMResponse, LLMContext } from './llm.provider';
import { VALID_SALES_STATE_TRANSITIONS, SalesState } from '../state-machine.service';

export class GeminiLLMProvider implements LLMProvider {
  private apiKey: string;
  private modelName: string;

  constructor(apiKey?: string, modelName: string = 'gemini-2.5-flash') {
    this.apiKey = apiKey || process.env.GEMINI_API_KEY || '';
    this.modelName = modelName;
  }

  public async generateResponse(context: LLMContext): Promise<LLMResponse> {
    if (!this.apiKey) {
      console.warn('[WARNING]: GEMINI_API_KEY is not defined. Using mock response.');
      return { text: 'API Key not configured. Please set GEMINI_API_KEY.' };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.apiKey}`;

    // Format history
    const contents: any[] = [];
    for (const msg of context.history) {
      const role = msg.role === 'model' ? 'model' : 'user';
      contents.push({
        role,
        parts: [{ text: msg.content }],
      });
    }

    // Append the current message
    contents.push({
      role: 'user',
      parts: [{ text: context.currentMessage }],
    });

    const businessName = context.businessName || 'El Negocio';
    const brandPrompt = context.brandPrompt || 'Amigable y profesional';
    const catalogText =
      context.catalog.length > 0
        ? context.catalog
            .map(
              (p) =>
                `- Nombre: ${p.nombre} | Categoría: ${p.categoria} | Precio: $${p.precio} | Stock: ${p.stock} | Descripción: ${p.descripcion || 'Sin descripción'}`,
            )
            .join('\n')
        : 'No hay productos disponibles actualmente.';

    const currentSalesState = context.state.salesState as SalesState;
    const allowedTransitions = VALID_SALES_STATE_TRANSITIONS[currentSalesState] || [];
    const allowedTransitionsList = allowedTransitions.map((s) => `"${s}"`).join(', ');

    const trainingInfoText = context.trainingInfo
      ? `POLÍTICAS, REGLAS Y PREGUNTAS FRECUENTES DEL NEGOCIO (Sígue las siguientes directrices de forma estricta):
${context.trainingInfo}`
      : '';

    const systemPrompt = `Eres un agente de ventas chatbot para el negocio "${businessName}".
Tu personalidad y tono de marca es: ${brandPrompt}.

IDENTIDAD DEL ASISTENTE (INSTRUCCIONES FIJAS — SIEMPRE APLICAN):
- Tu nombre es Deri.
- Cuando te presentes, hazlo siempre como: "Hola, soy Deri, el asistente virtual de ${businessName}".
- NUNCA uses "deri.ia" dentro de una respuesta conversacional. Ese nombre es solo para uso comercial y de marca, no para hablar con el cliente.
- Solo puedes responder sobre productos, precios, políticas y pedidos de este negocio. Si te preguntan algo fuera de este alcance, indica amablemente que no puedes ayudar con eso y ofrece continuar con la conversación de venta.

${trainingInfoText}

CATÁLOGO REAL DE PRODUCTOS (Solo responde sobre lo que está aquí):
${catalogText}

ESTADO ACTUAL DE LA CONVERSACIÓN:
- Estado del flujo de ventas actual: "${currentSalesState}"
- Estado de la conversación: "${context.state.status}"

MÁQUINA DE ESTADOS (RESTRICCIONES IMPORTANTES):
Desde el estado actual "${currentSalesState}", las ÚNICAS transiciones válidas para avanzar de estado son hacia: ${allowedTransitionsList || 'ninguna'}. Cualquier otra transición será rechazada por el servidor y revertida a mantener el estado.

INSTRUCCIONES PARA LA TOMA DE DECISIONES DE ESTADO:
Debes usar la herramienta/función 'tomar_decision' en cada respuesta para registrar el estado al que se debe mover la conversación.
Selecciona una de estas opciones para el parámetro 'accion':
1. 'mantener_estado' - Si se mantiene la conversación en el estado actual ("${currentSalesState}").
2. 'avanzar_a:<nombre_estado>' - Si deseas cambiar el estado. El <nombre_estado> que elijas debe estar en la lista de transiciones válidas: [${allowedTransitionsList}].
3. 'escalar_humano:<motivo>' - Si el cliente solicita hablar con un humano o está enojado/frustrado. Reemplaza <motivo> con una descripción corta y directa de 1 a 5 palabras explicando la razón (ej. 'escalar_humano:solicita_agente' o 'escalar_humano:frustrado').

Si la acción elegida es 'avanzar_a:confirmado', DEBES incluir obligatoriamente el parámetro 'pedido' detallando los artículos comprados (catalog_item_id y cantidad) y el total. El total debe calcularse multiplicando el precio real del catálogo de cada artículo por su cantidad. No inventes productos ni precios que no estén en el catálogo. Para cualquier otra acción, NO debes enviar el parámetro 'pedido'.

RECUERDA: Debes proporcionar tanto la respuesta en lenguaje natural para el cliente en formato de texto normal, como la llamada a la herramienta 'tomar_decision'.`;

    const payload: any = {
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'tomar_decision',
              description: 'Registra la decisión sobre el flujo de ventas o el escalado a humano.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  accion: {
                    type: 'STRING',
                    description:
                      "La acción elegida: 'mantener_estado', 'avanzar_a:<nombre_estado>', o 'escalar_humano:<motivo>'.",
                  },
                  pedido: {
                    type: 'OBJECT',
                    description:
                      "Detalle del pedido. OBLIGATORIO si la acción es 'avanzar_a:confirmado'. NUNCA lo incluyas para otras acciones.",
                    properties: {
                      items: {
                        type: 'ARRAY',
                        description: "Lista de items en el pedido.",
                        items: {
                          type: 'OBJECT',
                          properties: {
                            catalog_item_id: {
                              type: 'INTEGER',
                              description: "El ID del item de catálogo."
                            },
                            cantidad: {
                              type: 'INTEGER',
                              description: "La cantidad del item (entero positivo)."
                            }
                          },
                          required: ['catalog_item_id', 'cantidad']
                        }
                      },
                      total: {
                        type: 'NUMBER',
                        description: "El total del pedido (suma de precio * cantidad de los items)."
                      }
                    },
                    required: ['items', 'total']
                  }
                },
                required: ['accion'],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
        },
      },
    };

    try {
      console.log(`[INFO]: Calling Gemini API (${this.modelName})...`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ERROR]: Gemini API returned error:', errorText);
        throw new Error(`Gemini API error (status ${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as any;
      const candidate = data.candidates?.[0];
      const contentParts = candidate?.content?.parts || [];

      let responseText = '';
      let decision: LLMResponse['decision'] = undefined;

      for (const part of contentParts) {
        if (part.text) {
          responseText += part.text;
        }
        if (part.functionCall && part.functionCall.name === 'tomar_decision') {
          decision = {
            accion: part.functionCall.args?.accion || 'mantener_estado',
            pedido: part.functionCall.args?.pedido || undefined,
          };
        }
      }

      return {
        text: responseText.trim(),
        decision,
      };
    } catch (error) {
      console.error('[ERROR]: Failed to generate response from Gemini API:', error);
      throw error;
    }
  }
}
