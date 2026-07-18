# Reglas de Proyecto - Chatbot WhatsApps

## Fase 4: Dashboard de Analítica
1. **Tarifas de mensajería dinámicas e históricas**: Las tarifas de mensajería NUNCA se hardcodean en el código. Viven en una tabla de configuración con fecha de vigencia, porque Meta las cambia (ej. los mensajes de servicio empiezan a cobrarse desde octubre 2026 en Perú, y las tarifas de marketing/utilidad también pueden variar). El cálculo de costos debe usar siempre la tarifa vigente a la fecha de cada mensaje, no la tarifa actual aplicada retroactivamente.
2. **Aislamiento multi-tenant estricto en analítica**: Todas las métricas y queries de este dashboard deben respetar el aislamiento multi-tenant ya construido: un negocio nunca ve agregados que incluyan datos de otro negocio.
3. **Trazabilidad total de costos y ventas**: Todo cálculo de costo o venta debe ser trazable hasta su origen (un mensaje o pedido específico), no solo un número agregado sin forma de auditarlo.
