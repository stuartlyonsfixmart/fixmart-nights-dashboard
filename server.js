// Fixmart Nights Dashboard - Cloud Run Server
// No login: anyone with the URL can view. Same as the stock and
// failed-deliveries dashboards.

const express = require('express');
const { BigQuery } = require('@google-cloud/bigquery');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.BQ_PROJECT_ID || 'project-aa7ee149-5e29-4eb4-8bc';
const P = PROJECT_ID;
const LOC = 'europe-west2';

const bigquery = new BigQuery({ projectId: PROJECT_ID });
const cache = new NodeCache({ stdTTL: 300 });

// Old login paths kept as redirects so bookmarks do not 404.
app.get('/login.html', (req, res) => res.redirect('/'));
app.post('/login', (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => res.redirect('/'));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/chart.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'));
});

function dateRange(q) {
  if (q.startDate && q.endDate) return { startDate: q.startDate, endDate: q.endDate };
  const days = parseInt(q.days) || 31;
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now);
  start.setDate(start.getDate() - days);
  return { startDate: start.toISOString().slice(0, 10), endDate: end };
}

function shiftFilter(shift, tsCol) {
  if (shift === 'night') return 'AND (EXTRACT(HOUR FROM ' + tsCol + ') >= 20 OR EXTRACT(HOUR FROM ' + tsCol + ') < 6)';
  if (shift === 'day') return 'AND EXTRACT(HOUR FROM ' + tsCol + ') >= 6 AND EXTRACT(HOUR FROM ' + tsCol + ') < 20';
  return '';
}

function bqDate(val) {
  if (!val) return null;
  return (val.value || String(val)).slice(0, 10);
}

