import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(exec);

export class SfError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const cfg = () => ({
  instanceUrl: (process.env.SF_INSTANCE_URL || '').replace(/\/$/, ''),
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  cliOrg: process.env.SF_CLI_ORG,
  apiVersion: process.env.SF_API_VERSION || 'v62.0',
});

export const authMode = () => {
  const { clientId, clientSecret } = cfg();
  return clientId && clientSecret ? 'client_credentials' : 'sf_cli';
};

export const quotePath = (id = '') => `/services/apexrest/api/quotes/${id}`;

function errorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === 'string') return data.error; // Apex REST { error }
  if (Array.isArray(data) && data[0]?.message) return data[0].message; // platform REST [{ message }]
  return data.message || fallback;
}

const tryParse = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------------------------------
 * Transport 1 (production): OAuth 2.0 Client Credentials, exactly as in the API documentation.
 * ---------------------------------------------------------------------------------------- */
let session = null; // { token, instanceUrl }

async function tokenViaClientCredentials() {
  const { instanceUrl, clientId, clientSecret } = cfg();
  if (!instanceUrl) throw new SfError('SF_INSTANCE_URL is not configured', 500);
  const res = await fetch(`${instanceUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new SfError('Failed to authenticate with Salesforce');
  const data = await res.json();
  return { token: data.access_token, instanceUrl: data.instance_url || instanceUrl };
}

async function oauthFetch(pathAndQuery, { method = 'GET', body } = {}, retried = false) {
  if (!session || retried) session = await tokenViaClientCredentials();
  const res = await fetch(`${session.instanceUrl}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) return oauthFetch(pathAndQuery, { method, body }, true); // token expired

  const data = tryParse(await res.text());
  if (!res.ok) {
    throw new SfError(errorMessage(data, `Salesforce request failed (${res.status})`), res.status === 401 ? 502 : res.status);
  }
  return data;
}

const oauthTransport = {
  async soql(query) {
    const { apiVersion } = cfg();
    let page = await oauthFetch(`/services/data/${apiVersion}/query?q=${encodeURIComponent(query)}`);
    const records = [...page.records];
    while (page.nextRecordsUrl) {
      page = await oauthFetch(page.nextRecordsUrl);
      records.push(...page.records);
    }
    return records;
  },
  apex: (method, apexPath, body) => oauthFetch(apexPath, { method, body }),
};

/* ------------------------------------------------------------------------------------------
 * Transport 2 (local development): drive the Salesforce CLI, which owns the login session.
 * The access token is never read or exposed - the CLI makes the calls itself.
 * ---------------------------------------------------------------------------------------- */
function cliOrg() {
  const { cliOrg: org } = cfg();
  if (!org || !/^[\w.@+-]+$/.test(org)) {
    throw new SfError('Set SF_CLIENT_ID/SF_CLIENT_SECRET, or SF_CLI_ORG for local development', 500);
  }
  return org;
}

// The CLI reads SF_* variables itself, so this app's own SF_* settings (loaded from .env)
// must not leak into it - they change which org/API it talks to.
const cliEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SF_')));

// Runs a CLI command; returns parsed stdout even when the CLI exits non-zero (it does so on HTTP errors).
async function cli(command) {
  try {
    const { stdout } = await run(command, { maxBuffer: 50_000_000, env: cliEnv() });
    return tryParse(stdout);
  } catch (err) {
    const parsed = tryParse(err.stdout) ?? tryParse(err.stderr);
    if (parsed) return { __failed: true, ...parsed };
    console.error('[sf-cli] command failed:', err.message.split('\n')[0], (err.stderr || '').slice(0, 300));
    throw new SfError('Salesforce CLI call failed. Make sure you are logged in ("sf org login web").');
  }
}

const cliTransport = {
  async soql(query) {
    const { apiVersion } = cfg();
    const oneLine = query.replace(/\s+/g, ' ').trim();
    if (/["%^!`]/.test(oneLine)) throw new SfError('Query contains characters that are not allowed', 500);
    const out = await cli(`sf data query -o ${cliOrg()} --api-version ${apiVersion.replace(/^v/, '')} -q "${oneLine}" --json`);
    if (!out || out.status !== 0 || out.__failed) throw new SfError(out?.message || 'Salesforce query failed');
    return out.result.records;
  },

  async apex(method, apexPath, body) {
    let file = null;
    let bodyArg = '';
    if (body) {
      file = path.join(tmpdir(), `portal-${randomUUID()}.json`);
      await writeFile(file, JSON.stringify(body));
      bodyArg = ` --body "@${file}"`;
    }
    try {
      const out = await cli(`sf api request rest "${apexPath}" -o ${cliOrg()} -X ${method}${bodyArg}`);
      if (out === null) throw new SfError('Empty response from Salesforce');
      if (out.__failed || (out.error && typeof out.error === 'string')) {
        // Apex REST reports failures as { "error": "..." } (HTTP 400)
        throw new SfError(errorMessage(out, 'Salesforce request failed'), 400);
      }
      return out;
    } finally {
      if (file) unlink(file).catch(() => {});
    }
  },
};

const transport = () => (authMode() === 'client_credentials' ? oauthTransport : cliTransport);

export const soql = (query) => transport().soql(query);
export const callQuoteApi = (method, id, body) => transport().apex(method, quotePath(id), body);

// Creates records of any sobject type in one standard REST call (composite sobjects), all or nothing.
// records: [{ type, fields }]. Used to add the bundle structure and attribute values that the
// quote API itself cannot write.
export async function insertRecords(records) {
  // bundle relationship fields such as RootQuoteLineId only exist in recent API versions
  const version = process.env.SF_RECORD_API_VERSION || 'v67.0';
  const body = { allOrNone: true, records: records.map((r) => ({ attributes: { type: r.type }, ...r.fields })) };
  const results = await transport().apex('POST', `/services/data/${version}/composite/sobjects`, body);
  const failed = Array.isArray(results) ? results.filter((r) => !r.success) : [];
  if (failed.length) {
    const first = failed.find((r) => r.errors?.[0]?.statusCode !== 'ALL_OR_NONE_OPERATION_ROLLED_BACK') ?? failed[0];
    throw new SfError(first.errors?.[0]?.message || 'Could not save the quote details');
  }
  return results;
}
