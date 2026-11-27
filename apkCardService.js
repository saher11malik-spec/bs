'use strict';
// Independent implementation derived from the APK classes:
// C1309d (SendBox), C1310e (CardSendConfig), C1306a (CardRoute),
// AbstractC1312g (GZIP + AES-GCM), and C1388O (OwnedCards parser).
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: false, parseTagValue: false, parseAttributeValue: false });
const KEY = Buffer.from(process.env.SENDBOX_AES_KEY || '', 'utf8');
const ENDPOINT = process.env.SENDBOX_ENDPOINT || 'https://township.playrix.com/api/1/SendBox?cityId=';
const DECODE_ENDPOINT = process.env.DECODE_ENDPOINT || 'https://soft-flower-4528.alklharq40.workers.dev/api/decode';
const DELAY = Number(process.env.CARD_SEND_DELAY_MS || 300);
const RETRIES = [1000, 2000];
const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
const str = v => v == null ? '' : String(v);
function walk(node, fn, seen = new Set()) { if (!node || typeof node !== 'object' || seen.has(node)) return; seen.add(node); fn(node); for (const value of Object.values(node)) for (const item of arr(value)) walk(item, fn, seen); }
function named(root, wanted) { let out = null; function visit(node) { if (!node || typeof node !== 'object' || out) return; if (wanted.includes(node['@_name'])) { out = node; return; } for (const [key, value] of Object.entries(node)) { if (wanted.includes(key)) { out = Array.isArray(value) ? value[0] : value; return; } for (const item of arr(value)) visit(item); } } visit(root); return out; }
function field(node, names) { if (Array.isArray(node)) { for (const item of node) { const value = field(item, names); if (value !== undefined) return value; } return undefined; } if (!node || typeof node !== 'object') return undefined; for (const n of names) if (node['@_' + n] !== undefined) return node['@_' + n]; for (const [key, value] of Object.entries(node)) { if (names.includes(key) && typeof value !== 'object') return value; for (const child of arr(value)) if (child && names.includes(child['@_name'])) return child['@_value'] ?? child['@_v'] ?? child['@_count']; } return undefined; }
function dataValue(root, names) { let out; walk(root, node => { if (out !== undefined) return; if (names.includes(node['@_name'])) out = node['@_value'] ?? node['@_v'] ?? node['@_version']; }); return out; }
async function decodeFileIfNeeded(content, filename = 'save.xml') {
  const text = str(content);
  if (/^\s*</.test(text)) return text;
  if (!DECODE_ENDPOINT) throw new Error(`encrypted ${filename} requires DECODE_ENDPOINT`);
  const response = await fetch(DECODE_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': filename }, body: Buffer.from(text, 'binary') });
  const raw = Buffer.from(await response.arrayBuffer());
  const decoded = raw.toString('utf8');
  if (!response.ok) throw new Error(`decode ${filename} failed HTTP ${response.status}: ${decoded.slice(0, 300)}`);
  if (!/^\s*</.test(decoded)) throw new Error(`decode ${filename} returned non-XML data`);
  return decoded;
}

function extractConfig(xml) {
  const root = parser.parse(xml);
  const aws = named(root, ['AWS']);
  const ver = named(root, ['Version']);
  const push = named(root, ['PushNotifDeviceInfo']);
  const ownCityId = str(field(aws, ['cityId']) ?? dataValue(root, ['cityId'])).trim();
  const ownToken = str(field(aws, ['token']) ?? dataValue(root, ['token'])).trim();
  const bver = str(field(ver, ['version']) || field(push, ['bver']) || dataValue(root, ['bver', 'Version'])).trim();
  const fver = str(field(ver, ['FVer']) || field(push, ['fver']) || dataValue(root, ['fver', 'FVer']) || (xml.match(/<Version\b[^>]*\bFVer="([^"]+)/i) || [])[1] || (xml.match(/<Var\b[^>]*\bname="FVer"[^>]*\bv="([^"]+)/i) || [])[1]).trim();
  const ownCityName = str(field(root, ['townName', 'cityName']) ?? dataValue(root, ['townName', 'cityName']) ?? 'bs');
  const ownPic = str(field(root, ['MyPicture', 'pic']) ?? dataValue(root, ['MyPicture', 'pic']) ?? 'ava0');
  if (!ownCityId || !ownToken || !bver || !fver) throw new Error('APK config missing: AWS.cityId/token or Version.version/FVer');
  return { ownCityId, ownToken, ownCityName, ownPic, bver, fver };
}
function extractFriends(xml) {
  const root = parser.parse(xml), result = [], seen = new Set();
  walk(root, node => {
    const id = str(node['@_city_id'] || node['@_cityId'] || node['@_friendId']).trim();
    if (!id || seen.has(id)) return;
    const name = str(node['@_friend_city_name'] || node['@_city_name'] || node['@_cityName'] || node['@_friendName'] || '');
    const pic = str(node['@_pic'] || node['@_picture'] || node['@_avatar'] || '');
    seen.add(id); result.push({ id, name, pic });
  });
  return result;
}
function extractCards(xml) {
  const root = parser.parse(xml), ownedNodes = [];
  walk(root, node => { if (node['@_name'] === 'OwnedCards') ownedNodes.push(node); });
  if (!ownedNodes.length) {
    const direct = named(root, ['OwnedCards']);
    if (direct) ownedNodes.push(direct);
  }
  if (!ownedNodes.length) throw new Error('CardCollections/DataLogic/OwnedCards not found');
  const cards = [], candidates = [];
  for (const owned of ownedNodes) walk(owned, node => {
    const cardId = str(field(node, ['cardId', 'card_id', 'id'])).trim();
    const rawCount = field(node, ['inStockCount', 'in_stock_count', 'count', 'quantity']);
    const count = Number(rawCount || 0);
    if (cardId) candidates.push({ cardId, rawCount: rawCount ?? null });
    if (cardId && Number.isFinite(count) && count > 0) cards.push({ cardId, count, generatedCount: Number(field(node, ['generatedCount']) || 0), maxInStockCount: Number(field(node, ['maxInStockCount']) || 0), isNew: str(field(node, ['isNew']) || 'false') });
  });
  const unique = new Map(); for (const c of cards) unique.set(c.cardId, c);
  return [...unique.values()];
}
function extractMeta(xml) { const root = parser.parse(xml); const n = named(root, ['DataLogic']) || root; return { totalSendCards: Number(field(n, ['totalSendCards']) || 0) }; }
function routeFor(xml, cardId) { const m = str(cardId).match(/^card_(\d+)$/i); const number = m ? Number(m[1]) : 1; const ids = [...xml.matchAll(/<DataElem\s+name="configId"\s+type="string"\s+value="CardCollections_(\d+)"/gi)].map(x => x[1]); const collectionId = ids[0] || ''; return { collectionId, setId: String(Math.floor((number - 1) / 10) + 1) }; }
function jsonPairs(pairs) { const out = {}; for (const [k, v] of pairs) out[k] = v; return JSON.stringify(out); }
function collectionExpiry(now = Math.floor(Date.now() / 1000)) { const base = Math.floor(now / 86400) * 86400; let t = base + 32400; if (t <= now) t = base + 118800; return t; }
function buildPayload(cfg, friend, cardId, route, counter, seed) {
  const from = jsonPairs([['city_id', cfg.ownCityId], ['friend_city_name', friend.name || cfg.ownCityName], ['pic', cfg.ownPic]]);
  const box = jsonPairs([['afg', 3], ['box_type', 'collections_send_card'], ['card_id', cardId], ['col_et', collectionExpiry()], ['col_id', route.collectionId], ['friend_type', 'send_friend'], ['from', from], ['seed', String(seed)], ['sendCounter', counter], ['set_id', route.setId], ['to', friend.id], ['type', 'box']]);
  return jsonPairs([['box', box], ['cityId', cfg.ownCityId], ['to_cityId', friend.id]]);
}
function encrypt(payload) {
  if (KEY.length !== 16) throw new Error('SENDBOX_AES_KEY must be exactly 16 UTF-8 bytes');
  const compressed = zlib.gzipSync(Buffer.from(payload, 'utf8')); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-128-gcm', KEY, iv); const body = Buffer.concat([cipher.update(compressed), cipher.final()]); const tag = cipher.getAuthTag();
  return { body, tsId: '002' + iv.toString('hex') + tag.toString('hex') };
}
function decrypt(tsId, body) { if (!/^002/i.test(tsId) || tsId.length !== 59) throw new Error('response ts-id invalid'); const iv = Buffer.from(tsId.slice(3, 27), 'hex'); const tag = Buffer.from(tsId.slice(27), 'hex'); const decipher = crypto.createDecipheriv('aes-128-gcm', KEY, iv); decipher.setAuthTag(tag); let out = Buffer.concat([decipher.update(body), decipher.final()]); if (out[0] === 0x1f && out[1] === 0x8b) out = zlib.gunzipSync(out); return out.toString('utf8'); }
async function sendOne(cfg, friend, cardId, route, counter) {
  const seed = crypto.randomInt(10000, 100000); const enc = encrypt(buildPayload(cfg, friend, cardId, route, counter, seed)); const url = ENDPOINT + encodeURIComponent(cfg.ownCityId);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'IsNewClanUIEnabled': 'true', 'User-Agent': `bs/${cfg.bver} (Android 13)`, 'ts-bp': 'g', 'ts-bver': cfg.bver, 'ts-fver': cfg.fver, 'ts-gpid': 'new', 'ts-id': enc.tsId, 'ts-token': cfg.ownToken, 'x-version': cfg.bver }, body: enc.body });
  const raw = Buffer.from(await response.arrayBuffer()); let decoded = '', parsed = null, decryptError = null; const responseTsId = response.headers.get('ts-id') || '';
  if (raw.length && responseTsId) try { decoded = decrypt(responseTsId, raw); try { parsed = JSON.parse(decoded); } catch {} } catch (e) { decryptError = e.message; }
  const accepted = response.status >= 200 && response.status < 300 && parsed && parsed.result && typeof parsed.result === 'object' && Object.keys(parsed.result).length === 0;
  return { cardId, collectionId: route.collectionId, setId: route.setId, sendCounter: counter, seed, httpStatus: response.status, accepted: Boolean(accepted), response: parsed, responseText: decoded || raw.toString('utf8'), decryptError };
}
async function sendWithRetry(cfg, friend, cardId, route, counter) { let last; for (let i = 0; i <= RETRIES.length; i++) { try { const r = await sendOne(cfg, friend, cardId, route, counter); if (r.accepted || r.httpStatus !== 403 || i === RETRIES.length) return r; } catch (e) { last = e; if (i === RETRIES.length) throw e; } if (i < RETRIES.length) await new Promise(resolve => setTimeout(resolve, RETRIES[i])); } throw last || new Error('send failed'); }
async function analyze({ friendsXml, cardsXml }) { const cfg = extractConfig(friendsXml); const friends = extractFriends(friendsXml); const cards = extractCards(cardsXml); return { game: { cityId: cfg.ownCityId, bver: cfg.bver, fver: cfg.fver }, friends, cards, distinctCards: cards.length, totalCopies: cards.reduce((n, c) => n + c.count, 0), meta: extractMeta(cardsXml) }; }
async function sendAll({ friendsXml, cardsXml, friendId, cardIds }) { const cfg = extractConfig(friendsXml); const friends = extractFriends(friendsXml); const friend = friends.find(x => x.id === str(friendId).trim()); if (!friend) throw new Error('friendId was not found in friends XML'); const inventory = extractCards(cardsXml); const ids = (Array.isArray(cardIds) && cardIds.length ? inventory.filter(c => cardIds.map(String).includes(c.cardId)) : inventory).map(c => c.cardId); if (!ids.length) throw new Error('no sendable cards found'); const start = extractMeta(cardsXml).totalSendCards; const results = []; for (let i = 0; i < ids.length; i++) { const route = routeFor(cardsXml, ids[i]); try { results.push(await sendWithRetry(cfg, friend, ids[i], route, start + i)); } catch (e) { results.push({ cardId: ids[i], accepted: false, error: e.message }); } if (i < ids.length - 1) await new Promise(resolve => setTimeout(resolve, DELAY)); } const accepted = results.filter(r => r.accepted); return { ok: accepted.length === results.length, friend, game: { cityId: cfg.ownCityId, bver: cfg.bver, fver: cfg.fver }, totalCards: results.length, sentCards: accepted.length, failed: results.length - accepted.length, totalSendCardsBefore: start, totalSendCardsAfter: start + results.length, results }; }
module.exports = { analyze, sendAll, decodeFileIfNeeded, extractConfig, extractFriends, extractCards, buildPayload, encrypt, decrypt };
