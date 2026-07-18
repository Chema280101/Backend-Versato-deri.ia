# Chatbot Whatsapps Backend (Fase 1)

Este proyecto inicializa el backend en Node.js y TypeScript para el Chatbot de Ventas y Postventa (WhatsApp Business Platform). Sigue las directrices definidas en [CONTEXT.md](CONTEXT.md).

## Requisitos Previos

- **Node.js**: v18 o superior recomendado.
- **npm**: v9 o superior.

## Instalación y Configuración

1. **Clonar/Abrir el repositorio** e instalar las dependencias:
   ```bash
   npm install
   ```

2. **Configurar las variables de entorno**:
   Copia el archivo de plantilla `.env.example` para crear tu `.env` local:
   ```bash
   cp .env.example .env
   ```
   *Nota: Ajusta los valores de las variables en `.env` según tu entorno local.*

## Scripts Disponibles

En el directorio del proyecto, puedes ejecutar los siguientes scripts:

### Desarrollo

Ejecuta el servidor en modo desarrollo con recarga automática (hot reload) utilizando `tsx`:
```bash
npm run dev
```
El servidor se levantará en el puerto configurado (por defecto: `http://localhost:3000`).

### Construcción (Build)

Compila el proyecto de TypeScript a JavaScript de producción en la carpeta `dist/`:
```bash
npm run build
```

### Producción

Inicia el servidor compilado para producción (asegúrate de correr `npm run build` primero):
```bash
npm run start
```

### Pruebas (Tests)

Ejecuta el set de pruebas unitarias y de integración utilizando `jest` y `supertest`:
```bash
npm run test
```

### Estilo de Código y Formateo

- **Verificar reglas de estilo (ESLint)**:
  ```bash
  npm run lint
  ```
- **Aplicar formato automático (Prettier)**:
  ```bash
  npm run format
  ```

## Estructura del Proyecto

```text
├── dist/                # Código compilado de producción (generado por build)
├── src/
│   ├── config/          # Carga y validación de variables de entorno
│   ├── routes/          # Definición de enrutadores y endpoints de Express
│   ├── services/        # Lógica de negocio y servicios externos (WhatsApp, etc.)
│   ├── tests/           # Pruebas automatizadas (Jest + Supertest)
│   ├── app.ts           # Configuración del app Express
│   └── index.ts         # Punto de entrada del servidor
├── .env.example         # Plantilla de variables de entorno
├── .eslintrc.json       # Configuración de ESLint
├── .prettierrc          # Configuración de Prettier
├── jest.config.js       # Configuración de Jest
└── tsconfig.json        # Configuración del compilador TypeScript
```

## Endpoints Disponibles

- **Health Check**: `GET /health`
  - Retorna un código `200 OK` si el servidor está en funcionamiento.
  - Ejemplo de respuesta:
    ```json
    {
      "status": "ok",
      "timestamp": "2026-07-16T17:47:11.000Z"
    }
    ```
