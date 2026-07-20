import express from 'express';
import cors from 'cors';
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

const allowedOrigins = [
  'https://app.versato.com.pe',
  'https://versato.com.pe',
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

const isAllowedOrigin = (origin: string): boolean => {
  if (!origin) return true;
  if (!config.isProduction) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(origin)) return true;
  if (/^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app\/?$/.test(origin)) return true;
  if (/^https:\/\/([a-zA-Z0-9-]+\.)*versato\.com\.pe\/?$/.test(origin)) return true;
  return false;
};

// 1. CORS Middleware (Must be FIRST)
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    optionsSuccessStatus: 204,
  }),
);

// 2. Body Parser Middleware
app.use(
  express.json({
    limit: '15mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

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
