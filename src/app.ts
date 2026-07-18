import express from 'express';
import { config } from './config';
import healthRouter from './routes/health.routes';
import webhookRouter from './routes/webhook.routes';
import catalogRouter from './routes/catalog.routes';
import authRouter from './routes/auth.routes';
import conversationsRouter from './routes/conversations.routes';
import adminRouter from './routes/admin.routes';
import metricsRouter from './routes/metrics.routes';

const app = express();

// Middlewares
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// CORS Middleware
const allowedOrigins = config.isProduction
  ? [
      'https://app.versato.com.pe',
      'https://versato.com.pe',
      process.env.FRONTEND_URL, // escape hatch por si el dominio cambia
    ].filter(Boolean) as string[]
  : ['http://localhost:5173', 'http://localhost:3001', 'http://localhost:3000'];

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!config.isProduction || allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
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

export default app;
