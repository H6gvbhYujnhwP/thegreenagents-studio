import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import authRoutes     from './routes/auth.js';
import clientRoutes   from './routes/clients.js';
import campaignRoutes from './routes/campaigns.js';
import emailRoutes    from './routes/email.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use('/api/auth',      authRoutes);
app.use('/api/clients',   clientRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/email',     emailRoutes);

const distPath = join(__dirname, '../dist');
app.use(express.static(distPath));
app.get('*', (req, res) => res.sendFile(join(distPath, 'index.html')));

app.listen(PORT, () => {
  console.log(`Green Agents Studio running on port ${PORT}`);
  console.log(`[env] SUPERGROW_MCP_URL:     ${process.env.SUPERGROW_MCP_URL                             ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] ANTHROPIC_API_KEY:     ${process.env.ANTHROPIC_API_KEY                             ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] STUDIO_PASSWORD:       ${process.env.STUDIO_PASSWORD                               ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] OPENAI_API_KEY:        ${(process.env.OPENAI_API_KEY||process.env.OPENAI_AI_KEY)   ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] AWS_ACCESS_KEY_ID:     ${process.env.AWS_ACCESS_KEY_ID                             ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] AWS_SECRET_ACCESS_KEY: ${process.env.AWS_SECRET_ACCESS_KEY                         ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`[env] AWS_SES_REGION:        ${process.env.AWS_SES_REGION || 'eu-north-1 (default)'}`);
  console.log(`[env] SES_CONFIGURATION_SET: ${process.env.SES_CONFIGURATION_SET || 'NOT SET (account default config set will apply)'}`);
  console.log(`[env] DB_PATH:               ${process.env.DB_PATH || '(default)'}`);
});
