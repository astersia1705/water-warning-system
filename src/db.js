import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export function hashText(t) {
  return crypto.createHash('md5').update(String(t || '')).digest('hex');
}

function anonymizeAuthor(author) {
  if (!author || author === 'anonymous') return 'user_anon';
  return 'user_' + hashText(author).substring(0, 8);
}

// =========================================================================
// Database 1: Raw Data
// =========================================================================
export const rawDb = new DatabaseSync(join(dataDir, 'raw_data.sqlite'));

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS raw_posts (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    url TEXT,
    text TEXT NOT NULL,
    author_masked TEXT,
    created_at TEXT,
    ingested_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    error_message TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_posts(status);

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// =========================================================================
// Database 2: Processed Data
// =========================================================================
export const processedDb = new DatabaseSync(join(dataDir, 'processed_data.sqlite'));
// export ตัวแปร db เพื่อรองรับ pipeline.js
export const db = processedDb;

processedDb.exec(`
  CREATE TABLE IF NOT EXISTS processed_reports (
    id TEXT PRIMARY KEY,
    raw_post_id TEXT,
    source TEXT NOT NULL,
    hazard_type TEXT NOT NULL,
    contamination_type TEXT,
    severity INTEGER NOT NULL,
    urgency TEXT DEFAULT 'medium',
    confidence REAL DEFAULT 0.8,
    province TEXT,
    district TEXT,
    subdistrict TEXT,
    landmark_or_waterway TEXT,
    lat REAL,
    lng REAL,
    summary TEXT,
    health_signals_json TEXT,
    infrastructure_json TEXT,
    post_created_at TEXT,
    processed_at TEXT NOT NULL,
    status TEXT DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_proc_hazard ON processed_reports(hazard_type);
  CREATE INDEX IF NOT EXISTS idx_proc_province ON processed_reports(province);
  CREATE INDEX IF NOT EXISTS idx_proc_severity ON processed_reports(severity);
`);

// --- ฟังก์ชัน Key-Value (สำหรับ x.js และ settings) ---
export function kvGet(key, defaultVal = null) {
  try {
    const row = rawDb.prepare(`SELECT value FROM kv WHERE key = ?`).get(key);
    return row ? JSON.parse(row.value) : defaultVal;
  } catch {
    return defaultVal;
  }
}

export function kvSet(key, value) {
  try {
    rawDb.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`).run(key, JSON.stringify(value));
  } catch (err) {
    console.error(`kvSet error: ${err.message}`);
  }
}

// --- ฟังก์ชันจัดการ Database 1 (Raw Data) ---
export function insertRawPost(post) {
  const stmt = rawDb.prepare(`
    INSERT OR IGNORE INTO raw_posts (id, source, url, text, author_masked, created_at, ingested_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  return stmt.run(
    post.id,
    post.source || 'x',
    post.url || '',
    post.text,
    anonymizeAuthor(post.author),
    post.created_at || new Date().toISOString(),
    new Date().toISOString()
  );
}

export function updateRawPostStatus(id, status, error = null) {
  const stmt = rawDb.prepare(`
    UPDATE raw_posts SET status = ?, error_message = ? WHERE id = ?
  `);
  return stmt.run(status, error, id);
}

// --- ฟังก์ชันจัดการ Database 2 (Processed Data) ---
export function insertProcessedReport(report) {
  const stmt = processedDb.prepare(`
    INSERT OR REPLACE INTO processed_reports (
      id, raw_post_id, source, hazard_type, contamination_type, severity, urgency,
      confidence, province, district, subdistrict, landmark_or_waterway,
      lat, lng, summary, health_signals_json, infrastructure_json,
      post_created_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return stmt.run(
    report.id,
    report.raw_post_id,
    report.source || 'social',
    report.hazard_type,
    report.contamination_type || null,
    report.severity || 1,
    report.urgency || 'medium',
    report.confidence ?? 0.8,
    report.province || 'ไม่ระบุ',
    report.district || null,
    report.subdistrict || null,
    report.landmark_or_waterway || null,
    report.lat || null,
    report.lng || null,
    report.summary,
    JSON.stringify(report.health_signals || []),
    JSON.stringify(report.infrastructure || []),
    report.post_created_at || new Date().toISOString(),
    new Date().toISOString()
  );
}

// ฟังก์ชันสำหรับ pipeline.js
export function saveExtraction(report) {
  return insertProcessedReport(report);
}

export function getReports({ hazard_type, province, limit = 1000 } = {}) {
  let query = 'SELECT * FROM processed_reports WHERE 1=1';
  const params = [];

  if (hazard_type && hazard_type !== 'all') {
    query += ' AND hazard_type = ?';
    params.push(hazard_type);
  }
  if (province) {
    query += ' AND province = ?';
    params.push(province);
  }

  query += ' ORDER BY post_created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = processedDb.prepare(query);
  const rows = stmt.all(...params);

  return rows.map(r => ({
    ...r,
    health_signals: JSON.parse(r.health_signals_json || '[]'),
    infrastructure: JSON.parse(r.infrastructure_json || '[]')
  }));
}

export function getDashboardKPIs() {
  const totalReports = processedDb.prepare(`SELECT COUNT(*) as count FROM processed_reports`).get()?.count || 0;
  const criticalReports = processedDb.prepare(`SELECT COUNT(*) as count FROM processed_reports WHERE severity = 3`).get()?.count || 0;
  const wasteReports = processedDb.prepare(`SELECT COUNT(*) as count FROM processed_reports WHERE hazard_type = 'contaminated_water'`).get()?.count || 0;
  const floodReports = processedDb.prepare(`SELECT COUNT(*) as count FROM processed_reports WHERE hazard_type = 'flood'`).get()?.count || 0;
  const affectedProvinces = processedDb.prepare(`SELECT COUNT(DISTINCT province) as count FROM processed_reports WHERE province != 'ไม่ระบุ'`).get()?.count || 0;

  return {
    totalReports,
    criticalReports,
    wasteReports,
    floodReports,
    affectedProvinces
  };
}

// Alias สำหรับความเข้ากันได้กับโค้ดเดิมทั้งหมด
export const loadReports = getReports;
export const savePosts = (posts) => posts.forEach(insertRawPost);
export const stats = () => ({ posts: getDashboardKPIs().totalReports });
export const sourceMetrics = () => ({ by_source: [], by_query: [] });