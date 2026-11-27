const express = require('express');
const Busboy = require('busboy');
const fs = require('node:fs/promises');
const { port, maxUploadBytes, jwtSecret } = require('./config');
const { saveUpload, getUpload } = require('./store');
const { extractCityId, extractCards } = require('./xml');
const apkCardService = require('./apkCardService');
const app = express();
app.use(express.json({ limit: maxUploadBytes }));
function auth(req, res, next) { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); if (!token) return res.status(401).json({ error: 'missing bearer token' }); if (token !== jwtSecret) return res.status(403).json({ error: 'invalid token' }); next(); }
app.get('/health', (_, res) => res.json({ ok: true, service: 'bs-card-server', serverTime: new Date().toISOString() }));
app.use((err, req, res, next) => {
  if (err && err instanceof SyntaxError && err.status === 400 && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid JSON request: ' + err.message });
  return next(err);
});
app.get('/api/cards/health', auth, (_, res) => res.json({ ok: true, service: 'apk-card-service' }));
app.post('/api/cards/analyze-files', auth, async (req, res) => {
  try { const friendsXml = await apkCardService.decodeFileIfNeeded(req.body.friendsXml, 'bs.xml'); const cardsXml = await apkCardService.decodeFileIfNeeded(req.body.cardsXml, 'my.xml'); return res.json({ ok: true, ...(await apkCardService.analyze({ friendsXml, cardsXml })) }); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/cards/send-all', auth, async (req, res) => {
  try { const friendsXml = await apkCardService.decodeFileIfNeeded(req.body.friendsXml, 'bs.xml'); const cardsXml = await apkCardService.decodeFileIfNeeded(req.body.cardsXml, 'my.xml'); return res.json(await apkCardService.sendAll({ friendsXml, cardsXml, friendId: req.body.friendId, cardIds: req.body.cardIds })); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/uploads', auth, (req, res) => {
  const bb = Busboy({ headers: req.headers, limits: { fileSize: maxUploadBytes, files: 1 } }); let chunks = []; let filename = 'save.xml'; let tooLarge = false;
  bb.on('file', (_, stream, info) => { filename = info.filename; stream.on('data', c => chunks.push(c)); stream.on('limit', () => { tooLarge = true; }); });
  bb.on('finish', async () => { try { if (tooLarge) return res.status(413).json({ error: 'file too large' }); const buffer = Buffer.concat(chunks); if (!buffer.length) return res.status(400).json({ error: 'file is required' }); const saved = await saveUpload(buffer, filename); const xml = buffer.toString('utf8'); res.status(201).json({ uploadId: saved.id, filename: saved.name, cityId: extractCityId(xml), cards: extractCards(xml) }); } catch (e) { res.status(400).json({ error: e.message }); } }); req.pipe(bb);
});
app.get('/api/uploads/:id/cards', auth, async (req, res) => { try { const file = await getUpload(req.params.id); if (!file) return res.status(404).json({ error: 'upload not found' }); const xml = await fs.readFile(file, 'utf8'); res.json({ uploadId: req.params.id, cityId: extractCityId(xml), cards: extractCards(xml) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.listen(port, () => console.log(`bs-card-server listening on :${port}`));
module.exports = app;
