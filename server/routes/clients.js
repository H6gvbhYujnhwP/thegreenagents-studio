import { Router } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.get('/', requireAuth, (req, res) => {
  const clients = db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM campaigns WHERE client_id = c.id) as campaign_count,
      (SELECT status FROM campaigns WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_status,
      (SELECT created_at FROM campaigns WHERE client_id = c.id ORDER BY created_at DESC LIMIT 1) as last_run
    FROM clients c ORDER BY c.created_at DESC
  `).all();
  res.json(clients);
});

router.get('/:id', requireAuth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE client_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ ...client, campaigns });
});

router.post('/', requireAuth, upload.single('rag'), (req, res) => {
  const id = uuid();
  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = null;
  let rag_filename = null;

  if (req.file) {
    rag_filename = req.file.originalname;
    rag_content = req.file.buffer.toString('utf-8');
  }

  db.prepare(`
    INSERT INTO clients (id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
      supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode, rag_filename, rag_content);

  res.json({ id });
});

router.put('/:id', requireAuth, upload.single('rag'), (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });

  const { name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode } = req.body;

  let rag_content = client.rag_content;
  let rag_filename = client.rag_filename;

  if (req.file) {
    rag_filename = req.file.originalname;
    rag_content = req.file.buffer.toString('utf-8');
  }

  db.prepare(`
    UPDATE clients SET name=?, brand=?, website=?, supergrow_workspace_name=?, supergrow_workspace_id=?,
      supergrow_api_key=?, timezone=?, cadence=?, posting_identity=?, approval_mode=?,
      rag_filename=?, rag_content=?, updated_at=datetime('now')
    WHERE id=?
  `).run(name, brand, website, supergrow_workspace_name, supergrow_workspace_id,
    supergrow_api_key, timezone, cadence, posting_identity, approval_mode,
    rag_filename, rag_content, req.params.id);

  res.json({ ok: true });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE client_id = ?').run(req.params.id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
