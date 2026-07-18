import 'http';
import 'express';

declare module 'http' {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

declare global {
  namespace Express {
    interface Request {
      businessId?: number;
      userId?: number;
    }
  }
}
