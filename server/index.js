import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import campaignRoutes from './routes/campaigns.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie-session: auth state lives in a signed cookie.
// No server-side storage — works across all restarts and redeploys instantly.
app.use(cookieSession({
  name: 'gsa',
  secret: process.env.SESSION_SECRET || 'greenagents-fallback-secret',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax'
}));

app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/campaigns', campaignRoutes);

const distPath = join(__dirname, '../dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Green Agents Studio running on port ${PORT}`);
  console.log(`[env] SUPERGROW_MCP_URL: ${process.env.SUPERGROW_MCP_URL ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] STUDIO_PASSWORD:   ${process.env.STUDIO_PASSWORD ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] OPENAI_API_KEY:     ${(process.env.OPENAI_API_KEY || process.env.OPENAI_AI_KEY) ? 'SET ✓' : 'MISSING ✗'} ${process.env.OPENAI_AI_KEY && !process.env.OPENAI_API_KEY ? '(using OPENAI_AI_KEY)' : ''}`);
  console.log(`[env] DB_PATH: ${process.env.DB_PATH || '(default)'}`);
});
