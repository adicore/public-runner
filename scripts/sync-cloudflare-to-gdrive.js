// scripts/sync-cloudflare-to-gdrive.js
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// KONFIGURASI ENVIRONMENT
// ============================================================================
const PUSAT_WORKER_URL = (process.env.PUSAT_WORKER_URL || 'https://dashboard-admin-pusat.accessed.workers.dev').replace(/\/+$/, '');
const MASS_UPDATE_PASSWORD = process.env.MASS_UPDATE_PASSWORD || '';
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';

// Kredensial Cloudflare Akun Utama (Milik Anda)
const PERSONAL_CF_ACCOUNT_ID = (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '').trim();
const PERSONAL_CF_API_TOKEN = (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '').trim();
const PERSONAL_CF_EMAIL = (process.env.CF_EMAIL || '').trim();
const PERSONAL_CF_GLOBAL_KEY = (process.env.CF_GLOBAL_KEY || '').trim();

// Daftar worker utama milik Anda yang diprioritaskan (selain auto-discover semua worker di akun Anda)
const PRIORITY_PERSONAL_WORKERS = (process.env.PERSONAL_WORKERS || 'dashboard-cms-custom,dashboard-admin-pusat')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const EXPORT_DIR = path.resolve('./gdrive_cf_export');
const SYNC_TIMESTAMP = new Date().toISOString();

// ============================================================================
// HELPER: CSV & FILE SYSTEM (RFC-4180 + UTF-8 BOM UNTUK EXCEL)
// ============================================================================
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileName(name) {
  return String(name || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function writeCsvFile(filePath, headers, rows) {
  ensureDir(path.dirname(filePath));
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    const line = headers.map(h => escapeCsvCell(row[h])).join(',');
    lines.push(line);
  }
  // Tambahkan UTF-8 BOM (\uFEFF) agar Microsoft Excel & Google Sheets membaca karakter dengan benar
  fs.writeFileSync(filePath, '\uFEFF' + lines.join('\n'), 'utf8');
}

// ============================================================================
// HELPER: SENSOR KREDENSIAL SENSITIF SAAT EKSPOR D1 & ENV
// ============================================================================
const SENSITIVE_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|GLOBAL_KEY|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|TOTP)/i;

function sanitizeD1Row(tableName, row) {
  const cleanRow = { ...row };

  for (const [col, val] of Object.entries(cleanRow)) {
    if (val === null || val === undefined) continue;

    // Sensor kolom kredensial langsung
    if (['token', 'password', 'totp_secret', 'cf_global_key', 'github_pat'].includes(col.toLowerCase())) {
      cleanRow[col] = val ? '***REDACTED***' : '';
      continue;
    }

    // Jika tabel 'clients' memiliki kolom JSON 'settings', sensor isi 'secrets' tapi pertahankan nama key-nya
    if (tableName === 'clients' && col === 'settings' && typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        if (parsed && typeof parsed.secrets === 'object' && parsed.secrets !== null) {
          const maskedSecrets = {};
          for (const secretKey of Object.keys(parsed.secrets)) {
            maskedSecrets[secretKey] = parsed.secrets[secretKey] ? '***REDACTED***' : '';
          }
          parsed.secrets = maskedSecrets;
        }
        cleanRow[col] = JSON.stringify(parsed);
      } catch {
        // Biarkan jika bukan JSON valid
      }
    }
  }

  return cleanRow;
}

function formatEnvValueForExport(binding) {
  if (binding.type === 'secret_text') {
    return '[SECRET - NAMA SAJA]';
  }
  if (binding.type === 'plain_text' || binding.type === 'json') {
    if (SENSITIVE_KEY_PATTERN.test(binding.name)) {
      return '***MASKED_VARIABLE***';
    }
    const rawVal = binding.text !== undefined ? binding.text : binding.json;
    return typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal ?? '');
  }
  if (binding.type === 'd1') return `d1_id:${binding.id || ''}`;
  if (binding.type === 'kv_namespace') return `kv_id:${binding.namespace_id || ''}`;
  if (binding.type === 'queue') return `queue:${binding.queue_name || ''}`;
  if (binding.type === 'r2_bucket') return `bucket:${binding.bucket_name || ''}`;
  if (binding.type === 'service') return `service:${binding.service || ''}`;
  return `[${binding.type}]`;
}

