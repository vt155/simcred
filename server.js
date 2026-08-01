require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════
const NOMADSPAY_TOKEN         = process.env.NOMADSPAY_TOKEN || '';
const NOMADSPAY_WEBHOOK_SECRET = process.env.NOMADSPAY_WEBHOOK_SECRET || '';
const NOMADSPAY_API_URL       = process.env.NOMADSPAY_API_URL || 'https://api.nomadspay.com';
const META_PIXEL_ID           = process.env.META_PIXEL_ID || '';
const META_CAPI_ACCESS_TOKEN  = process.env.META_CAPI_ACCESS_TOKEN || '';
const PIX_DISCOUNT_RATE       = 0; // sem desconto extra para PIX

// ═══════════════════════════════════════════════════════
//  PRODUCT CATALOG — preço server-side (anti-tampering)
// ═══════════════════════════════════════════════════════
const PRODUCT_CATALOG = {
  "seguro-prestamista": {
    description: "SimCred · Seguro Prestamista",
    unitPrice: 29.87
  }
};

// ═══════════════════════════════════════════════════════
//  PURCHASE EVENTS STORE (deduplicação)
// ═══════════════════════════════════════════════════════
const IS_VERCEL   = process.env.VERCEL === '1';
const DATA_DIR    = IS_VERCEL ? '/tmp' : path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'purchase_events.json');
let purchaseEvents = new Map();

function loadEvents() {
  try {
    if (fs.existsSync(EVENTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf-8'));
      purchaseEvents = new Map(Object.entries(data));
      console.log(`[Store] ${purchaseEvents.size} events loaded`);
    }
  } catch (e) {
    console.error('[Store] Error loading events:', e.message);
  }
}

function saveEvents() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(Object.fromEntries(purchaseEvents), null, 2));
  } catch (e) {
    console.error('[Store] Error saving events:', e.message);
  }
}

loadEvents();

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function generateUUID() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str.trim().toLowerCase()).digest('hex');
}

function computeTotal(unitPrice, qty, extraDiscount) {
  let subtotal = unitPrice * qty;
  if (extraDiscount) {
    if (extraDiscount.type === 'fixed') subtotal = Math.max(0, subtotal - extraDiscount.value);
    else subtotal = subtotal * (1 - extraDiscount.value / 100);
  }
  const discounted = subtotal * (1 - PIX_DISCOUNT_RATE);
  return Number(discounted.toFixed(2));
}

// NomadsPay API
async function nomadsRequest(method, endpoint, data) {
  const config = {
    method,
    url: `${NOMADSPAY_API_URL}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${NOMADSPAY_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (data) config.data = data;
  const res = await axios(config);
  return res.data;
}

// Webhook HMAC verification
function verifyWebhookSignature(rawBody, signature) {
  if (!signature) return false;
  const secrets = [NOMADSPAY_WEBHOOK_SECRET, NOMADSPAY_TOKEN].filter(Boolean);
  for (const secret of secrets) {
    const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest();
    if (hmac.toString('hex') === signature) return true;
    if (hmac.toString('base64') === signature) return true;
    if (hmac.toString('base64url') === signature) return true;
  }
  return false;
}

function getWebhookSignature(headers) {
  return headers['x-nomadspay-signature']
      || headers['x-nomadpay-signature']
      || headers['x-signature']
      || headers['x-webhook-signature']
      || null;
}

// Meta Conversions API
async function sendMetaCAPI(eventName, eventId, value, currency, userData, sourceUrl) {
  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    console.log('[Meta CAPI] Skipping — credentials not configured');
    return;
  }
  try {
    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: sourceUrl || '',
      action_source: 'website',
      user_data: {}
    };
    if (userData) {
      if (userData.email)  eventData.user_data.em = [sha256(userData.email)];
      if (userData.phone)  eventData.user_data.ph = [sha256(userData.phone)];
      if (userData.name) {
        const names = userData.name.trim().split(' ');
        eventData.user_data.fn = [sha256(names[0])];
        if (names.length > 1) eventData.user_data.ln = [sha256(names[names.length - 1])];
      }
      if (userData.fbp) eventData.user_data.fbp = userData.fbp;
      if (userData.fbc) eventData.user_data.fbc = userData.fbc;
    }
    if (value !== undefined) {
      eventData.custom_data = { currency: currency || 'BRL', value };
    }
    await axios.post(
      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events`,
      { data: [eventData] },
      { params: { access_token: META_CAPI_ACCESS_TOKEN }, headers: { 'Content-Type': 'application/json' } }
    );
    console.log(`[Meta CAPI] ${eventName} sent — event_id: ${eventId}`);
  } catch (e) {
    console.error('[Meta CAPI] Error:', e.response?.data || e.message);
  }
}

