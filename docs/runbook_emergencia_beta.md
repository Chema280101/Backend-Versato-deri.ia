# Runbook de Emergencia para la Beta — Chatbot WhatsApp (Versato)

Este runbook detalla los pasos de contingencia inmediatos a seguir durante la fase beta si el sistema presenta fallos críticos en su funcionamiento o seguridad.

---

## 📞 Contactos de Emergencia

En cualquier escenario de comportamiento anómalo o sospechoso, las siguientes personas deben ser notificadas de inmediato:

1. **Líder Técnico / Desarrollador (Soporte Técnico Backend/Frontend)**
   * **Nombre:** Jose Manuel (CTO / Ingeniero de Software)
   * **Responsabilidad:** Diagnóstico de código, base de datos, infraestructura y rotación de llaves.
   * **Canal:** Teléfono móvil / WhatsApp directo y canal de alertas de Discord/Sentry.

2. **Dueño del Negocio Piloto (Tenant Administrador)**
   * **Nombre:** [Nombre del Dueño/Administrador del Negocio Piloto]
   * **Responsabilidad:** Coordinación del flujo manual de atención, toma de decisiones comerciales y comunicación con clientes finales.
   * **Canal:** Teléfono móvil directo y correo electrónico corporativo.

---

## 🚨 Escenarios de Emergencia y Primeros Pasos

### Escenario 1: El bot deja de responder (Outage / Caída del servicio)
*El bot no responde a los mensajes de WhatsApp de ningún cliente y la comunicación está congelada.*

* **PRIMER PASO CONCRETO:**
  Consultar el endpoint de salud `GET /health` del backend y revisar el canal de alertas críticas en Discord (o consola de errores de Sentry) para determinar si el servidor se encuentra activo o si hay un fallo masivo en las conexiones del webhook de WhatsApp.

* **Pasos a seguir:**
  1. **Verificar el Servidor:** Ingresar a la consola del servidor (VPS/AWS/Vercel) y ejecutar:
     ```bash
     pm2 status
     # o verificar contenedores docker
     docker ps
     ```
  2. **Verificar Base de Datos:** Si el backend responde pero da error 500, probar la conectividad a la base de datos Supabase utilizando `GET /health`.
  3. **Comprobar Webhook de Meta:** Revisar en el *Meta Business Developer Dashboard* si el webhook ha sido desactivado automáticamente por Meta debido a fallas repetidas, o si los tokens de WhatsApp (`WHATSAPP_TOKEN`) han expirado.
  4. **Restablecer el Servicio:**
     * Si el proceso de Node está caído, reiniciarlo:
       ```bash
       pm2 restart versato-backend
       ```
     * Si hay un fallo de tokens o variables de entorno, corregir el archivo `.env` y aplicar los cambios.
  5. **Notificar:** Reportar el estado de restablecimiento del servicio a **Jose Manuel** (Líder Técnico) y coordinar con el **Dueño del Negocio Piloto** en caso de que los clientes reporten demoras de atención.

---

### Escenario 2: El bot responde incorrectamente o fuera de alcance repetidamente (Alucinaciones / Mal comportamiento de la IA)
*El bot envía información de precios errónea, alucina de forma de manera persistente o responde con un tono inadecuado a un cliente.*

* **PRIMER PASO CONCRETO:**
  Pausar inmediatamente la IA para la conversación del cliente afectado, cambiando su estado en la base de datos o consola de administración a `'pausada_humano'`. Esto detiene por completo la intervención del bot en esa línea y permite la atención humana.

* **Pasos a seguir:**
  1. **Pausar Conversación Específica:**
     * A través del Panel de Operador: Buscar la conversación por número de teléfono y presionar el botón **Pausar IA**.
     * A través de Base de Datos (SQL urgente si el panel no está accesible):
       ```sql
       UPDATE conversations 
       SET status = 'pausada_humano', sales_state = 'escalado_humano' 
       WHERE customer_number = '51XXXXXXXXX' AND business_id = <ID_NEGOCIO>;
       ```
     * A través de API (con token del operador):
       `POST /conversations/:id/pausar`
  2. **Notificar al Negocio Piloto:** Avisar de inmediato al **Dueño del Negocio Piloto** para que un operador de atención al cliente humano atienda la conversación en curso de forma manual desde el panel.
  3. **Auditar la Falla:** **Jose Manuel** deberá inspeccionar las trazas de la conversación en la tabla `conversation_traces` para leer la decisión exacta tomada por el LLM en la columna `llm_decision`.
  4. **Modificar Reglas o Prompt:** Ajustar el prompt de la marca (`brand_prompt` en la tabla `businesses`) o depurar el catálogo de productos si el fallo se originó por mala estructuración de los datos.

