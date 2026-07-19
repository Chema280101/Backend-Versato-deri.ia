import express from 'express';
import { config } from './config';
import healthRouter from './routes/health.routes';
import webhookRouter from './routes/webhook.routes';
import catalogRouter from './routes/catalog.routes';
import authRouter from './routes/auth.routes';
import conversationsRouter from './routes/conversations.routes';
import adminRouter from './routes/admin.routes';
import metricsRouter from './routes/metrics.routes';
import businessRouter from './routes/business.routes';

const app = express();

// Middlewares
app.use(
  express.json({
    limit: '15mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// CORS Middleware
const allowedOrigins = [
  'https://app.versato.com.pe',
  'https://versato.com.pe',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return false;
  if (!config.isProduction) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Permitir subdominios de vercel.app (despliegues de preview y producción en Vercel)
  if (/^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/.test(origin)) return true;
  // Permitir subdominios de versato.com.pe
  if (/^https:\/\/([a-zA-Z0-9-]+\.)*versato\.com\.pe$/.test(origin)) return true;
  return false;
};

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Routes
app.use(healthRouter);
app.use(webhookRouter);
app.use(catalogRouter);
app.use(authRouter);
app.use(conversationsRouter);
app.use(metricsRouter);
app.use(adminRouter);
app.use(businessRouter);

export default app;