// SHIFT CLASSIFICATION
app.get('/api/shift-classification', async (req, res) => {
  const type = req.query.type || 'picking';
  const cacheKey = 'shift_class_' + type;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 90);
  const startDate = start.toISOString().slice(0, 10);

  let query;
  if (type === 'picking') {
    query = [
      'WITH clean AS (',
      '  SELECT ph.pick_pic_id,',
      "    SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E6S', ph.pick_end_time) AS end_ts",
      '  FROM `' + P + '.fixmart_bi.pick_header` ph',
      '  WHERE ph.pick_end_time IS NOT NULL',
      "    AND ph.pick_end_time NOT LIKE '%NaT%'",
      '    AND LENGTH(ph.pick_end_time) > 10',
      '    AND ph.pick_end_time >= @startDate',
      '),',
      'counts AS (',
      '  SELECT pi.pic_name AS person,',
      '    COUNTIF(EXTRACT(HOUR FROM c.end_ts) >= 20 OR EXTRACT(HOUR FROM c.end_ts) < 6) AS night_count,',
      '    COUNTIF(EXTRACT(HOUR FROM c.end_ts) >= 6 AND EXTRACT(HOUR FROM c.end_ts) < 20) AS day_count,',
      '    COUNT(*) AS total',
      '  FROM clean c',
      '  JOIN `' + P + '.fixmart_bi.picker` pi ON pi.pic_id = c.pick_pic_id',
      '  WHERE c.end_ts IS NOT NULL AND pi.pic_active = TRUE',
      '    AND pi.pic_name NOT IN ("Default picker", "Not Working")',
      '  GROUP BY 1',
      ')',
      'SELECT person, night_count, day_count, total,',
      '  ROUND(SAFE_DIVIDE(night_count, total) * 100, 1) AS pct_night,',
      '  ROUND(SAFE_DIVIDE(day_count, total) * 100, 1) AS pct_day,',
      '  CASE WHEN SAFE_DIVIDE(night_count, total) >= 0.85 THEN "Night"',
      '       WHEN SAFE_DIVIDE(day_count, total) >= 0.85 THEN "Day"',
      '       ELSE "Both" END AS classification',
      'FROM counts ORDER BY person'
    ].join('\n');
  } else {
    query = [
      'WITH counts AS (',
      '  SELECT pac.pac_name AS person,',
      '    COUNTIF(EXTRACT(HOUR FROM pack.pack_end_time) >= 20 OR EXTRACT(HOUR FROM pack.pack_end_time) < 6) AS night_count,',
      '    COUNTIF(EXTRACT(HOUR FROM pack.pack_end_time) >= 6 AND EXTRACT(HOUR FROM pack.pack_end_time) < 20) AS day_count,',
      '    COUNT(*) AS total',
      '  FROM `' + P + '.fixmart_bi.pack_header` pack',
      '  JOIN `' + P + '.fixmart_bi.packer` pac ON pac.pac_id = pack.pack_pac_id',
      '  WHERE pack.pack_end_time IS NOT NULL AND DATE(pack.pack_end_time) >= @startDate',
      '    AND pac.pac_active = TRUE AND pac.pac_name NOT IN ("Default packer", "Not Working")',
      '  GROUP BY 1',
      ')',
      'SELECT person, night_count, day_count, total,',
      '  ROUND(SAFE_DIVIDE(night_count, total) * 100, 1) AS pct_night,',
      '  ROUND(SAFE_DIVIDE(day_count, total) * 100, 1) AS pct_day,',
      '  CASE WHEN SAFE_DIVIDE(night_count, total) >= 0.85 THEN "Night"',
      '       WHEN SAFE_DIVIDE(day_count, total) >= 0.85 THEN "Day"',
      '       ELSE "Both" END AS classification',
      'FROM counts ORDER BY person'
    ].join('\n');
  }

  try {
    const [rows] = await bigquery.query({ query, params: { startDate }, location: LOC });
    cache.set(cacheKey, rows.map(r => ({ person: r.person, night_count: r.night_count, day_count: r.day_count, total: r.total, pct_night: r.pct_night, pct_day: r.pct_day, classification: r.classification })));
    res.json({ success: true, data: cache.get(cacheKey), cached: false });
  } catch (err) {
    console.error('Classification error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PICKING
app.get('/api/picking', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const shift = req.query.shift || 'all';
  const cacheKey = 'picking_' + startDate + '_' + endDate + '_' + shift;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const lines = [
    'WITH clean AS (',
    '  SELECT ph.pick_id, ph.pick_total_weight, ph.pick_pic_id,',
    "    SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E6S', ph.pick_end_time) AS end_ts",
    '  FROM `' + P + '.fixmart_bi.pick_header` ph',
    '  WHERE ph.pick_end_time IS NOT NULL',
    "    AND ph.pick_end_time NOT LIKE '%NaT%'",
    '    AND LENGTH(ph.pick_end_time) > 10',
    '),',
    'pick_data AS (',
    '  SELECT pi.pic_name AS picker_name,',
    '    CASE WHEN EXTRACT(HOUR FROM c.end_ts) >= 20 THEN DATE(c.end_ts)',
    '         ELSE DATE_SUB(DATE(c.end_ts), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM c.end_ts) >= 6 AND EXTRACT(HOUR FROM c.end_ts) < 20 THEN "Day" ELSE "Night" END AS shift,',
    '    c.pick_id, c.pick_total_weight,',
    '    COUNT(pl.pickl_id) AS line_count,',
    '    COUNT(DISTINCT oli.oli_oh_id) AS order_count',
    '  FROM clean c',
    '  JOIN `' + P + '.fixmart_bi.picker` pi ON pi.pic_id = c.pick_pic_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_lines` pl ON pl.pickl_pick_id = c.pick_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.order_line_item` oli ON oli.oli_id = pl.pickl_oli_id',
    '  WHERE c.end_ts IS NOT NULL AND DATE(c.end_ts) BETWEEN @startDate AND @endDate',
    '    AND pi.pic_active = TRUE AND pi.pic_name NOT IN ("Default picker", "Not Working")',
    shiftFilter(shift, 'c.end_ts'),
    '  GROUP BY 1, 2, 3, 4, 5',
    ')',
    'SELECT picker_name, shift,',
    '  COUNT(DISTINCT shift_date) AS shift_days,',
    '  SUM(line_count) AS total_lines, SUM(order_count) AS total_orders,',
    '  ROUND(SUM(pick_total_weight), 1) AS total_weight_kg,',
    '  ROUND(SAFE_DIVIDE(SUM(line_count), COUNT(DISTINCT shift_date)), 1) AS lines_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(order_count), COUNT(DISTINCT shift_date)), 1) AS orders_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(pick_total_weight), COUNT(DISTINCT shift_date)), 1) AS weight_per_shift',
    'FROM pick_data GROUP BY 1, 2 ORDER BY total_lines DESC'
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

  const lines = [
    'WITH pack_data AS (',
    '  SELECT pac.pac_name AS packer_name,',
    '    CASE WHEN EXTRACT(HOUR FROM pack.pack_end_time) >= 20 THEN DATE(pack.pack_end_time)',
    '         ELSE DATE_SUB(DATE(pack.pack_end_time), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM pack.pack_end_time) >= 6 AND EXTRACT(HOUR FROM pack.pack_end_time) < 20 THEN "Day" ELSE "Night" END AS shift,',
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
    '  WHERE pack.pack_end_time IS NOT NULL AND DATE(pack.pack_end_time) BETWEEN @startDate AND @endDate',
    '    AND pac.pac_active = TRUE AND pac.pac_name NOT IN ("Default packer", "Not Working")',
    shiftFilter(shift, 'pack.pack_end_time'),
    '  GROUP BY 1, 2, 3, 4',
    ')',
    'SELECT packer_name, shift,',
    '  COUNT(DISTINCT shift_date) AS shift_days,',
    '  SUM(line_count) AS total_lines, SUM(order_count) AS total_orders,',
    '  ROUND(SUM(total_weight), 1) AS total_weight_kg,',
    '  ROUND(SAFE_DIVIDE(SUM(line_count), COUNT(DISTINCT shift_date)), 1) AS lines_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(order_count), COUNT(DISTINCT shift_date)), 1) AS orders_per_shift,',
    '  ROUND(SAFE_DIVIDE(SUM(total_weight), COUNT(DISTINCT shift_date)), 1) AS weight_per_shift',
    'FROM pack_data GROUP BY 1, 2 ORDER BY total_lines DESC'
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

// PICKING TRENDS
app.get('/api/picking-trends', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const shift = req.query.shift || 'all';
  const cacheKey = 'picking_trends_' + startDate + '_' + endDate + '_' + shift;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const lines = [
    'WITH clean AS (',
    '  SELECT ph.pick_id, ph.pick_total_weight, ph.pick_pic_id,',
    "    SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E6S', ph.pick_end_time) AS end_ts",
    '  FROM `' + P + '.fixmart_bi.pick_header` ph',
    '  WHERE ph.pick_end_time IS NOT NULL',
    "    AND ph.pick_end_time NOT LIKE '%NaT%'",
    '    AND LENGTH(ph.pick_end_time) > 10',
    '),',
    'daily AS (',
    '  SELECT pi.pic_name AS person,',
    '    CASE WHEN EXTRACT(HOUR FROM c.end_ts) >= 20 THEN DATE(c.end_ts)',
    '         ELSE DATE_SUB(DATE(c.end_ts), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM c.end_ts) >= 6 AND EXTRACT(HOUR FROM c.end_ts) < 20 THEN "Day" ELSE "Night" END AS shift,',
    '    COUNT(pl.pickl_id) AS lines,',
    '    COUNT(DISTINCT oli.oli_oh_id) AS orders,',
    '    ROUND(SUM(c.pick_total_weight), 1) AS weight_kg',
    '  FROM clean c',
    '  JOIN `' + P + '.fixmart_bi.picker` pi ON pi.pic_id = c.pick_pic_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_lines` pl ON pl.pickl_pick_id = c.pick_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.order_line_item` oli ON oli.oli_id = pl.pickl_oli_id',
    '  WHERE c.end_ts IS NOT NULL AND DATE(c.end_ts) BETWEEN @startDate AND @endDate',
    '    AND pi.pic_active = TRUE AND pi.pic_name NOT IN ("Default picker", "Not Working")',
    shiftFilter(shift, 'c.end_ts'),
    '  GROUP BY 1, 2, 3',
    ')',
    'SELECT person, shift_date, shift, lines, orders, weight_kg',
    'FROM daily ORDER BY shift_date, person'
  ];

  try {
    const [rows] = await bigquery.query({ query: lines.join('\n'), params: { startDate, endDate }, location: LOC });
    cache.set(cacheKey, rows.map(r => ({ person: r.person, shift_date: bqDate(r.shift_date), shift: r.shift, lines: r.lines, orders: r.orders, weight_kg: r.weight_kg })));
    res.json({ success: true, data: cache.get(cacheKey), cached: false });
  } catch (err) {
    console.error('Picking trends error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PACKING TRENDS
app.get('/api/packing-trends', async (req, res) => {
  const { startDate, endDate } = dateRange(req.query);
  const shift = req.query.shift || 'all';
  const cacheKey = 'packing_trends_' + startDate + '_' + endDate + '_' + shift;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const lines = [
    'WITH daily AS (',
    '  SELECT pac.pac_name AS person,',
    '    CASE WHEN EXTRACT(HOUR FROM pack.pack_end_time) >= 20 THEN DATE(pack.pack_end_time)',
    '         ELSE DATE_SUB(DATE(pack.pack_end_time), INTERVAL 1 DAY) END AS shift_date,',
    '    CASE WHEN EXTRACT(HOUR FROM pack.pack_end_time) >= 6 AND EXTRACT(HOUR FROM pack.pack_end_time) < 20 THEN "Day" ELSE "Night" END AS shift,',
    '    COUNT(pl.pl_id) AS lines,',
    '    COUNT(DISTINCT oli.oli_oh_id) AS orders,',
    '    ROUND(SUM(ph.pick_total_weight), 1) AS weight_kg',
    '  FROM `' + P + '.fixmart_bi.pack_header` pack',
    '  JOIN `' + P + '.fixmart_bi.packer` pac ON pac.pac_id = pack.pack_pac_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pack_line` pl ON pl.pl_pack_id = pack.pack_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_lines` pkl ON pkl.pickl_id = pl.pl_pickl_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.pick_header` ph ON ph.pick_id = pkl.pickl_pick_id',
    '  LEFT JOIN `' + P + '.fixmart_bi.order_line_item` oli ON oli.oli_id = pkl.pickl_oli_id',
    '  WHERE pack.pack_end_time IS NOT NULL AND DATE(pack.pack_end_time) BETWEEN @startDate AND @endDate',
    '    AND pac.pac_active = TRUE AND pac.pac_name NOT IN ("Default packer", "Not Working")',
    shiftFilter(shift, 'pack.pack_end_time'),
    '  GROUP BY 1, 2, 3',
    ')',
    'SELECT person, shift_date, shift, lines, orders, weight_kg',
    'FROM daily ORDER BY shift_date, person'
  ];

  try {
    const [rows] = await bigquery.query({ query: lines.join('\n'), params: { startDate, endDate }, location: LOC });
    cache.set(cacheKey, rows.map(r => ({ person: r.person, shift_date: bqDate(r.shift_date), shift: r.shift, lines: r.lines, orders: r.orders, weight_kg: r.weight_kg })));
    res.json({ success: true, data: cache.get(cacheKey), cached: false });
  } catch (err) {
    console.error('Packing trends error:', err);
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
    'SELECT im.UserName AS operative, DATE(im.vth_transaction_datetime) AS grn_date,',
    '  COUNT(*) AS lines_received, SUM(ABS(im.Quantity)) AS units_received,',
    '  ROUND(SUM(ABS(im.Quantity) * COALESCE(vd.vad_weight, 0)), 1) AS weight_kg',
    'FROM `' + P + '.fixmart_bi.inventory_movements` im',
    'LEFT JOIN `' + P + '.fixmart_bi.variant_detail` vd ON vd.vad_id = im.VariantID',
    'WHERE im.GRN_ID IS NOT NULL',
    '  AND im.HeaderIncomingStockFlag = TRUE',
    '  AND DATE(im.vth_transaction_datetime) BETWEEN @startDate AND @endDate',
    '  AND im.UserName IS NOT NULL',
    '  AND im.UserName NOT IN ("Goods In", "Default")',
    'GROUP BY 1, 2 ORDER BY grn_date DESC, lines_received DESC'
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
// pos_status codes: W=Waiting for goods, R=Awaiting response, P=Partially received
// Excluded: F=Fully received, X=Cancelled, C=Complete, A=Awaiting conversion
// expected_date = COALESCE(poh_promised_date, poh_required_date)
// poh_promised_date is supplier's committed date; falls back to required date if not set
app.get('/api/goodsin-outstanding', async (req, res) => {
  const cacheKey = 'goodsin_outstanding';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const query = [
    'SELECT',
    '  poh.poh_order_number AS po_number,',
    '  COALESCE(sd.sd_name, \'Unknown\') AS supplier,',
    '  DATE(poh.poh_required_date) AS required_date,',
    '  DATE(poh.poh_promised_date) AS promised_date,',
    '  DATE(COALESCE(poh.poh_promised_date, poh.poh_required_date)) AS expected_date,',
    '  poh.pos_description AS status,',
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
    'LEFT JOIN `' + P + '.fixmart_bi.supply_detail` sd ON sd.sd_id = poh.poh_sd_id',
    'WHERE pol.pol_qty_ordered > pol.pol_qty_received',
    "  AND poh.pos_status IN ('W', 'R', 'P')",
    'ORDER BY expected_date ASC NULLS LAST, poh.poh_order_number'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, location: LOC });
    const serialised = rows.map(r => ({
      po_number: r.po_number,
      supplier: r.supplier || 'Unknown',
      required_date: bqDate(r.required_date),
      promised_date: bqDate(r.promised_date),
      expected_date: bqDate(r.expected_date),
      poh_promised_date: bqDate(r.promised_date), // flag for frontend to show (req date) note
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

// REPLENISHMENT
// Replicates Kyle's OrderWise "Default Bin & Stock Report - Replenishment".
// Location 2 = "1 - Main Stock". Replenishment min/max = default-bin min/max.
// CurrentStockQuantity = overall stock. RAG driven off overall stock to match the report.
// Discontinued/non-stock/service items excluded by design (the view filters them),
// so row count is slightly below the OrderWise report which still lists discontinued SKUs.
app.get('/api/replenishment', async (req, res) => {
  const showAll = req.query.all === '1';
  const cacheKey = 'replenishment_' + (showAll ? 'all' : 'onrep');
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, cached: true });

  const lines = [
    'SELECT',
    '  vad_variant_code AS sku,',
    '  vad_description AS description,',
    '  current_stock,',
    '  free_stock,',
    '  on_order,',
    '  replen_min,',
    '  replen_max,',
    '  suggested_replen_qty,',
    '  replen_status,',
    '  on_replenishment',
    'FROM `' + P + '.fixmart_bi.vw_replenishment`',
    showAll ? '' : 'WHERE on_replenishment = TRUE',
    'ORDER BY',
    "  CASE replen_status WHEN 'OUT OF STOCK' THEN 1 WHEN 'BELOW MIN' THEN 2 WHEN 'OVERSTOCKED' THEN 3 WHEN 'OK' THEN 4 ELSE 5 END,",
    '  suggested_replen_qty DESC,',
    '  sku'
  ];

  try {
    const [rows] = await bigquery.query({ query: lines.join('\n'), location: LOC });
    cache.set(cacheKey, rows);
    res.json({ success: true, data: rows, cached: false });
  } catch (err) {
    console.error('Replenishment error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


app.listen(PORT, () => console.log('Fixmart Nights Dashboard running on port ' + PORT));