// Purchase event deduplication
function registerPurchaseEvent(chargeId, value, currency) {
  if (purchaseEvents.has(chargeId)) return purchaseEvents.get(chargeId);
  const event = {
    charge_id: chargeId,
    event_id: generateUUID(),
    value,
    currency: currency || 'BRL',
    capi_sent_at: null,
    created_at: new Date().toISOString()
  };
  purchaseEvents.set(chargeId, event);
  saveEvents();
  return event;
}

// ═══════════════════════════════════════════════════════
//  MIDDLEWARE
// ═══════════════════════════════════════════════════════
// Webhook MUST be before express.json() — needs raw body for HMAC
app.post('/api/public/webhooks/nomadspay', express.raw({ type: '*/*' }), handleWebhook);

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname, {
  extensions: ['html']
}));

// ═══════════════════════════════════════════════════════
//  PAGE ROUTES
// ═══════════════════════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
for (let i = 2; i <= 9; i++) {
  app.get(`/${i}`, (req, res) => res.sendFile(path.join(__dirname, `${i}`, 'index.html')));
}
app.get('/configurando-conta', (req, res) => res.sendFile(path.join(__dirname, 'configurando-conta', 'index.html')));
app.get('/conta',              (req, res) => res.sendFile(path.join(__dirname, 'conta', 'index.html')));

// ═══════════════════════════════════════════════════════
//  API — CREATE PAYMENT
// ═══════════════════════════════════════════════════════
app.post('/api/public/payments/create', async (req, res) => {
  try {
    const { sku, quantity = 1, discount_code, payer, metadata } = req.body;

    const product = PRODUCT_CATALOG[sku];
    if (!product) return res.status(400).json({ success: false, error: 'Produto não encontrado' });
    if (!payer || !payer.name || !payer.document) {
      return res.status(400).json({ success: false, error: 'Dados do pagador são obrigatórios (name, document)' });
    }

    const total = computeTotal(product.unitPrice, quantity, null);

    const chargeData = {
      amount: total,
      description: product.description,
      expiration: 3600,
      payer: {
        name: payer.name,
        document: String(payer.document).replace(/\D/g, '')
      },
      metadata: {
        sku,
        quantity,
        discount_code: discount_code || null,
        ...(metadata || {})
      }
    };

    const charge = await nomadsRequest('POST', '/charges', chargeData);
    console.log(`[Payment] Charge created: ${charge.id} — R$ ${total}`);

    res.json({
      success: true,
      charge: {
        id: charge.id,
        amount: charge.amount,
        status: charge.status,
        pix_code: charge.pix_code,
        created_at: charge.created_at,
        expires_at: charge.expires_at
      }
    });
  } catch (e) {
    console.error('[Payment] Create error:', e.response?.data || e.message);
    res.status(500).json({ success: false, error: 'Erro ao criar cobrança. Tente novamente.' });
  }
});