function classifyBinding(type) {
  if (type === 'secret_text') return 'ENV_SECRET';
  if (type === 'plain_text' || type === 'json') return 'ENV_VARIABLE';
  return `BINDING_${String(type || 'OTHER').toUpperCase()}`;
}

// ============================================================================
// HELPER: CLOUDFLARE API CLIENT (MENDUKUNG GLOBAL API KEY & BEARER TOKEN)
// ============================================================================
function buildCfAuthHeaders({ email, globalKey, apiToken }) {
  const headers = { 'Content-Type': 'application/json' };
  if (email && globalKey) {
    headers['X-Auth-Email'] = email.trim();
    headers['X-Auth-Key'] = globalKey.trim();
    return headers;
  }
  if (apiToken) {
    const cleanToken = apiToken.replace(/^(Bearer\s+)+/i, '').replace(/[\s'"]/g, '');
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

// Ambil daftar semua Worker dalam satu akun Cloudflare
async function listAccountWorkers(accountId, cfHeaders) {
  const data = await cfFetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    cfHeaders
  );
  return Array.isArray(data.result) ? data.result : [];
}

// Ambil semua nama Env (Secret, Variabel, & Resource Bindings) dari satu Worker
async function getWorkerEnvBindings(accountId, scriptName, cfHeaders) {
  const bindingsMap = new Map();

  // 1. Endpoint Settings (mengembalikan plain_text, secret_text, D1, KV, Queue, dll.)
  try {
    const settingsData = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
      cfHeaders
    );
    const bindings = settingsData?.result?.bindings || [];
    for (const b of bindings) {
      bindingsMap.set(b.name, {
        binding_name: b.name,
        binding_type: b.type,
        category: classifyBinding(b.type),
        value_or_reference: formatEnvValueForExport(b)
      });
    }
  } catch (err) {
    console.warn(`  [Warn] Gagal baca /settings untuk worker ${scriptName}: ${err.message}`);
  }

  // 2. Endpoint Secrets (sebagai pelengkap untuk memastikan semua nama secret tercatat)
  try {
    const secretsData = await cfFetchJson(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
      cfHeaders
    );
    const secrets = Array.isArray(secretsData?.result) ? secretsData.result : [];
    for (const s of secrets) {
      if (!bindingsMap.has(s.name)) {
        bindingsMap.set(s.name, {
          binding_name: s.name,
          binding_type: s.type || 'secret_text',
          category: 'ENV_SECRET',
          value_or_reference: '[SECRET - NAMA SAJA]'
        });
      }
    }
  } catch (err) {
    console.warn(`  [Warn] Gagal baca /secrets untuk worker ${scriptName}: ${err.message}`);
  }

  return Array.from(bindingsMap.values());
}

// Ambil daftar semua Database D1 dalam satu akun Cloudflare
async function listAccountD1Databases(accountId, cfHeaders) {
  const data = await cfFetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=100`,
    cfHeaders
  );
  return Array.isArray(data.result) ? data.result : [];
}

// Ekspor seluruh tabel dari satu Database D1 ke file .csv
async function exportD1DatabaseToCsv({ accountId, databaseId, dbLabel, cfHeaders, outputFolder }) {
  const queryUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  // 1. Ambil daftar tabel user (abaikan tabel sistem sqlite_ dan _cf_)
  const tablesRes = await cfFetchJson(queryUrl, cfHeaders, {
    method: 'POST',
    body: JSON.stringify({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name ASC;"
    })
  });

  const tableRows = tablesRes?.result?.[0]?.results || [];
  let exportedTables = 0;

  for (const t of tableRows) {
    const tableName = t.name;
    if (!tableName) continue;

    // Ambil metadata kolom terlebih dahulu agar CSV tetap terbentuk meskipun tabel kosong (0 baris)
    const pragmaRes = await cfFetchJson(queryUrl, cfHeaders, {
      method: 'POST',
      body: JSON.stringify({ sql: `PRAGMA table_info("${tableName.replace(/"/g, '""')}");` })
    });
    const columns = (pragmaRes?.result?.[0]?.results || []).map(c => c.name);

    // Ambil seluruh isi tabel
    const dataRes = await cfFetchJson(queryUrl, cfHeaders, {
      method: 'POST',
      body: JSON.stringify({ sql: `SELECT * FROM "${tableName.replace(/"/g, '""')}";` })
    });
    const rawRows = dataRes?.result?.[0]?.results || [];
    const safeRows = rawRows.map(r => sanitizeD1Row(tableName, r));

    const finalHeaders = columns.length > 0
      ? columns
      : (safeRows.length > 0 ? Object.keys(safeRows[0]) : ['empty_table']);

    const csvPath = path.join(outputFolder, `${sanitizeFileName(tableName)}.csv`);
    writeCsvFile(csvPath, finalHeaders, safeRows);
    exportedTables++;
  }

  console.log(`  [D1 OK] ${dbLabel} (${databaseId}): ${exportedTables} tabel diekspor ke CSV.`);
  return exportedTables;
}

