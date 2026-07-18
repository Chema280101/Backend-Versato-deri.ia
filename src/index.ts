import app from './app';
import { config } from './config';
import { initializeDatabase } from './services/db.service';
import { initSocketServer } from './services/socket.service';
import { startAlertScheduler } from './services/alert.service';

async function startServer() {
  try {
    // Initialize database tables
    await initializeDatabase();

    const server = app.listen(config.port, () => {
      console.log(
        `[INFO]: Server is running on port ${config.port} in ${
          config.isProduction ? 'production' : 'development'
        } mode.`,
      );
    });

    // Initialize Socket.io server
    initSocketServer(server);

    // Initialize Alert Scheduler for stagnant conversations
    startAlertScheduler();

    return server;
  } catch (error) {
    console.error(
      '[CRITICAL]: Server failed to start due to database initialization error:',
      error,
    );
    process.exit(1);
  }
}

const serverPromise = startServer();

export default serverPromise;
