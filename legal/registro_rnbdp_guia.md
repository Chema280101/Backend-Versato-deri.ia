# Guía de Registro de Bancos de Datos Personales (RNBDP)
**Versato — Cumplimiento Ley N° 29733 (Perú)**

Este documento contiene las directrices, parámetros y pasos detallados para realizar el registro obligatorio de los bancos de datos personales de **Versato** ante la Autoridad Nacional de Protección de Datos Personales (ANPDP) del Ministerio de Justicia y Derechos Humanos (MINJUS), utilizando la plataforma digital **SIPDP** (Sistema del Registro Nacional de Bancos de Datos Personales).

El registro es **gratuito y obligatorio** antes de iniciar cualquier recopilación o tratamiento de datos reales.

---

## 1. Bancos de Datos que debe registrar Versato (como Responsable)

Versato es el **Responsable del Tratamiento** (dueño) de dos bancos de datos principales necesarios para la operación comercial y el soporte de la plataforma:

### Banco de Datos A: "Usuarios y Clientes de la Plataforma"
* **Descripción:** Contiene los datos de contacto, facturación e inicio de sesión de los operadores y administradores de las empresas que contratan Versato.
* **Finalidad:** Gestión del servicio SaaS, facturación, soporte técnico, control de acceso multi-tenant y envío de comunicaciones operativas y comerciales del servicio.
* **Categorías de datos a declarar:**
  * Datos identificativos (nombres, apellidos, número de documento de identidad).
  * Datos de contacto (correo electrónico, teléfono móvil, dirección laboral).
  * Datos financieros/comerciales (RUC, razón social, historial de pagos, planes contratados).
  * Datos de seguridad (credenciales hash, logs de acceso, IPs de sesión).
* **Medidas de Seguridad:** Nivel de seguridad **Medio** (según directiva de seguridad de la ANPDP). Cifrado HTTPS en tránsito, control de acceso restringido a base de datos mediante roles y hashing bcrypt para contraseñas.
* **Tiempo de Conservación:** Duración de la relación contractual más cinco (5) años adicionales por obligaciones de auditoría tributaria y legal.

### Banco de Datos B: "Prospectos, Lead y Contacto"
* **Descripción:** Contiene los datos de las personas que solicitan demostraciones o información a través de formularios en la web oficial o canales de contacto comercial.
* **Finalidad:** Gestión de solicitudes de información, prospección comercial, marketing propio de Versato y seguimiento de ventas.
* **Categorías de datos a declarar:** Nombres, correo electrónico, número telefónico y empresa.
* **Medidas de Seguridad:** Nivel de seguridad **Básico**. Cifrado de comunicaciones y control de acceso del personal de ventas.
* **Tiempo de Conservación:** Dos (2) años o hasta que el titular de los datos revoque su consentimiento.

---

## 2. Procedimiento de Registro en SIPDP paso a paso

El procedimiento se realiza de forma digital a través del portal de la ANPDP:

1. **Acceso a la plataforma:**
   * Ingresar a la plataforma SIPDP: [https://sipdp.minjus.gob.pe/](https://sipdp.minjus.gob.pe/)
   * Registrar una cuenta de usuario usando la Clave SOL de la empresa (o mediante DNI del representante legal si es persona natural).
2. **Crear Solicitud de Registro de Banco de Datos:**
   * Seleccionar la opción **"Inscribir Banco de Datos"**.
   * Indicar la denominación (ej. *“Usuarios de la Plataforma Versato”*).
   * Clasificar el tipo de administración como **"Privada"**.
3. **Completar Formulario Técnico:**
   * **Identificación del Responsable:** RUC y Razón Social de Versato.
   * **Ubicación del Banco de Datos:** Declarar que está alojado en servidores en la nube de **Vercel / Supabase (Amazon Web Services)** ubicados físicamente en Virginia, EE. UU. (esto activará la sección de *Transferencia Internacional*).
   * **Detalle de Datos Personales:** Marcar los checks de las categorías de datos descritas en la sección 1 (Identificativos, de contacto, de seguridad, etc.).
   * **Medidas de Seguridad:** Declarar la implementación de políticas de privacidad, contraseñas seguras, cifrado de tráfico y registro de operaciones.
4. **Declaración de Transferencia Internacional (Flujo Transfronterizo):**
   * Dado que los servidores están fuera de Perú, se debe declarar la transferencia transfronteriza:
     * **Destinatario:** Supabase, Inc. (Base de datos) / Vercel, Inc. (Alojamiento Frontend y Funciones Serverless).
     * **País:** Estados Unidos.
     * **Finalidad:** Almacenamiento, respaldo y procesamiento técnico del servicio.
     * **Garantía Legal:** Cláusulas Contractuales Estándar (Standard Contractual Clauses) firmadas con los proveedores.
5. **Firmar y Enviar:**
   * Revisar el borrador generado en PDF, firmarlo digitalmente (o mediante los mecanismos provistos por SIPDP) y enviarlo.
   * La ANPDP emitirá una resolución con el número de registro en un plazo de hasta 30 días hábiles. Este número de registro debe incluirse en la Política de Privacidad una vez emitido.

---

## 3. ¿Qué deben hacer los Clientes de Versato (Tenants)?

Versato **NO** es el Responsable del Tratamiento de los datos de los clientes finales que conversan por WhatsApp con cada negocio piloto. Versato actúa como **Encargado del Tratamiento**.

Cada negocio piloto (Tenant) es el **Responsable del Tratamiento** de su propia base de datos de clientes de WhatsApp. Por lo tanto, el negocio piloto debe:
1. Registrar su propio banco de datos de clientes/conversaciones en el RNBDP.
2. Declarar a **Versato** como **Encargado del Tratamiento**.
3. Declarar la transferencia internacional de datos, ya que la infraestructura de Versato y de Meta (WhatsApp) están fuera de Perú.

### Información que Versato debe proveer al Cliente para su Registro RNBDP:

Para que el negocio piloto registre correctamente su base de datos, Versato le entregará la siguiente información para que la complete en el formulario de SIPDP:

* **Detalles del Encargado del Tratamiento:**
  * **Razón Social:** [Nombre Legal / Razón Social de Versato]
  * **RUC:** [Número de RUC]
  * **Dirección:** [Dirección Legal]
  * **Servicio prestado:** Plataforma SaaS de automatización conversacional y soporte por WhatsApp API.
* **Detalles de Transferencia Transfronteriza (Subencargados indirectos):**
  * **Proveedor de Alojamiento y DB:** Supabase Inc. / Vercel Inc. (EE. UU.) - Finalidad: Almacenamiento de logs y logs de mensajería cifrados.
  * **Proveedor de Canal Conversacional:** Meta Platforms, Inc. (EE. UU. e Irlanda) - Finalidad: Enrutamiento y entrega de mensajes por la API de WhatsApp Business.
  * **Proveedor de Inteligencia Artificial:** OpenAI LLC / Anthropic PBC (EE. UU.) - Finalidad: Procesamiento del motor conversacional *deri.ia* mediante API.
  * **Garantías de seguridad aplicadas:** Aislamiento lógico multi-tenant completo, no-reutilización de datos de los chats para el entrenamiento de los LLMs del proveedor, y acuerdos de procesamiento de datos con cláusulas contractuales estándar.
