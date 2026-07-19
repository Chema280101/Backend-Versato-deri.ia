# Protocolo de Respuesta ante Incidentes de Seguridad y Notificación de Brechas
**Versato — Plan de Contingencia ANPDP (Plazo Máximo: 48 Horas)**

Este documento formaliza el procedimiento de actuación interna y externa ante un incidente de seguridad que involucre el acceso no autorizado, pérdida, alteración o filtración de datos personales custodiados o tratados por **Versato** (tanto de sus propios usuarios como de los clientes finales de los Tenants).

---

## 1. Definición de Incidentes de Seguridad Críticos

Se considera incidente de seguridad con afectación a datos personales a cualquiera de los siguientes eventos:
1. **Brecha de Aislamiento (Multi-Tenant Leak):** Acceso accidental o malicioso de un negocio (Tenant) a la información o historial de chats de otro negocio.
2. **Exposición de Base de Datos:** Compromiso de las credenciales de Supabase o acceso no autorizado a los servidores de AWS/Vercel que exponga datos de conversaciones o credenciales de usuarios.
3. **Compromiso de API Keys:** Robo o filtración de los tokens de acceso de la API oficial de WhatsApp (Meta) o API keys de los proveedores de LLM (OpenAI/Anthropic).
4. **Acceso no Autorizado a Cuentas:** Acceso ilegítimo a paneles de administración de operadores debido a fallos de autenticación o ataques de fuerza bruta.

---

## 2. Matriz de Roles y Responsabilidades

| Rol | Responsable | Funciones Clave |
| :--- | :--- | :--- |
| **Líder de Respuesta (LRI)** | Oficial de Protección de Datos (OPD) | Coordina el plan, evalúa el impacto legal y presenta la notificación formal ante la ANPDP. |
| **Líder Técnico (LT)** | CTO / Ingeniero de Backend | Identifica el origen del fallo, implementa parches de contención inmediata y recupera copias de seguridad. |
| **Comunicaciones** | CEO / Fundador | Gestiona las notificaciones directas a las empresas clientes (Tenants) afectadas. |

---

## 3. Cronograma Crítico de 48 Horas (ANPDP)

La legislación peruana exige reportar los incidentes a la ANPDP en un plazo máximo de **48 horas** contadas desde que se toma conocimiento del incidente.

```mermaid
gantt
    title Cronograma de Respuesta (48 Horas)
    dateFormat  HH
    axisFormat %Hh
    section Fase 1: Contención
    Detección e Identificación      :active, 0, 6h
    Contención Técnica y Parche     : 4, 12h
    section Fase 2: Evaluación
    Análisis de Impacto y Datos    : 12, 18h
    section Fase 3: Notificación
    Redacción de Reporte ANPDP     : 18, 30h
    Notificación a Clientes (Tenants): 24, 36h
    Envío Formal a la ANPDP        : 36, 48h
```

### Horas 0 - 6: Detección y Contención Técnica Inicial
1. **Reporte:** Cualquier miembro del equipo que detecte una anomalía (alertas de CPU, excepciones de aislamiento, logs inusuales en Supabase) debe avisar inmediatamente al Líder Técnico y al Oficial de Datos.
2. **Contención:** 
   * De ser necesario, revocar temporalmente tokens de WhatsApp API comprometidos.
   * Cambiar de inmediato credenciales y llaves de acceso en las variables de entorno de Vercel/Supabase.
   * Si hay un fallo de aislamiento en producción, pausar temporalmente los endpoints del backend que manejan consultas sensibles o poner la aplicación web en modo mantenimiento temporal.

### Horas 6 - 18: Evaluación de Impacto y Gravedad
El Oficial de Datos, en coordinación con el Líder Técnico, debe auditar y documentar:
* **Naturaleza del incidente:** ¿Qué pasó? ¿Fue un ataque externo, un bug de código o un error humano?
* **Tipos de datos expuestos:** ¿Conversaciones de WhatsApp, nombres, teléfonos, datos de facturación corporativos?
* **Volumen afectado:** Número exacto (o estimado) de personas y empresas clientes afectadas.
* **Evaluación del Riesgo:** Gravedad para los derechos de los titulares (robo de identidad, fraude, exposición de información confidencial).

### Horas 18 - 36: Redacción de Informes y Notificación a Clientes
1. **Notificación B2B (Clientes):** Versato debe notificar de inmediato (vía correo oficial y llamada directa al contacto legal) a los administradores de los negocios (Tenants) afectados. Al ser Versato el *Encargado*, los clientes deben conocer la brecha para que ellos también puedan tomar medidas en su rol de *Responsables*.
   * **Contenido de la notificación B2B:** Breve descripción del incidente, medidas que Versato ya implementó y datos de contacto del OPD para soporte.
2. **Redacción del Informe ANPDP:** El Oficial de Datos preparará el formulario de notificación de incidentes utilizando los campos obligatorios de la ANPDP.

### Horas 36 - 48: Presentación Formal ante la ANPDP
El Oficial de Datos enviará por la mesa de partes virtual del MINJUS la notificación de brecha de seguridad. 

---

## 4. Estructura de Información Requerida para la Notificación (ANPDP)

La notificación formal debe presentarse por escrito conteniendo, como mínimo:

1. **Datos de la Empresa:** Razón social y RUC de Versato S.A.C., y datos de contacto del Oficial de Protección de Datos.
2. **Descripción de la Brecha:** Fecha y hora estimada de ocurrencia y de detección, descripción de la vulnerabilidad y la forma en que ocurrió el acceso no autorizado.
3. **Detalle de Datos Personales Afectados:**
   * Banco de datos afectado (ej. "Historial de Conversaciones de WhatsApp").
   * Categorías de datos expuestas (ej. números de teléfono, nombres, direcciones de entrega).
   * Número aproximado de registros/usuarios afectados.
4. **Medidas de Mitigación Implementadas:** Detalle de las acciones técnicas tomadas para detener la filtración y evitar que se repita (ej. "Se corrigió el query con validación estricta de tenant_id en la línea X de controllers, se rotaron credenciales de base de datos").
5. **Acciones de Comunicación:** Indicar si ya se notificó a los Clientes (Tenants) y las recomendaciones de seguridad compartidas con ellos.
