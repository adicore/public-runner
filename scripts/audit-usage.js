// public-runner/scripts/audit-usage.js
import fetch from 'node-fetch';

const PUSAT_API_URL = process.env.PUSAT_API_URL ? process.env.PUSAT_API_URL.replace(/\/$/, '') : '';
const ADMIN_PASSWORD = process.env.MASS_UPDATE_PASSWORD;
const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';

// Helper untuk menyusun header request ke Worker Pusat (termasuk bypass Zero Trust)
function getPusatHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

async function runAudit() {
  if (!PUSAT_API_URL || !ADMIN_PASSWORD) {
    console.error("❌ Error: Secrets PUSAT_API_URL atau MASS_UPDATE_PASSWORD belum dikonfigurasi di GitHub Secrets!");
    process.exit(1);
  }

  console.log("Menarik data master klien dari Worker Pusat...");
  const masterRes = await fetch(`${PUSAT_API_URL}/api/internal/master-data`, {
    method: 'POST',
    headers: getPusatHeaders(),
    body: JSON.stringify({ adminPassword: ADMIN_PASSWORD })
  });

  const masterText = await masterRes.text();
  let masterData;
  try {
    masterData = JSON.parse(masterText);
  } catch (err) {
    console.error("❌ Worker Pusat mengembalikan respons bukan JSON (Terblokir Zero Trust / Route Error):");
    console.error(masterText.substring(0, 300));
    process.exit(1);
  }

  if (!masterRes.ok || masterData.error) {
    console.error("❌ Gagal menarik master data:", masterData);
    process.exit(1);
  }

  const clients = masterData.clients || [];
  console.log(`Ditemukan ${clients.length} klien untuk diaudit.`);
  const auditResults = [];

  for (const client of clients) {
    let settings = {};
    try { settings = JSON.parse(client.settings || '{}'); } catch(e){}
    const secrets = settings.secrets || {};
    
    const cfEmail = secrets.CF_EMAIL || settings.CF_EMAIL;
    const cfGlobalKey = secrets.CF_GLOBAL_KEY || settings.CF_GLOBAL_KEY;
    const accountId = client.account_id || settings.CF_ACCOUNT_ID;
    const githubOwner = settings.GITHUB_OWNER || secrets.GITHUB_OWNER;
    const githubPat = secrets.GITHUB_PAT || secrets.GITHUB_TOKEN;

    const metrics = {
      worker_name: client.worker_name,
      updated_at: new Date().toISOString(),
      worker: { requests_24h: 0, errors_24h: 0, cpu_avg_ms: 0, cpu_p99_ms: 0 },
      kv: { reads_24h: 0, writes_24h: 0, storage_mb: 0 },
      d1: { rows_read_24h: 0, rows_written_24h: 0, storage_mb: 0 },
      github: { minutes_used: 0, minutes_limit: 2000 }
    };

    if (cfEmail && cfGlobalKey && accountId) {
      try {
        const datetimeStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const graphqlQuery = {
          query: `
            query GetMetrics($accountId: String!, $scriptName: String!, $datetimeStart: String!) {
              viewer {
                accounts(filter: {accountTag: $accountId}) {
                  workersInvocationsAdaptive(filter: {scriptName: $scriptName, datetime_geq: $datetimeStart}, limit: 1000) {
                    sum { requests errors }
                    quantiles { cpuTimeP50 cpuTimeP99 }
                  }
                  kvOperationsAdaptive(filter: {datetime_geq: $datetimeStart}, limit: 1000) {
                    sum { requests }
                    dimensions { action }
                  }
                }
              }
            }
          `,
          variables: { accountId, scriptName: client.worker_name, datetimeStart }
        };

        const cfRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
          method: 'POST',
          headers: {
            'X-Auth-Email': cfEmail,
            'X-Auth-Key': cfGlobalKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(graphqlQuery)
        });
        const cfData = await cfRes.json();
        const accountData = cfData?.data?.viewer?.accounts?.[0];

        if (accountData) {
          const workerData = accountData.workersInvocationsAdaptive?.[0];
          if (workerData) {
            metrics.worker.requests_24h = workerData.sum?.requests || 0;
            metrics.worker.errors_24h = workerData.sum?.errors || 0;
            metrics.worker.cpu_avg_ms = ((workerData.quantiles?.cpuTimeP50 || 0) / 1000).toFixed(2);
            metrics.worker.cpu_p99_ms = ((workerData.quantiles?.cpuTimeP99 || 0) / 1000).toFixed(2);
          }

          const kvOps = accountData.kvOperationsAdaptive || [];
          kvOps.forEach(op => {
            if (op.dimensions?.action === 'read') metrics.kv.reads_24h += op.sum?.requests || 0;
            if (op.dimensions?.action === 'write') metrics.kv.writes_24h += op.sum?.requests || 0;
          });
        }
      } catch (err) {
        console.error(`Gagal audit Cloudflare (${client.worker_name}):`, err.message);
      }
    }

    if (githubOwner && githubPat) {
      try {
        const ghRes = await fetch(`https://api.github.com/users/${githubOwner}/settings/billing/actions`, {
          headers: {
            'Authorization': `Bearer ${githubPat}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'CMS-Audit'
          }
        });
        if (ghRes.ok) {
          const ghBilling = await ghRes.json();
          metrics.github.minutes_used = ghBilling.total_minutes_used || 0;
          metrics.github.minutes_limit = ghBilling.included_minutes || 2000;
        }
      } catch (err) {
        console.error(`Gagal audit GitHub Billing (${githubOwner}):`, err.message);
      }
    }

    auditResults.push(metrics);
  }

  console.log(`Mengirimkan ${auditResults.length} hasil audit ke D1 Pusat...`);
  const saveRes = await fetch(`${PUSAT_API_URL}/api/complete-usage-audit`, {
    method: 'POST',
    headers: getPusatHeaders(),
    body: JSON.stringify({
      adminPassword: ADMIN_PASSWORD,
      auditData: auditResults
    })
  });

  const responseText = await saveRes.text();
  let saveResult;

  try {
    saveResult = JSON.parse(responseText);
  } catch (err) {
    console.error("❌ Worker Pusat mengembalikan respons bukan JSON saat menyimpan hasil audit:");
    console.error(responseText.substring(0, 300));
    process.exit(1);
  }

  if (!saveRes.ok || saveResult.error) {
    console.error("❌ Gagal menyimpan ke D1 Pusat:", saveResult);
    process.exit(1);
  }

  console.log("✅ Audit kuota massal selesai & berhasil disimpan ke D1 Pusat!");
}

runAudit().catch(err => {
  console.error("❌ Fatal error saat eksekusi audit-usage.js:", err.message || err);
  process.exit(1);
});