---

### Escenario 3: Sospecha de filtración de datos (Data Leak / Compromiso de Seguridad)
*Sospecha de que un negocio (Tenant) puede ver información de otro negocio, o indicios de exposición de base de datos o API Keys.*

* **PRIMER PASO CONCRETO:**
  Realizar un corte inmediato en el procesamiento del Webhook de WhatsApp cambiando la clave secreta de la aplicación (`APP_SECRET` o `VERIFY_TOKEN`) en las variables de entorno del servidor. Esto causa que todos los payloads de Meta fallen la validación de firma y se descarten al instante con un código HTTP 401, congelando el bot de inmediato.

* **Pasos a seguir:**
  1. **Detener el Webhook (Hard Pause):**
     * Cambiar de inmediato el valor de `APP_SECRET` en el archivo `.env` o en la consola de variables de entorno de Vercel/Render/AWS.
     * Reiniciar el servidor Express para aplicar el cambio.
     * *(Alternativa de Infraestructura)*: Apagar por completo el servidor Express ejecutando `pm2 stop all`.
  2. **Activar Pausa de IA Global (Soft Pause):**
     Si se prefiere mantener la app encendida para que los operadores sigan chateando pero se necesita evitar a toda costa que la IA procese o emita respuestas de forma automática, ejecutar en la base de datos:
     ```sql
     UPDATE conversations 
     SET status = 'pausada_humano' 
     WHERE status = 'activa_ia';
     ```
  3. **Notificar a las Partes de Inmediato:**
     * Contactar a **Jose Manuel** (Líder Técnico) para el análisis de seguridad y contención del bug.
     * Notificar al **Dueño del Negocio Piloto** para informarle que el sistema automatizado está pausado por seguridad y que se pasará a modo de contingencia manual.
  4. **Rotación de Llaves y Credenciales:**
     * Cambiar las contraseñas y URLs de conexión de Supabase/PostgreSQL.
     * Rotar el token oficial de WhatsApp Cloud API en el portal de Meta Developers.
     * Generar un nuevo `JWT_SECRET` para invalidar todas las sesiones activas en la aplicación.
  5. **Cumplir con el Protocolo de Protección de Datos (Ley 29733):**
     * Ejecutar las fases de evaluación y reporte estipuladas en el [Protocolo de Incidentes de Seguridad](file:///d:/Proyectos/Chatbot%20Whatsapps/legal/procedimiento_incidentes_seguridad.md).
     * Preparar la notificación para la Autoridad Nacional de Protección de Datos Personales (ANPDP) en un plazo máximo de 48 horas si se confirma el leak.

---

## 🛠️ Cómo pausar todo el sistema en caso de Emergencia

Dependiendo de la gravedad de la situación, se pueden aplicar tres niveles de pausa:

### 1. Pausa de IA Global (Modo Humano Total)
*Ideal para cuando el bot está respondiendo mal de forma generalizada, pero queremos mantener los chats activos para atención humana.*

Ejecutar en la base de datos PostgreSQL:
```sql
-- Cambia todas las conversaciones de IA activa a pausa humana
UPDATE conversations 
SET status = 'pausada_humano', 
    sales_state = 'escalado_humano' 
WHERE status = 'activa_ia';
```
*Efecto: El webhook de WhatsApp seguirá recibiendo mensajes de los clientes y los guardará en la base de datos, pero la IA ignorará el procesamiento. Los operadores humanos podrán leer y responder de forma 100% manual desde el dashboard sin interferencia del bot.*

### 2. Bloqueo de Firma de Webhook (Fallo 401)
*Ideal para cuando sospechamos de un leak o ataque activo y queremos rechazar los mensajes inmediatamente sin apagar el servidor.*

Modificar en el archivo `.env`:
```env
# Cambiar el token o secret por un valor incorrecto o vacío
APP_SECRET=clave_invalida_de_emergencia
```
Luego reiniciar el backend.
*Efecto: El middleware de firma `verifySignature` rechazará el 100% de las peticiones de Meta WhatsApp devolviendo un código 401 Unauthorized. Meta dejará de enviar payloads y ningún mensaje ingresará a la base de datos.*

### 3. Apagado Físico del Servidor (Corte Total)
*Ideal si la base de datos o el backend están comprometidos.*

Ejecutar en la consola del servidor:
```bash
# Si se utiliza PM2
pm2 stop all

# Si se ejecuta mediante systemctl
sudo systemctl stop versato-backend

# Si se usa Docker Compose
docker-compose down
```
*Efecto: El sistema se apaga por completo. Meta recibirá errores de timeout (504) o conexión rechazada y encolará temporalmente los mensajes para reintentar después.*