// ============================================================================
// STEP 1: SINKRONISASI CLOUDFLARE AKUN UTAMA (MILIK ANDA)
// ============================================================================
async function syncPersonalCloudflare(allEnvRows, syncReportRows) {
  console.log('\n=== 1. SINKRONISASI CLOUDFLARE PRIBADI (UTAMA) ===');
  const cfHeaders = buildCfAuthHeaders({
    email: PERSONAL_CF_EMAIL,
    globalKey: PERSONAL_CF_GLOBAL_KEY,
    apiToken: PERSONAL_CF_API_TOKEN
  });

  if (!PERSONAL_CF_ACCOUNT_ID || !cfHeaders) {
    console.warn('⚠️ Kredensial Cloudflare utama belum lengkap, melewati sinkronisasi akun pribadi.');
    syncReportRows.push({
      scope: 'PERSONAL',
      owner_identifier: 'personal_account',
      account_id: PERSONAL_CF_ACCOUNT_ID || 'MISSING',
      status: 'SKIPPED',
      workers_synced: 0,
      d1_tables_exported: 0,
      note: 'CLOUDFLARE_ACCOUNT_ID atau Token/Global Key kosong',
      synced_at: SYNC_TIMESTAMP
    });
    return;
  }

  const personalEnvRows = [];
  let totalTablesExported = 0;

  // A. Ambil & gabungkan daftar Worker Anda (prioritas + auto-discover)
  const workerNamesSet = new Set(PRIORITY_PERSONAL_WORKERS);
  try {
    const scripts = await listAccountWorkers(PERSONAL_CF_ACCOUNT_ID, cfHeaders);
    for (const s of scripts) {
      if (s.id) workerNamesSet.add(s.id);
    }
  } catch (err) {
    console.error(`❌ Gagal list workers akun pribadi: ${err.message}`);
  }

  for (const workerName of workerNamesSet) {
    try {
      const bindings = await getWorkerEnvBindings(PERSONAL_CF_ACCOUNT_ID, workerName, cfHeaders);
      for (const b of bindings) {
        const row = {
          scope: 'PERSONAL',
          owner_name: 'adicore (Utama)',
          worker_name: workerName,
          domain: '',
          account_id: PERSONAL_CF_ACCOUNT_ID,
          binding_name: b.binding_name,
          binding_type: b.binding_type,
          category: b.category,
          value_or_reference: b.value_or_reference,
          synced_at: SYNC_TIMESTAMP
        };
        personalEnvRows.push(row);
        allEnvRows.push(row);
      }
      console.log(`  [Worker OK] ${workerName}: ${bindings.length} env/binding tercatat.`);
    } catch (err) {
      console.error(`  [Worker GAGAL] ${workerName}: ${err.message}`);
    }
  }

  writeCsvFile(
    path.join(EXPORT_DIR, 'Workers_Env', 'personal_workers_env.csv'),
    ['scope', 'owner_name', 'worker_name', 'domain', 'account_id', 'binding_name', 'binding_type', 'category', 'value_or_reference', 'synced_at'],
    personalEnvRows
  );

  // B. Ekspor semua Database D1 di akun pribadi Anda
  try {
    const dbs = await listAccountD1Databases(PERSONAL_CF_ACCOUNT_ID, cfHeaders);
    for (const db of dbs) {
      const dbId = db.uuid || db.id;
      const dbName = db.name || dbId;
      const outDir = path.join(EXPORT_DIR, 'D1_Personal', sanitizeFileName(dbName));
      const count = await exportD1DatabaseToCsv({
        accountId: PERSONAL_CF_ACCOUNT_ID,
        databaseId: dbId,
        dbLabel: dbName,
        cfHeaders,
        outputFolder: outDir
      });
      totalTablesExported += count;
    }
  } catch (err) {
    console.error(`❌ Gagal ekspor D1 pribadi: ${err.message}`);
  }

  syncReportRows.push({
    scope: 'PERSONAL',
    owner_identifier: 'adicore (Utama)',
    account_id: PERSONAL_CF_ACCOUNT_ID,
    status: 'SUCCESS',
    workers_synced: workerNamesSet.size,
    d1_tables_exported: totalTablesExported,
    note: Array.from(workerNamesSet).join(' | '),
    synced_at: SYNC_TIMESTAMP
  });
}

