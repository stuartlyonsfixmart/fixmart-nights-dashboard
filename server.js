// Fixmart Nights Dashboard - Cloud Run Server

const express = require('express');
const session = require('express-session');
const { BigQuery } = require('@google-cloud/bigquery');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'fixmart-nights-2026',
  resave: true,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000, secure: false, sameSite: 'lax' }
}));

const USERS = { warehouse: { password: 'warehouse' } };

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.BQ_PROJECT_ID || 'project-aa7ee149-5e29-4eb4-8bc';
const P = PROJECT_ID;
const LOC = 'europe-west2';

const bigquery = new BigQuery({ projectId: PROJECT_ID });
const cache = new NodeCache({ stdTTL: 300 });

app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (user && user.password === password) {
    req.session.user = username;
    req.session.save(err => res.redirect('/'));
  } else {
    res.redirect('/login.html?error=1');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login.html'); });

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login.html');
}

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login') return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

function dateRange(q) {
  if (q.startDate && q.endDate) return { startDate: q.startDate, endDate: q.endDate };
  const days = parseInt(q.days) || 31;
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { startDate: start.toISOString().slice(0, 10), endDate: end };
}

// pick_end_time and pack_end_time are STRING in BQ format: 2014-06-19T14:01:58.180000
const TS = (col) => "PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E6S', " + col + ")";

