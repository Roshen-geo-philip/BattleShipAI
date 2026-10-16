import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (v: string | undefined) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : undefined);

const port = num(process.env.PORT) ?? 3001;
const rules = {
  ...(num(process.env.SETUP_SECONDS) !== undefined && { setupSeconds: num(process.env.SETUP_SECONDS) }),
  ...(num(process.env.TURN_SECONDS) !== undefined && { turnSeconds: num(process.env.TURN_SECONDS) }),
  ...(num(process.env.RECONNECT_GRACE_SECONDS) !== undefined && { reconnectGraceSeconds: num(process.env.RECONNECT_GRACE_SECONDS) }),
};

const { port: actual } = await startServer({
  port,
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  staticDir: process.env.STATIC_DIR ?? path.resolve(here, '../../client/dist'),
  rules,
});
console.log(`⚓ Battleship server listening on http://localhost:${actual}`);