// ============================================================================
// STEP 2: AMBIL MASTER DATA KLIEN DARI WORKER PUSAT & SINKRONISASI KLIEN
// ============================================================================
async function fetchClientsFromPusat() {
  if (!MASS_UPDATE_PASSWORD) {
    throw new Error('Secret MASS_UPDATE_PASSWORD belum dikonfigurasi!');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET;
  }

  const res = await fetch(`${PUSAT_WORKER_URL}/api/internal/master-data`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ adminPassword: MASS_UPDATE_PASSWORD })
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Worker Pusat mengembalikan respons non-JSON: ${text.slice(0, 250)}`);
  }

  if (!res.ok || data.error) {
    throw new Error(`Gagal menarik data klien dari Worker Pusat: ${JSON.stringify(data)}`);
  }

  return Array.isArray(data.clients) ? data.clients : [];
}

async function syncClientsCloudflare(allEnvRows, syncReportRows) {
  console.log('\n=== 2. SINKRONISASI CLOUDFLARE SELURUH KLIEN ===');
  const clients = await fetchClientsFromPusat();
  console.log(`Ditemukan ${clients.length} total klien di D1 Pusat.`);

  const clientEnvRows = [];

  for (const client of clients) {
    let settings = {};
    try {
      settings = JSON.parse(client.settings || '{}');
    } catch {
      settings = {};
    }
    const secrets = (settings && typeof settings.secrets === 'object' && settings.secrets !== null)
      ? settings.secrets
      : {};

    const accountId = (client.account_id || settings.CF_ACCOUNT_ID || '').trim();
    const cfEmail = (secrets.CF_EMAIL || settings.CF_EMAIL || client.email || '').trim();
    const cfGlobalKey = (secrets.CF_GLOBAL_KEY || settings.CF_GLOBAL_KEY || '').trim();
    const fallbackToken = (client.token || secrets.CF_API_TOKEN || '').trim();

    // Prioritaskan Global API Key + Email klien sesuai permintaan
    const cfHeaders = buildCfAuthHeaders({
      email: cfEmail,
      globalKey: cfGlobalKey,
      apiToken: fallbackToken
    });

    const authMethodUsed = (cfEmail && cfGlobalKey) ? 'GLOBAL_API_KEY' : (fallbackToken ? 'API_TOKEN_FALLBACK' : 'NONE');
    const primaryWorker = client.worker_name || 'unknown-worker';

    if (!accountId || !cfHeaders) {
      console.warn(`⚠️ [SKIP] ${primaryWorker}: account_id atau Global API Key/Email kosong.`);
      syncReportRows.push({
        scope: 'CLIENT',
        owner_identifier: primaryWorker,
        account_id: accountId || 'MISSING',
        status: 'SKIPPED',
        workers_synced: 0,
        d1_tables_exported: 0,
        note: 'CF_ACCOUNT_ID atau CF_EMAIL/CF_GLOBAL_KEY belum tersedia',
        synced_at: SYNC_TIMESTAMP
      });
      continue;
    }

    console.log(`\nMemproses klien: ${primaryWorker} (${client.domain || '-'}) [Auth: ${authMethodUsed}]`);
    let workersCount = 0;
    let d1TablesCount = 0;
    const notes = [`auth=${authMethodUsed}`];

    // A. Ambil semua Worker milik klien (worker utama + worker lain di akun klien tersebut)
    const workerNamesSet = new Set([primaryWorker]);
    try {
      const accountScripts = await listAccountWorkers(accountId, cfHeaders);
      for (const s of accountScripts) {
        if (s.id) workerNamesSet.add(s.id);
      }
    } catch (err) {
      notes.push(`list_workers_err=${err.message}`);
    }

    for (const wName of workerNamesSet) {
      try {
        const bindings = await getWorkerEnvBindings(accountId, wName, cfHeaders);
        workersCount++;
        for (const b of bindings) {
          const row = {
            scope: 'CLIENT',
            owner_name: primaryWorker,
            worker_name: wName,
            domain: client.domain || '',
            account_id: accountId,
            binding_name: b.binding_name,
            binding_type: b.binding_type,
            category: b.category,
            value_or_reference: b.value_or_reference,
            synced_at: SYNC_TIMESTAMP
          };
          clientEnvRows.push(row);
          allEnvRows.push(row);
        }
        console.log(`  [Worker OK] ${wName}: ${bindings.length} env/binding tercatat.`);
      } catch (err) {
        console.error(`  [Worker GAGAL] ${wName}: ${err.message}`);
        notes.push(`worker_${wName}_err=${err.message}`);
      }
    }

    // B. Ekspor Database D1 milik klien
    try {
      const d1Targets = [];
      if (client.database_id) {
        d1Targets.push({ id: client.database_id, name: `db-${primaryWorker}` });
      }
      // Auto-discover D1 tambahan di akun klien jika ada
      try {
        const discoveredDbs = await listAccountD1Databases(accountId, cfHeaders);
        for (const db of discoveredDbs) {
          const id = db.uuid || db.id;
          if (id && !d1Targets.some(t => t.id === id)) {
            d1Targets.push({ id, name: db.name || id });
          }
        }
      } catch {
        // Gunakan client.database_id yang sudah tercatat di D1 Pusat
      }

      for (const dbTarget of d1Targets) {
        const folderName = d1Targets.length === 1
          ? sanitizeFileName(primaryWorker)
          : `${sanitizeFileName(primaryWorker)}__${sanitizeFileName(dbTarget.name)}`;

        const count = await exportD1DatabaseToCsv({
          accountId,
          databaseId: dbTarget.id,
          dbLabel: `${primaryWorker} -> ${dbTarget.name}`,
          cfHeaders,
          outputFolder: path.join(EXPORT_DIR, 'D1_Clients', folderName)
        });
        d1TablesCount += count;
      }
    } catch (err) {
      console.error(`  [D1 GAGAL] ${primaryWorker}: ${err.message}`);
      notes.push(`d1_err=${err.message}`);
    }

    syncReportRows.push({
      scope: 'CLIENT',
      owner_identifier: primaryWorker,
      account_id: accountId,
      status: workersCount > 0 || d1TablesCount > 0 ? 'SUCCESS' : 'FAILED',
      workers_synced: workersCount,
      d1_tables_exported: d1TablesCount,
      note: notes.join(' | '),
      synced_at: SYNC_TIMESTAMP
    });
  }

  writeCsvFile(
    path.join(EXPORT_DIR, 'Workers_Env', 'clients_workers_env.csv'),
    ['scope', 'owner_name', 'worker_name', 'domain', 'account_id', 'binding_name', 'binding_type', 'category', 'value_or_reference', 'synced_at'],
    clientEnvRows
  );
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  console.log(`Memulai sinkronisasi Cloudflare -> Google Drive (${SYNC_TIMESTAMP})...`);
  fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
  ensureDir(EXPORT_DIR);

  const allEnvRows = [];
  const syncReportRows = [];

  await syncPersonalCloudflare(allEnvRows, syncReportRows);
  await syncClientsCloudflare(allEnvRows, syncReportRows);

  // Tulis file gabungan seluruh Env (Milik Anda + Semua Klien) & Laporan Sync
  writeCsvFile(
    path.join(EXPORT_DIR, 'Workers_Env', 'all_workers_env.csv'),
    ['scope', 'owner_name', 'worker_name', 'domain', 'account_id', 'binding_name', 'binding_type', 'category', 'value_or_reference', 'synced_at'],
    allEnvRows
  );

  writeCsvFile(
    path.join(EXPORT_DIR, '_sync_report.csv'),
    ['scope', 'owner_identifier', 'account_id', 'status', 'workers_synced', 'd1_tables_exported', 'note', 'synced_at'],
    syncReportRows
  );

  console.log('\n✅ Semua file CSV berhasil dibuat di ./gdrive_cf_export dan siap di-sync ke Google Drive!');
}

main().catch(err => {
  console.error('❌ Fatal Error:', err);
  process.exit(1);
});