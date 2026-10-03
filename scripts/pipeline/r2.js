// A small Cloudflare R2 client (S3 API, signed with AWS Signature V4) for
// the road-data upload. Plain Node 18+, no dependencies. Replaces rclone,
// whose uploads R2 kept refusing ("501 Not Implemented"): this sends plain
// PUTs with nothing R2 doesn't support (no checksum trailers, no ACLs).
//
// Keys from the environment: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY (spaces and new lines around them are ignored).
//
//   node r2.js upload <local dir> <key prefix> <cache-control>   every file in the dir
//   node r2.js put <file> <key> <cache-control>
//   node r2.js cat <key>                 prints it; exit 2 if it doesn't exist
//   node r2.js dirs <prefix>             "folders" under a prefix, one per line
//   node r2.js purge <prefix>            deletes everything under a prefix

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BUCKET = process.env.R2_BUCKET || 'tarmacked-tiles';
const clean = (v) => String(v || '').replace(/\s+/g, '');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// S3's URI encoding: everything but unreserved characters, '/' kept in paths.
const enc = (s, keepSlash) =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /$^/, '/');

/**
 * Signature V4 headers for a request. `now` is a Date (for tests).
 * Returns the headers to send (including Authorization).
 */
function sign({ method, host, path: p, query = {}, headers = {}, payloadHash, accessKey, secretKey, region = 'auto', service = 's3', now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((k) => `${k}:${lower[k]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(String(query[k]))}`)
    .join('&');
  const canonical = [method, enc(p, true), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${secretKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  const out = { ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function client() {
  const account = clean(process.env.R2_ACCOUNT_ID);
  const accessKey = clean(process.env.R2_ACCESS_KEY_ID);
  const secretKey = clean(process.env.R2_SECRET_ACCESS_KEY);
  if (!account || !accessKey || !secretKey) throw new Error('R2 keys missing: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  const host = `${account}.r2.cloudflarestorage.com`;
  const origin = process.env.R2_ENDPOINT || `https://${host}`; // tests point this at a fake

  async function request(method, key, { query = {}, body = null, headers = {} } = {}, tries = 6) {
    const p = `/${BUCKET}${key ? `/${key}` : ''}`;
    const payload = body ?? '';
    const payloadHash = sha256hex(payload);
    for (let attempt = 1; ; attempt++) {
      const h = sign({ method, host, path: p, query, headers, payloadHash, accessKey, secretKey });
      const qs = Object.keys(query).length ? `?${Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join('&')}` : '';
      let res;
      try {
        res = await fetch(`${origin}${enc(p, true)}${qs}`, { method, headers: h, body: body ?? undefined });
      } catch (e) {
        if (attempt >= tries) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      // Busy or a hiccup: wait and try again.
      if ((res.status >= 500 || res.status === 429) && attempt < tries) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      return res;
    }
  }

  async function ok(res, what) {
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? '';
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200);
    throw new Error(`${what}: HTTP ${res.status} ${code} ${msg}`.trim());
  }

  return {
    async put(key, body, contentType, cacheControl) {
      const headers = { 'content-type': contentType };
      if (cacheControl) headers['cache-control'] = cacheControl;
      await ok(await request('PUT', key, { body, headers }), `upload ${key}`);
    },
    async cat(key) {
      const res = await request('GET', key);
      if (res.status === 404) return null;
      return (await ok(res, `read ${key}`)).text();
    },
    // Keys (or "folders" with a delimiter) under a prefix, all pages.
    async list(prefix, delimiter) {
      const keys = [];
      const dirs = [];
      let token = null;
      do {
        const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
        if (delimiter) query.delimiter = delimiter;
        if (token) query['continuation-token'] = token;
        const xml = await (await ok(await request('GET', '', { query }), `list ${prefix}`)).text();
        for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>/g)) keys.push(unxml(m[1]));
        for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)) dirs.push(unxml(m[1]));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? '') : null;
      } while (token);
      return { keys, dirs };
    },
    async del(key) {
      const res = await request('DELETE', key);
      if (res.status !== 404) await ok(res, `delete ${key}`);
    },
  };
}

const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// Runs jobs `n` at a time.
async function pool(items, n, fn) {
  let i = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
      done++;
      if (done % 500 === 0) console.log(`  ${done}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

const TYPES = { '.json': 'application/json', '.txt': 'text/plain' };
const typeOf = (f) => TYPES[path.extname(f)] ?? 'application/octet-stream';

async function main() {
  const [cmd, a, b, c] = process.argv.slice(2);
  const r2 = client();
  if (cmd === 'upload') {
    const files = fs.readdirSync(a).filter((f) => fs.statSync(path.join(a, f)).isFile());
    const prefix = b.replace(/\/?$/, '/');
    console.log(`Uploading ${files.length} files to ${prefix} ...`);
    await pool(files, 24, (f) => r2.put(`${prefix}${f}`, fs.readFileSync(path.join(a, f)), typeOf(f), c));
    console.log(`  done: ${files.length} files`);
  } else if (cmd === 'put') {
    await r2.put(b, fs.readFileSync(a), typeOf(a), c);
  } else if (cmd === 'cat') {
    const text = await r2.cat(a);
    if (text === null) process.exit(2);
    process.stdout.write(text);
  } else if (cmd === 'dirs') {
    const { dirs } = await r2.list(a.replace(/\/?$/, '/'), '/');
    for (const d of dirs) console.log(d);
  } else if (cmd === 'purge') {
    const prefix = a.replace(/\/?$/, '/');
    if (prefix.split('/').filter(Boolean).length < 2) throw new Error(`won't purge "${prefix}": too broad`);
    const { keys } = await r2.list(prefix);
    console.log(`Deleting ${keys.length} files under ${prefix} ...`);
    await pool(keys, 24, (k) => r2.del(k));
  } else {
    throw new Error('Usage: node r2.js upload|put|cat|dirs|purge ...');
  }
}

module.exports = { sign, enc };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