// PICKING
app.get('/api/picking', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const shift = req.query.shift || 'all';
  const cacheKey = 'picking_' + startDate + '_' + endDate + '_' + shift;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const ts = TS('ph.pick_end_time');
  const shiftClause = shift === 'night'
    ? 'AND (EXTRACT(HOUR FROM ' + ts + ') >= 20 OR EXTRACT(HOUR FROM ' + ts + ') < 6)'
    : shift === 'day'
    ? 'AND EXTRACT(HOUR FROM ' + ts + ') >= 6 AND EXTRACT(HOUR FROM ' + ts + ') < 20'
    : '';

  const lines = [
    'WITH pick_data AS (',
    '  SELECT',
    '    pi.pic_name AS picker_name,',
    '    CASE WHEN EXTRACT(HOUR FROM ' + ts + ') >= 20 THEN DATE(' + ts + ')',
    '         ELSE DATE_SUB(DATE(' + ts + '), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM ' + ts + ') >= 6 AND EXTRACT(HOUR FROM ' + ts + ') < 20 THEN "Day" ELSE "Night" END AS shift,',
    '    ph.pick_id,',
    '    ph.pick_total_weight,',
    '    COUNT(pl.pickl_id) AS line_count,',
    '    COUNT(DISTINCT oli.oli_oh_id) AS order_count',
    '  FROM `' + P + '.fixmart_bi.pick_header` ph',
    '  JOIN `' + P + '.fixmart_bi.picker` pi ON pi.pic_id = ph.pick_pic_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_lines` pl ON pl.pickl_pick_id = ph.pick_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.order_line_item` oli ON oli.oli_id = pl.pickl_oli_id',
    '  WHERE ph.pick_end_time IS NOT NULL',
    '    AND DATE(' + ts + ') BETWEEN @startDate AND @endDate',
    '    AND pi.pic_active = TRUE',
    '    AND pi.pic_name NOT IN ("Default picker", "Not Working")',
    shiftClause,
    '  GROUP BY 1, 2, 3, 4, 5',
    ')',
    'SELECT picker_name, shift,',
    '  COUNT(DISTINCT shift_date) AS shift_days,',
    '  SUM(line_count) AS total_lines,',
    '  SUM(order_count) AS total_orders,',
    '  ROUND(SUM(pick_total_weight), 1) AS total_weight_kg,',
    '  ROUND(SAFE_DIVIDE(SUM(line_count), COUNT(DISTINCT shift_date)), 1) AS lines_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(order_count), COUNT(DISTINCT shift_date)), 1) AS orders_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(pick_total_weight), COUNT(DISTINCT shift_date)), 1) AS weight_per_shift',
    'FROM pick_data',
    'GROUP BY 1, 2',
    'ORDER BY total_lines DESC'
  ];

  try {
    const [rows] = await bigquery.query({ query: lines.join('\n'), params: { startDate, endDate }, location: LOC });
    cache.set(cacheKey, rows);
    res.json({ success: true, data: rows, cached: false });
  } catch (err) {
    console.error('Picking error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PACKING
app.get('/api/packing', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const shift = req.query.shift || 'all';
  const cacheKey = 'packing_' + startDate + '_' + endDate + '_' + shift;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const ts = TS('pack.pack_end_time');
  const shiftClause = shift === 'night'
    ? 'AND (EXTRACT(HOUR FROM ' + ts + ') >= 20 OR EXTRACT(HOUR FROM ' + ts + ') < 6)'
    : shift === 'day'
    ? 'AND EXTRACT(HOUR FROM ' + ts + ') >= 6 AND EXTRACT(HOUR FROM ' + ts + ') < 20'
    : '';

  const lines = [
    'WITH pack_data AS (',
    '  SELECT',
    '    pac.pac_name AS packer_name,',
    '    CASE WHEN EXTRACT(HOUR FROM ' + ts + ') >= 20 THEN DATE(' + ts + ')',
    '         ELSE DATE_SUB(DATE(' + ts + '), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM ' + ts + ') >= 6 AND EXTRACT(HOUR FROM ' + ts + ') < 20 THEN "Day" ELSE "Night" END AS shift,',
    '    pack.pack_id,',
    '    COUNT(pl.pl_id) AS line_count,',
    '    COUNT(DISTINCT oli.oli_oh_id) AS order_count,',
    '    SUM(ph.pick_total_weight) AS total_weight',
    '  FROM `' + P + '.fixmart_bi.pack_header` pack',
    '  JOIN `' + P + '.fixmart_bi.packer` pac ON pac.pac_id = pack.pack_pac_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pack_line` pl ON pl.pl_pack_id = pack.pack_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_lines` pkl ON pkl.pickl_id = pl.pl_pickl_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_header` ph ON ph.pick_id = pkl.pickl_pick_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.order_line_item` oli ON oli.oli_id = pkl.pickl_oli_id',
    '  WHERE pack.pack_end_time IS NOT NULL',
    '    AND DATE(' + ts + ') BETWEEN @startDate AND @endDate',
    '    AND pac.pac_active = TRUE',
    '    AND pac.pac_name NOT IN ("Default packer", "Not Working")',
    shiftClause,
    '  GROUP BY 1, 2, 3, 4',
    ')',
    'SELECT packer_name, shift,',
    '  COUNT(DISTINCT shift_date) AS shift_days,',
    '  SUM(line_count) AS total_lines,',
    '  SUM(order_count) AS total_orders,',
    '  ROUND(SUM(total_weight), 1) AS total_weight_kg,',
    '  ROUND(SAFE_DIVIDE(SUM(line_count), COUNT(DISTINCT shift_date)), 1) AS lines_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(order_count), COUNT(DISTINCT shift_date)), 1) AS orders_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(total_weight), COUNT(DISTINCT shift_date)), 1) AS weight_per_shift',
    'FROM pack_data',
    'GROUP BY 1, 2',
    'ORDER BY total_lines DESC'
  ];

  try {
    const [rows] = await bigquery.query({ query: lines.join('\n'), params: { startDate, endDate }, location: LOC });
    cache.set(cacheKey, rows);
    res.json({ success: true, data: rows, cached: false });
  } catch (err) {
    console.error('Packing error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GOODS IN PRODUCTIVITY
app.get('/api/goodsin', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const cacheKey = 'goodsin_' + startDate + '_' + endDate;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const query = [
    'SELECT',
    '  im.UserName AS operative,',
    '  DATE(im.vth_transaction_datetime) AS grn_date,',
    '  COUNT(*) AS lines_received,',
    '  SUM(im.Quantity) AS units_received,',
    '  ROUND(SUM(im.Quantity * COALESCE(vd.vad_weight, 0)), 1) AS weight_kg',
    'FROM `' + P + '.fixmart_bi.inventory_movements` im',
    'LEFT JOIN `' + P + '.fixmart_bi.variant_detail` vd ON vd.vad_id = im.VariantID',
    'WHERE im.HeaderIncomingStockFlag = TRUE',
    '  AND im.GRN_ID IS NOT NULL',
    '  AND DATE(im.vth_transaction_datetime) BETWEEN @startDate AND @endDate',
    '  AND im.UserName IS NOT NULL',
    'GROUP BY 1, 2',
    'ORDER BY grn_date DESC, lines_received DESC'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, params: { startDate, endDate }, location: LOC });
    cache.set(cacheKey, rows);
    res.json({ success: true, data: rows, cached: false });
  } catch (err) {
    console.error('Goods In error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GOODS IN OUTSTANDING
app.get('/api/goodsin-outstanding', async (req, res) => {
  const cacheKey = 'goodsin_outstanding';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const query = [
    'SELECT',
    '  poh.poh_order_number AS po_number,',
    '  cd.cd_name AS supplier,',
    '  poh.poh_required_date AS required_date,',
    '  poh.poh_promised_date AS promised_date,',
    '  poh.pos_status AS status,',
    '  vd.vad_variant_code AS sku,',
    '  pol.pol_vad_description AS description,',
    '  pol.pol_qty_ordered AS qty_ordered,',
    '  pol.pol_qty_received AS qty_received,',
    '  (pol.pol_qty_ordered - pol.pol_qty_received) AS qty_outstanding,',
    '  ROUND((pol.pol_qty_ordered - pol.pol_qty_received) * COALESCE(vd.vad_weight, 0), 1) AS weight_outstanding_kg,',
    '  ROUND((pol.pol_qty_ordered - pol.pol_qty_received) * pol.pol_item_net, 2) AS value_outstanding',
    'FROM `' + P + '.fixmart_bi.purchase_order_header` poh',
    'JOIN `' + P + '.fixmart_bi.purchase_order_lines` pol ON pol.pol_poh_id = poh.poh_id',
    'LEFT JOIN `' + P + '.fixmart_bi.variant_detail` vd ON vd.vad_id = pol.pol_vad_id',
    'LEFT JOIN `' + P + '.fixmart_bi.customer_detail` cd ON cd.cd_id = poh.poh_cd_id',
    'WHERE pol.pol_qty_ordered > pol.pol_qty_received',
    "  AND poh.pos_status NOT IN ('Complete', 'Cancelled')",
    'ORDER BY poh.poh_required_date ASC, poh.poh_order_number'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, location: LOC });
    const serialised = rows.map(r => ({
      po_number: r.po_number,
      supplier: r.supplier || 'Unknown',
      required_date: r.required_date ? (r.required_date.value || String(r.required_date)).slice(0, 10) : null,
      promised_date: r.promised_date ? (r.promised_date.value || String(r.promised_date)).slice(0, 10) : null,
      status: r.status,
      sku: r.sku,
      description: r.description,
      qty_ordered: r.qty_ordered,
      qty_received: r.qty_received,
      qty_outstanding: r.qty_outstanding,
      weight_outstanding_kg: r.weight_outstanding_kg,
      value_outstanding: r.value_outstanding
    }));
    cache.set(cacheKey, serialised);
    res.json({ success: true, data: serialised, cached: false });
  } catch (err) {
    console.error('Goods In Outstanding error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log('Fixmart Nights Dashboard running on port ' + PORT));
