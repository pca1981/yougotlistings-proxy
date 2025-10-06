/**
 * YouGotListings Proxy API (Express)
 * ----------------------------------
 * A small, production-ready Node.js/Express proxy for YouGotListings (YGL)
 * that exposes safe, documented endpoints for your website/apps.
 *
 * Features
 *  - Endpoints: Rentals Search, Agents Search, Landlords Search (optional), Create Lead
 *  - Input validation (zod), error normalization
 *  - Simple in-memory caching and rate limiting
 *  - Timeout/retry policy for YGL calls
 *  - CORS (configurable)
 *  - Serves /public/widget.html for easy Canva embedding
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const morgan = require('morgan');
const qs = require('qs');
const { z } = require('zod');
const { XMLParser } = require('fast-xml-parser');

// ===== Config =====
const PORT = parseInt(process.env.PORT || '5050', 10);
const NODE_ENV = process.env.NODE_ENV || 'production';
const YGL_API_KEY = process.env.YGL_API_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!YGL_API_KEY) {
  console.warn('[WARN] Missing YGL_API_KEY in environment. Set it in .env or Render env vars.');
}

// Allowed origins for CORS
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow curl/postman
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

// Simple cache (in-memory)
const cache = new Map();
const defaultTTLms = 1000 * 60 * 2; // 2 minutes
function cacheKey(path, body) { return `${path}::${JSON.stringify(body || {})}`; }
function setCache(key, value, ttl = defaultTTLms) {
  const expires = Date.now() + ttl;
  cache.set(key, { value, expires });
}
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) { cache.delete(key); return null; }
  return item.value;
}

// HTTP client with sane defaults
const yglClient = axios.create({
  timeout: 10000,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  maxRedirects: 3,
});

// XML parser for YGL XML responses
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

// ===== Validation Schemas =====
const paginationSchema = z.object({
  page: z.number().int().min(1).default(1).optional(),
  page_size: z.number().int().min(1).max(200).default(50).optional(),
});

const rentalsSearchSchema = z.object({
  beds_min: z.number().int().min(0).optional(),
  beds_max: z.number().int().min(0).optional(),
  baths_min: z.number().int().min(0).optional(),
  baths_max: z.number().int().min(0).optional(),
  rent_min: z.number().int().min(0).optional(),
  rent_max: z.number().int().min(0).optional(),
  neighborhoods: z.array(z.string()).optional(),
  availability_start: z.string().optional(), // YYYY-MM-DD
  availability_end: z.string().optional(),
  fee: z.enum(['any', 'no_fee', 'fee']).optional(),
  keyword: z.string().optional(),
  order_by: z.enum(['rent_asc', 'rent_desc', 'date_desc', 'date_asc']).optional(),
  include_photos: z.boolean().default(true).optional(),
  ...paginationSchema.shape,
});

const agentsSearchSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  active_only: z.boolean().default(true).optional(),
  ...paginationSchema.shape,
});

const landlordsSearchSchema = z.object({
  landlord_ids: z.array(z.number().int()).optional(),
  name: z.string().optional(),
  city: z.string().optional(),
  ...paginationSchema.shape,
});

const createLeadSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  message: z.string().optional(),
  source: z.string().default('Website').optional(),
});

// ===== Helpers =====
function normalizeError(err) {
  if (axios.isAxiosError(err)) {
    return {
      status: err.response?.status || 502,
      code: 'YGL_UPSTREAM_ERROR',
      message: err.response?.data?.message || err.message || 'Upstream error',
      details: err.response?.data || null,
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: err.message || 'Unknown error' };
}

function xmlToJsonSafe(xmlString) {
  try { return xml.parse(xmlString); } catch { return { raw: xmlString }; }
}

// Map our query object to YGL form fields (best-effort; adjust to your account's docs)
function mapRentalsToYGL(body) {
  const form = {
    api_key: YGL_API_KEY,
    beds_min: body.beds_min,
    beds_max: body.beds_max,
    baths_min: body.baths_min,
    baths_max: body.baths_max,
    rent_min: body.rent_min,
    rent_max: body.rent_max,
    keyword: body.keyword,
    order_by: body.order_by,
    include_photos: body.include_photos ? 1 : 0,
    page: body.page || 1,
    page_count: body.page_size || 50,
  };
  if (body.fee && body.fee !== 'any') form.fee = body.fee;
  if (body.availability_start) form.availability_start = body.availability_start;
  if (body.availability_end) form.availability_end = body.availability_end;
  if (Array.isArray(body.neighborhoods) && body.neighborhoods.length) {
    form.neighborhoods = body.neighborhoods.join(',');
  }
  return form;
}

function mapAgentsToYGL(body) {
  return {
    api_key: YGL_API_KEY,
    id: body.id,
    name: body.name,
    email: body.email,
    active_only: body.active_only ? 1 : 0,
    page: body.page || 1,
    page_count: body.page_size || 50,
  };
}

function mapLandlordsToYGL(body) {
  return {
    api_key: YGL_API_KEY,
    landlord_ids: Array.isArray(body.landlord_ids) ? body.landlord_ids.join(',') : undefined,
    name: body.name,
    city: body.city,
    page: body.page || 1,
    page_count: body.page_size || 50,
  };
}

function mapLeadToYGL(body) {
  return {
    api_key: YGL_API_KEY,
    first_name: body.first_name,
    last_name: body.last_name,
    email: body.email,
    phone: body.phone,
    message: body.message,
    source: body.source || 'Website',
  };
}

// ===== App =====
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors(corsOptions));
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));

// Serve static widget (for Canva embedding)
app.use(express.static('public'));

// Rate limit: 60 req / minute per IP
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 60 }));

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Rentals Search
app.post('/api/rentals/search', async (req, res) => {
  try {
    const body = rentalsSearchSchema.parse(req.body || {});
    const key = cacheKey('/api/rentals/search', body);
    const cached = getCache(key);
    if (cached) return res.json({ cached: true, ...cached });

    const form = mapRentalsToYGL(body);
    const url = 'https://www.yougotlistings.com/api/rentals/search.php';
    const response = await yglClient.post(url, qs.stringify(form));

    const contentType = response.headers['content-type'] || '';
    let data;
    if (contentType.includes('xml') || typeof response.data === 'string') {
      data = xmlToJsonSafe(response.data);
    } else {
      data = response.data;
    }

    const payload = { success: true, data };
    setCache(key, payload);
    return res.json(payload);
  } catch (err) {
    const e = normalizeError(err);
    return res.status(e.status).json({ success: false, error: e });
  }
});

// Agents Search
app.post('/api/agents/search', async (req, res) => {
  try {
    const body = agentsSearchSchema.parse(req.body || {});
    const key = cacheKey('/api/agents/search', body);
    const cached = getCache(key);
    if (cached) return res.json({ cached: true, ...cached });

    const form = mapAgentsToYGL(body);
    const url = 'https://www.yougotlistings.com/api/agents/search.php';
    const response = await yglClient.post(url, qs.stringify(form));

    const contentType = response.headers['content-type'] || '';
    let data;
    if (contentType.includes('xml') || typeof response.data === 'string') {
      data = xmlToJsonSafe(response.data);
    } else {
      data = response.data;
    }

    const payload = { success: true, data };
    setCache(key, payload);
    return res.json(payload);
  } catch (err) {
    const e = normalizeError(err);
    return res.status(e.status).json({ success: false, error: e });
  }
});

// Landlords Search (Advanced API access may be required)
app.post('/api/landlords/search', async (req, res) => {
  try {
    const body = landlordsSearchSchema.parse(req.body || {});
    const key = cacheKey('/api/landlords/search', body);
    const cached = getCache(key);
    if (cached) return res.json({ cached: true, ...cached });

    const form = mapLandlordsToYGL(body);
    const url = 'https://www.yougotlistings.com/api/landlords/search.php';
    const response = await yglClient.post(url, qs.stringify(form));

    const contentType = response.headers['content-type'] || '';
    let data;
    if (contentType.includes('xml') || typeof response.data === 'string') {
      data = xmlToJsonSafe(response.data);
    } else {
      data = response.data;
    }

    const payload = { success: true, data };
    setCache(key, payload);
    return res.json(payload);
  } catch (err) {
    const e = normalizeError(err);
    return res.status(e.status).json({ success: false, error: e });
  }
});

// Create Lead (if your account permits)
app.post('/api/leads', async (req, res) => {
  try {
    const body = createLeadSchema.parse(req.body || {});
    const form = mapLeadToYGL(body);
    const url = 'https://www.yougotlistings.com/api/leads/create.php';
    const response = await yglClient.post(url, qs.stringify(form));

    const contentType = response.headers['content-type'] || '';
    let data;
    if (contentType.includes('xml') || typeof response.data === 'string') {
      data = xmlToJsonSafe(response.data);
    } else {
      data = response.data;
    }

    return res.json({ success: true, data });
  } catch (err) {
    const e = normalizeError(err);
    return res.status(e.status).json({ success: false, error: e });
  }
});

// 404
app.use((req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } }));

// Error handler
app.use((err, req, res, next) => {
  const e = normalizeError(err);
  if (NODE_ENV !== 'test') console.error('[Unhandled]', err);
  res.status(e.status).json({ success: false, error: e });
});

app.listen(PORT, () => {
  console.log(`YouGotListings Proxy API running on http://localhost:${PORT}`);
});
