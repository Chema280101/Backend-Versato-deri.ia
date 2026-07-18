import { Server as SocketIOServer, Socket } from 'socket.io';
import http from 'http';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { dbEvents } from './events.service';

let io: SocketIOServer | null = null;

export function initSocketServer(server: http.Server): SocketIOServer {
  io = new SocketIOServer(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Authentication Middleware
  io.use((socket: Socket, next) => {
    // Check various headers/query params/auth properties for JWT
    const authHeader =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization ||
      socket.handshake.query?.token;

    if (!authHeader || typeof authHeader !== 'string') {
      return next(new Error('Authentication error: Token is missing'));
    }

    let token = authHeader;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret) as {
        business_id: number;
        user_id: number;
      };

      if (!payload.business_id || !payload.user_id) {
        return next(new Error('Authentication error: Invalid token payload format'));
      }

      socket.data = {
        businessId: payload.business_id,
        userId: payload.user_id,
      };

      next();
    } catch {
      return next(new Error('Authentication error: Invalid or expired token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const businessId = socket.data.businessId;
    const roomName = `business_${businessId}`;

    console.log(
      `[SOCKET]: Client connected. User ID: ${socket.data.userId}, Business ID: ${businessId}. Joining room: ${roomName}`,
    );

    socket.join(roomName);

    socket.on('disconnect', () => {
      console.log(
        `[SOCKET]: Client disconnected. User ID: ${socket.data.userId}, Business ID: ${businessId}`,
      );
    });
  });

  return io;
}

export function getSocketServer(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.io server has not been initialized');
  }
  return io;
}

// Subscribe to database events
dbEvents.on('message_saved', (message) => {
  if (io && (message.sender === 'user' || message.generated_by === 'humano')) {
    const roomName = `business_${message.business_id}`;
    console.log(`[SOCKET]: Emitting 'nuevo_mensaje' to room: ${roomName}`);
    io.to(roomName).emit('nuevo_mensaje', message);
  }
});

dbEvents.on('conversation_updated', (conversation) => {
  if (io) {
    const roomName = `business_${conversation.business_id}`;
    console.log(`[SOCKET]: Emitting 'conversacion_actualizada' to room: ${roomName}`);
    io.to(roomName).emit('conversacion_actualizada', conversation);
  }
});
