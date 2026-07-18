# Contexto del Proyecto: Chatbot de Ventas y Postventa (WhatsApp Business Platform)

Este documento define el contexto, las reglas de negocio no negociables y las directrices técnicas para el desarrollo del backend del chatbot.

## Reglas de Negocio No Negociables
1. **No Asistente General**: El bot **NUNCA** debe comportarse como un asistente de propósito general. No debe responder preguntas fuera del catálogo o de los servicios del negocio conectado (requisito de cumplimiento con la política de Meta vigente desde enero de 2026).
2. **Escalamiento Humano**: Toda conversación debe poder escalar a un agente humano. El sistema es **multi-tenant**: cada negocio es independiente, con su propio número, catálogo y configuración.
3. **Pruebas Automatizadas**: Cada funcionalidad que se construya debe venir acompañada de pruebas automatizadas verificables, no solo código.
4. **Seguridad de Credenciales**: No se deben hardcodear credenciales. Todo debe configurarse en variables de entorno, documentadas en un archivo `.env.example`.

## Stack Tecnológico
* **Node.js** con **TypeScript**
* **Express**
* **PostgreSQL**

## Alcance - Fase 1
En esta fase **NO** se integra ningún modelo de Inteligencia Artificial (IA). El objetivo es únicamente:
* Recibir webhooks de WhatsApp.
* Verificar los webhooks.
* Responder mensajes de forma programática simple (modo eco).

*La IA se conectará en la Fase 2.*

## Alcance - Fase 2
Fase 2 en curso: motor conversacional de ventas.

Reglas de diseño no negociables para esta fase:
1. El LLM NUNCA decide solo el flujo de negocio. Existe una máquina de
   estados en código (fuente de verdad) que valida cualquier transición
   antes de aplicarla. El LLM propone, el código decide.
2. El LLM debe usar tool calling / function calling para emitir decisiones
   estructuradas (ej. avanzar de estado, marcar escalamiento a humano),
   separado del texto de respuesta en lenguaje natural.
3. El catálogo del negocio se pasa como contexto real desde la base de
   datos en cada llamada al LLM. El modelo no debe inventar productos,
   precios o stock que no estén en esos datos.
4. El prompt de sistema del LLM debe reforzar explícitamente que el bot
   solo responde sobre el negocio conectado (catálogo, políticas,
   pedidos) y debe rechazar/redirigir preguntas fuera de ese alcance,
   por requisito de cumplimiento con Meta.
5. La integración con el proveedor de LLM debe hacerse detrás de una
   interfaz/adaptador (ej. LLMProvider), no acoplada directamente al
   SDK de un solo proveedor, para poder cambiar de proveedor después
   sin reescribir la lógica de negocio.

## Alcance - Fase 3
Fase 3: panel humano en vivo.

Reglas de diseño no negociables para esta fase:
1. **Aislamiento multi-tenant estricto**: un usuario autenticado de un negocio N NUNCA debe poder ver ni modificar datos de otro negocio, en ningún endpoint, ni por error de query, ni por IDs adivinables en la URL. Cada endpoint debe validar `business_id` del usuario autenticado contra el recurso solicitado.
2. **Pausa de IA individual**: La pausa de la IA es por conversación individual, no global. Pausar una conversación no afecta a las demás del mismo negocio.
3. **Registro de mensajes humanos**: Todo mensaje enviado por un humano debe registrarse indistinguible en el hilo de la conversación (mismo formato que los mensajes de la IA), pero etiquetado internamente como `generado_por: "humano"` para trazabilidad y para el dashboard futuro.
4. **Auditoría de acciones**: Toda acción de pausar/reanudar debe quedar auditada: quién lo hizo y cuándo, sin excepción.

## Alcance - Fase 4
Fase 4 en curso: dashboard de analítica.

Reglas de diseño no negociables para esta fase:
1. **Tarifas de mensajería dinámicas e históricas**: Las tarifas de mensajería NUNCA se hardcodean en el código. Viven en una tabla de configuración con fecha de vigencia, porque Meta las cambia (ej. los mensajes de servicio empiezan a cobrarse desde octubre 2026 en Perú, y las tarifas de marketing/utilidad también pueden variar). El cálculo de costos debe usar siempre la tarifa vigente a la fecha de cada mensaje, no la tarifa actual aplicada retroactivamente.
2. **Aislamiento multi-tenant estricto en analítica**: Todas las métricas y queries de este dashboard deben respetar el aislamiento multi-tenant ya construido: un negocio nunca ve agregados que incluyan datos de otro negocio.
3. **Trazabilidad total de costos y ventas**: Todo cálculo de costo o venta debe ser trazable hasta su origen (un mensaje o pedido específico), no solo un número agregado sin forma de auditarlo.
4. **Mensajes de satisfacción y captura de calificaciones en Postventa**:
   - Al entrar al estado de `postventa` (transición válida posterior a `confirmado`), el sistema envía automáticamente una solicitud de calificación (de 1 al 5).
   - Las respuestas se almacenan en la tabla `satisfaction_ratings` (`id`, `conversation_id`, `business_id`, `calificacion`, `comentario`, `created_at`).
   - El parsing de la respuesta extrae el número 1-5 si está presente (incluso con texto adicional) y guarda comentarios asociados. Si no contiene un número de 1 a 5, se guarda únicamente como comentario libre sin calificacion, asegurando que no se bloquee ni falle el flujo conversacional.
   - Cuenta con control de duplicados basado en la fecha de la última transición de entrada a `postventa` (`sales_state_before != 'postventa'`), previniendo múltiples registros de calificación para una misma sesión de encuesta.

