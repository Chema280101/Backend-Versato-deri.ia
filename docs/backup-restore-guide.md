# Guía de Backups y Procedimiento de Restauración de Base de Datos

Esta guía detalla la configuración de backups automáticos y los procedimientos manuales de copia de seguridad y restauración del Chatbot WhatsApps.

---

## 1. Configuración de Backups Automáticos

El servidor backend incluye un servicio programador de backups automáticos diarios (`src/services/backup.service.ts`). Este servicio se ejecuta al arrancar el servidor y realiza un chequeo cada hora. Si detecta que no se ha realizado ninguna copia de seguridad para el día actual del calendario, genera un dump completo de la base de datos de manera automatizada.

### Variables de Entorno (.env)
Los backups se configuran mediante las siguientes variables en el archivo `.env`:

*   `BACKUP_ENABLED`: Define si el programador de backups automáticos está activo (`true` / `false`).
*   `BACKUP_DIRECTORY`: Directorio del sistema donde se guardan los archivos `.sql` (por defecto: `backups`).
*   `BACKUP_RETENTION_DAYS`: Número de días de retención de copias de seguridad (por defecto: `7`). El script elimina automáticamente los archivos más antiguos cuando se supera este límite.
*   `PG_DUMP_PATH` *(Opcional)*: Ruta absoluta al binario `pg_dump` o `pg_dump.exe`. Si no se define, en Windows intentará buscar automáticamente instalaciones estándar de PostgreSQL 15 a 18 en `C:\Program Files\PostgreSQL`.
*   `PSQL_PATH` *(Opcional)*: Ruta absoluta al binario `psql` o `psql.exe` utilizado en el script de restauración.

---

## 2. Procedimiento para Generar un Backup Manual

Si necesitas realizar un backup inmediato (por ejemplo, antes de aplicar una migración o realizar un mantenimiento):

1.  Asegúrate de que tus credenciales de base de datos están configuradas correctamente en el archivo `.env`.
2.  Ejecuta el script de backup manual con el siguiente comando:
    ```bash
    npx tsx scripts/backup.ts
    ```
3.  El script generará un archivo SQL plano en la carpeta configurada (por defecto `backups/`), nombrado con la fecha y hora actual en formato ISO seguro para nombres de archivos:
    ```
    backups/backup-YYYY-MM-DD_HH-mm-ss.sql
    ```

> [!NOTE]
> El archivo SQL generado utiliza los flags `--clean` e `--if-exists`, lo que permite que al restaurarse elimine de manera segura las tablas preexistentes antes de recrearlas, evitando conflictos de duplicidad de llaves. Además, incluye `--no-owner` y `--no-privileges` para facilitar su restauración en servidores con roles de usuario diferentes.

---

## 3. Procedimiento de Restauración

### Método A: Usando el Script del Proyecto (Recomendado)
El proyecto incluye un script en TypeScript (`scripts/restore.ts`) que automatiza el proceso de restauración:

1.  **Restaurar en la base de datos configurada en `.env`:**
    ```bash
    npx tsx scripts/restore.ts backups/backup-YYYY-MM-DD_HH-mm-ss.sql
    ```
2.  **Restaurar en una base de datos específica (por ejemplo, un entorno de desarrollo o pruebas local):**
    ```bash
    npx tsx scripts/restore.ts backups/backup-YYYY-MM-DD_HH-mm-ss.sql "postgresql://usuario:contraseña@localhost:5432/mi_base_de_datos"
    ```
3.  **Restaurar recreando completamente la base de datos desde cero:**
    El parámetro `--recreate` se conecta primero a la base de datos del sistema (`postgres`), cierra de forma segura todas las conexiones activas al base de datos destino, la elimina (`DROP DATABASE`) y la crea limpia (`CREATE DATABASE`) antes de aplicar el backup:
    ```bash
    npx tsx scripts/restore.ts backups/backup-YYYY-MM-DD_HH-mm-ss.sql "postgresql://usuario:contraseña@localhost:5432/mi_base_de_datos" --recreate
    ```

---

### Método B: Usando la Consola con `psql` (Estándar de PostgreSQL)
Si no tienes el entorno de desarrollo de Node instalado y necesitas restaurar directamente con utilidades del sistema:

1.  Abre una consola o PowerShell.
2.  Ejecuta el comando `psql` apuntando a tu base de datos de destino y al archivo de backup:
    ```bash
    psql -h <host_db> -p <puerto> -U <usuario> -d <nombre_db> -f backups/backup-YYYY-MM-DD_HH-mm-ss.sql
    ```
3.  El sistema solicitará la contraseña del usuario de base de datos antes de proceder.

---

### Método C: Usando pgAdmin (Interfaz Gráfica)
Si prefieres una interfaz visual:

1.  Abre **pgAdmin** y conéctate al servidor de base de datos.
2.  Haz clic derecho sobre la base de datos de destino y selecciona **Query Tool** (Herramienta de Consultas).
3.  Haz clic en el icono de carpeta **Open File** (Abrir archivo) y selecciona tu archivo de backup SQL (ej. `backup-YYYY-MM-DD_HH-mm-ss.sql`).
4.  Haz clic en el botón de **Play / Execute** (Ejecutar - F5).
5.  Revisa la pestaña **Messages** en la parte inferior para verificar que las sentencias se ejecutaron correctamente.

---

## 4. Plan de Contingencia ante Fallos de Producción

Si la base de datos de producción sufre una pérdida de datos o corrupción:

1.  **Pausar el chatbot**: Detén temporalmente el tráfico de webhooks (desactivando la app en el portal de Meta o deteniendo el servidor web) para evitar que entren nuevos mensajes mientras se realiza la restauración.
2.  **Identificar el backup más reciente**: Accede al almacenamiento de backups y localiza el archivo más reciente que sea válido.
3.  **Proveer una nueva base de datos limpia**: Si el servidor de base de datos actual está corrupto, crea una base de datos PostgreSQL vacía (en Supabase, AWS RDS, o similar).
4.  **Actualizar variables**: Modifica la variable `DATABASE_URL` en las variables de entorno del servidor (ej. Render dashboard) para apuntar a la nueva base de datos.
5.  **Restaurar el backup**: Ejecuta la restauración utilizando cualquiera de los métodos anteriores sobre la nueva URL de la base de datos.
6.  **Verificar y reanudar**: Realiza pruebas de conexión al backend, asegúrate de que el panel de administración carga los datos y luego reactiva la recepción de webhooks de WhatsApp.
