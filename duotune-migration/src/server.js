import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import authRoutes from './routes/auth.js';
import youtubeRoutes from './routes/youtube.js';

const app = express();
const port = Number(process.env.PORT) || 3000;
const allowedOrigins = new Set(
  (process.env.DUOTUNE_ALLOWED_ORIGINS || 'https://duotune.vercel.app,http://localhost:3000,http://127.0.0.1:5500')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin are server-to-server/health checks.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by DuoTune API CORS policy.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'apikey', 'x-client-info'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '32kb', strict: true }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'duotune-api' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please wait a little and try again.' },
});
const youtubeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many YouTube requests. Wait a moment and try again.' },
});

app.use('/api/auth', loginLimiter, authRoutes);
app.use('/api/youtube', youtubeLimiter, youtubeRoutes);

app.use((req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((error, _req, res, _next) => {
  if (error.message?.includes('CORS')) return res.status(403).json({ error: error.message });
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Invalid JSON request body.' });
  }
  console.error('[server] unhandled error:', error);
  return res.status(500).json({ error: 'Unexpected API error.' });
});

app.listen(port, () => console.info(`[duotune-api] listening on port ${port}`));
