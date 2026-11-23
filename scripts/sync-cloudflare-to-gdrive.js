// scripts/sync-cloudflare-to-gdrive.js
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// KONFIGURASI AKUN CLOUDFLARE UTAMA (HANYA 2 WORKER INTI)
// ============================================================================
const CF_ACCOUNT_ID = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '').trim();
const CF_API_TOKEN = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
const CF_EMAIL = (process.env.CF_EMAIL || '').trim();
const CF_GLOBAL_KEY = (process.env.CF_GLOBAL_KEY || '').trim();

const TARGET_WORKERS = (process.env.PERSONAL_WORKERS || 'dashboard-admin-pusat,dashboard-cms-custom')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const EXPORT_DIR = path.resolve('./gdrive_cf_export');
const SYNC_TIMESTAMP = new Date().toISOString();
const SENSITIVE_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|GLOBAL_KEY|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|TOTP)/i;

// ============================================================================
// HELPER: CSV (RFC-4180 + UTF-8 BOM UNTUK EXCEL & GOOGLE SHEETS)
// ============================================================================
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsvFile(filePath, headers, rows) {
  ensureDir(path.dirname(filePath));
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsvCell(row[h])).join(','));
  }
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\n'), 'utf8');
}

// ============================================================================
// HELPER: CLOUDFLARE API CLIENT
// ============================================================================
function buildCfHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CF_EMAIL && CF_GLOBAL_KEY) {
    headers['X-Auth-Email'] = CF_EMAIL;
    headers['X-Auth-Key'] = CF_GLOBAL_KEY;
    return headers;
  }
  if (CF_API_TOKEN) {
    const cleanToken = CF_API_TOKEN.replace(/^(Bearer\s+)+/i, '').replace(/[\s'"]/g, '');
    headers['Authorization'] = `Bearer ${cleanToken}`;
    return headers;
  }
  return null;
}

async function cfFetchJson(url, headers, options = {}) {
  const res = await fetch(url, { ...options, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Respons non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.success === false) {
    const errMsg = data?.errors?.map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data;
}

function classifyBinding(type) {
  if (type === 'secret_text') return 'ENV_SECRET';
  if (type === 'plain_text' || type === 'json') return 'ENV_VARIABLE';
  return `BINDING_${String(type || 'OTHER').toUpperCase()}`;
}

function formatBindingReference(binding) {
  if (binding.type === 'secret_text') {
    return '[SECRET - NAMA SAJA]';
  }
  if (binding.type === 'plain_text' || binding.type === 'json') {
    if (SENSITIVE_KEY_PATTERN.test(binding.name)) {
      return '***MASKED_VARIABLE***';
    }
    const val = binding.text !== undefined ? binding.text : binding.json;
    return typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
  }
  if (binding.type === 'd1') return `d1_id:${binding.id || ''}`;
  if (binding.type === 'kv_namespace') return `kv_id:${binding.namespace_id || ''}`;
  if (binding.type === 'queue') return `queue:${binding.queue_name || ''}`;
  if (binding.type === 'r2_bucket') return `bucket:${binding.bucket_name || ''}`;
  if (binding.type === 'service') return `service:${binding.service || ''}`;
  return `[${binding.type}]`;
}

// ============================================================================
// 1. AMBIL NAMA ENV (SECRET, VARIABEL, & BINDING) DARI 2 WORKER TARGET
// ============================================================================
async function fetchWorkerBindings(workerName, headers) {
  const bindingsMap = new Map();

  const settingsData = await cfFetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
    headers
  );

  for (const b of (settingsData?.result?.bindings || [])) {
    bindingsMap.set(b.name, {
      binding_name: b.name,
      binding_type: b.type,
      raw_id: b.id || b.namespace_id || '',
      category: classifyBinding(b.type),
      value_or_reference: formatBindingReference(b)
    });
  }

  // Lengkapi dari endpoint /secrets untuk memastikan seluruh nama secret tercatat
  try {
    const secretsData = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${encodeURIComponent(workerName)}/secrets`,
      headers
    );
    for (const s of (secretsData?.result || [])) {
      if (!bindingsMap.has(s.name)) {
        bindingsMap.set(s.name, {
          binding_name: s.name,
          binding_type: s.type || 'secret_text',
          raw_id: '',
          category: 'ENV_SECRET',
          value_or_reference: '[SECRET - NAMA SAJA]'
        });
      }
    }
  } catch {
    // Endpoint /settings sudah mencakup secret_text
  }

  return Array.from(bindingsMap.values());
}

// ============================================================================
// 2. AMBIL SKEMA TABEL & KOLOM DARI DATABASE D1 YANG TERIKAT
// ============================================================================
async function fetchD1SchemaRows(databaseId, databaseName, workerSource, headers) {
  const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${databaseId}/query`;
  const schemaRows = [];

  const tablesRes = await cfFetchJson(queryUrl, headers, {
    method: 'POST',
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name ASC;"
    })
  });

  const tables = tablesRes?.result?.[0]?.results || [];

  for (const t of tables) {
    const tableName = t.name;
    if (!tableName) continue;

    const pragmaRes = await cfFetchJson(queryUrl, headers, {
      method: 'POST',
      body: JSON.stringify({
        sql: `PRAGMA table_info("${tableName.replace(/"/g, '""')}");`
      })
    });

    const columns = pragmaRes?.result?.[0]?.results || [];
    for (const col of columns) {
      schemaRows.push({
        worker_source: workerSource,
        database_name: databaseName,
        database_id: databaseId,
        table_name: tableName,
        column_order: col.cid,
        column_name: col.name,
        data_type: col.type || 'TEXT',
        not_null: col.notnull ? 'YES' : 'NO',
        default_value: col.dflt_value ?? '',
        is_primary_key: col.pk ? 'YES' : 'NO',
        synced_at: SYNC_TIMESTAMP
      });
    }
  }

  return schemaRows;
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  const headers = buildCfHeaders();
  if (!CF_ACCOUNT_ID || !headers) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID dan CLOUDFLARE_API_TOKEN (atau CF_EMAIL + CF_GLOBAL_KEY) wajib diisi.');
  }

  console.log(`Memulai sinkronisasi skema Env & D1 untuk: ${TARGET_WORKERS.join(', ')}`);
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  ensureDir(EXPORT_DIR);

  const envRows = [];
  const d1Targets = new Map(); // databaseId -> { name, workers: Set }

  for (const workerName of TARGET_WORKERS) {
    console.log(`\nMemeriksa worker: ${workerName}...`);
    const bindings = await fetchWorkerBindings(workerName, headers);

    for (const b of bindings) {
      envRows.push({
        worker_name: workerName,
        binding_name: b.binding_name,
        binding_type: b.binding_type,
        category: b.category,
        value_or_reference: b.value_or_reference,
        synced_at: SYNC_TIMESTAMP
      });

      if (b.binding_type === 'd1' && b.raw_id) {
        if (!d1Targets.has(b.raw_id)) {
          d1Targets.set(b.raw_id, { name: b.raw_id, workers: new Set() });
        }
        d1Targets.get(b.raw_id).workers.add(workerName);
      }
    }
    console.log(`  ✅ ${bindings.length} env/binding berhasil dicatat.`);
  }

  // Resolusi nama asli database D1 di akun Cloudflare
  try {
    const dbListRes = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database?per_page=100`,
      headers
    );
    for (const db of (dbListRes?.result || [])) {
      const id = db.uuid || db.id;
      if (id && d1Targets.has(id) && db.name) {
        d1Targets.get(id).name = db.name;
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ Gagal mengambil nama D1 database: ${err.message}`);
  }

  const allD1SchemaRows = [];
  for (const [dbId, info] of d1Targets.entries()) {
    const workerSource = Array.from(info.workers).join(' + ');
    console.log(`\nMengekspor skema D1: ${info.name} (${dbId}) [${workerSource}]...`);
    const rows = await fetchD1SchemaRows(dbId, info.name, workerSource, headers);
    allD1SchemaRows.push(...rows);
    console.log(`  ✅ ${rows.length} definisi kolom tabel berhasil diekspor.`);
  }

  writeCsvFile(
    path.join(EXPORT_DIR, 'workers_env_schema.csv'),
    ['worker_name', 'binding_name', 'binding_type', 'category', 'value_or_reference', 'synced_at'],
    envRows
  );

  writeCsvFile(
    path.join(EXPORT_DIR, 'd1_tables_schema.csv'),
    ['worker_source', 'database_name', 'database_id', 'table_name', 'column_order', 'column_name', 'data_type', 'not_null', 'default_value', 'is_primary_key', 'synced_at'],
    allD1SchemaRows
  );

  console.log('\n✅ Selesai! Hanya 2 file CSV ringkas yang dibuat di ./gdrive_cf_export.');
}

main().catch(err => {
  console.error('❌ Fatal Error:', err.message);
  process.exit(1);
});