// ═══════════════════════════════════════════════════════
//  API — CHECK STATUS
// ═══════════════════════════════════════════════════════
app.get('/api/public/payments/status/:id', async (req, res) => {
  try {
    const charge = await nomadsRequest('GET', `/charges/${req.params.id}`);
    res.json({
      id: charge.id,
      status: charge.status,
      amount: charge.amount,
      paid_at: charge.paid_at || null
    });
  } catch (e) {
    console.error('[Payment] Status error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao consultar status' });
  }
});

// ═══════════════════════════════════════════════════════
//  API — PURCHASE EVENT (deduplicação + CAPI)
// ═══════════════════════════════════════════════════════
app.post('/api/public/payments/purchase-event', async (req, res) => {
  try {
    const { id, fbp, fbc, url } = req.body;
    if (!id) return res.status(400).json({ error: 'charge id required' });

    const charge = await nomadsRequest('GET', `/charges/${id}`);
    if (charge.status !== 'PAID') return res.json({ paid: false });

    const event = registerPurchaseEvent(id, charge.amount);

    if (!event.capi_sent_at) {
      const userData = { fbp, fbc, ...(charge.metadata || {}) };
      await sendMetaCAPI('Purchase', event.event_id, event.value, event.currency, userData, url);
      event.capi_sent_at = new Date().toISOString();
      purchaseEvents.set(id, event);
      saveEvents();
    }

    res.json({
      paid: true,
      event_id: event.event_id,
      value: event.value,
      currency: event.currency
    });
  } catch (e) {
    console.error('[Purchase Event] Error:', e.response?.data || e.message);
    res.status(500).json({ error: 'Erro ao registrar evento' });
  }
});

// ═══════════════════════════════════════════════════════
//  WEBHOOK — NOMADSPAY
// ═══════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  try {
    const rawBody = req.body;
    let payload;
    try { payload = JSON.parse(rawBody.toString()); }
    catch { return res.status(400).json({ error: 'Invalid JSON' }); }

    const eventType = payload.event || payload.type || '';

    // Bypass for connectivity test
    if (eventType === 'webhook.ping') {
      console.log('[Webhook] Ping received');
      return res.json({ success: true });
    }

    // Verify HMAC
    const signature = getWebhookSignature(req.headers);
    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('[Webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log(`[Webhook] Event: ${eventType}`);

    switch (eventType) {
      case 'charge.paid':
      case 'payment.paid': {
        const chargeId = payload.charge?.id || payload.data?.id || payload.id;
        const amount   = payload.charge?.amount || payload.data?.amount || payload.amount;
        if (chargeId && amount) {
          const event = registerPurchaseEvent(chargeId, amount);
          if (!event.capi_sent_at) {
            await sendMetaCAPI('Purchase', event.event_id, event.value, event.currency, {}, '');
            event.capi_sent_at = new Date().toISOString();
            purchaseEvents.set(chargeId, event);
            saveEvents();
          }
          console.log(`[Webhook] Purchase registered: ${chargeId}`);
        }
        break;
      }
      case 'payment.expired':
        console.log('[Webhook] Payment expired:', payload.charge?.id || payload.data?.id);
        break;
      case 'payment.cancelled':
        console.log('[Webhook] Payment cancelled:', payload.charge?.id || payload.data?.id);
        break;
      case 'withdrawal.paid':
      case 'withdrawal.failed':
        console.log(`[Webhook] ${eventType}:`, JSON.stringify(payload).substring(0, 200));
        break;
      default:
        console.log(`[Webhook] Unhandled: ${eventType}`);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
}

// ═══════════════════════════════════════════════════════
//  START (local dev only — Vercel uses the export)
// ═══════════════════════════════════════════════════════
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🟢 SimCred rodando em http://localhost:${PORT}`);
    console.log(`   NomadsPay API: ${NOMADSPAY_API_URL}`);
    console.log(`   Token configurado: ${NOMADSPAY_TOKEN ? '✅' : '❌'}`);
    console.log(`   Meta Pixel: ${META_PIXEL_ID ? '✅' : '❌'}\n`);
  });
}

module.exports = app;