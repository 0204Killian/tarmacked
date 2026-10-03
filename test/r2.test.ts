// The R2 uploader's request signing (scripts/pipeline/r2.js), against
// Amazon's published Signature V4 examples for S3.
//   npx tsx test/r2.test.ts
declare const require: any;
declare const __dirname: string;
const { sign } = require('../scripts/pipeline/r2.js');

const results: boolean[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `\n      ${info}` : ''}`);
};
const base = {
  host: 'examplebucket.s3.amazonaws.com',
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  now: new Date('2013-05-24T00:00:00Z'),
  payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};
const sigOf = (h: any) => /Signature=([0-9a-f]+)/.exec(h.Authorization)![1];
const get = sign({ ...base, method: 'GET', path: '/test.txt', headers: { Range: 'bytes=0-9' } });
check('GET object signed as in the S3 docs', sigOf(get) === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', get.Authorization);
const list = sign({ ...base, method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' } });
check('list (query string) signed as in the S3 docs', sigOf(list) === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7', list.Authorization);
const put = sign({
  ...base,
  method: 'PUT',
  path: '/test$file.text',
  headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
  payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
});
check('PUT object (a $ in the name) signed as in the S3 docs', sigOf(put) === '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd', put.Authorization);

// The client against a fake R2 (in memory): upload a folder, read, list
// folders, delete a version, and ride out a busy moment.
(async () => {
  const http = require('http');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync, execFile } = require('child_process');
  const store = new Map<string, { body: Buffer; type: string; cache: string }>();
  let busy = 3; // the first few uploads get "try again later"
  let unsigned = 0;
  const server = http.createServer((req: any, res: any) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!/^AWS4-HMAC-SHA256 Credential=key\//.test(req.headers.authorization || '')) unsigned++;
      const url = new URL(req.url, 'http://x');
      const key = decodeURIComponent(url.pathname.replace(/^\/tarmacked-tiles\/?/, ''));
      if (req.method === 'PUT') {
        if (busy-- > 0) return res.writeHead(503).end();
        store.set(key, { body: Buffer.concat(chunks), type: req.headers['content-type'], cache: req.headers['cache-control'] });
        return res.writeHead(200).end();
      }
      if (req.method === 'DELETE') {
        store.delete(key);
        return res.writeHead(204).end();
      }
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const delim = url.searchParams.get('delimiter');
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        const dirs = new Set<string>();
        const files: string[] = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length);
          if (delim && rest.includes(delim)) dirs.add(prefix + rest.slice(0, rest.indexOf(delim) + 1));
          else files.push(k);
        }
        // Two keys per page, to exercise paging.
        const start = Number(url.searchParams.get('continuation-token') || 0);
        const page = files.slice(start, start + 2);
        const more = start + 2 < files.length;
        const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}${start === 0 ? [...dirs].map((d) => `<CommonPrefixes><Prefix>${d}</Prefix></CommonPrefixes>`).join('') : ''}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ''}</ListBucketResult>`;
        return res.writeHead(200, { 'content-type': 'application/xml' }).end(xml);
      }
      const v = store.get(key);
      if (!v) return res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      res.writeHead(200).end(v.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const env = { ...process.env, R2_ENDPOINT: `http://127.0.0.1:${server.address().port}`, R2_ACCOUNT_ID: 'acct\n', R2_ACCESS_KEY_ID: ' key', R2_SECRET_ACCESS_KEY: 'secret\n' };
  const r2 = path.join(__dirname, '../scripts/pipeline/r2.js');
  const run = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile('node', [r2, ...args], { env }, (err: any, out: string) => resolve({ code: err ? err.code : 0, out })),
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-'));
  for (let i = 0; i < 7; i++) fs.writeFileSync(path.join(dir, `t_${i}.json`), JSON.stringify({ i }));
  const up = await run(['upload', dir, 'ie/v2', 'public, max-age=31536000, immutable']);
  const t3 = store.get('ie/v2/t_3.json');
  check('upload: every file, with its type and caching, through a busy moment', up.code === 0 && [...store.keys()].length === 7 && t3?.type === 'application/json' && /immutable/.test(t3.cache) && unsigned === 0, up.out.trim());
  store.set('ie/v1/a.json', { body: Buffer.from('{}'), type: '', cache: '' });
  store.set('manifest.json', { body: Buffer.from('{"v":1}'), type: '', cache: '' });
  const cat = await run(['cat', 'manifest.json']);
  const missing = await run(['cat', 'nope.json']);
  check('cat: reads a file; a missing one exits with 2', cat.out === '{"v":1}' && missing.code === 2);
  const dirs = await run(['dirs', 'ie']);
  check('dirs: the version folders', dirs.out.trim().split('\n').join() === 'ie/v1/,ie/v2/', dirs.out.trim());
  const purge = await run(['purge', 'ie/v2']);
  check('purge: everything under one version (over several pages), nothing else', purge.code === 0 && ![...store.keys()].some((k) => k.startsWith('ie/v2/')) && store.has('ie/v1/a.json') && store.has('manifest.json'));
  const broad = await run(['purge', 'ie']);
  check("purge refuses something as broad as a whole region", broad.code !== 0 && store.has('ie/v1/a.json'));
  server.close();
  console.log(results.every(Boolean) ? '\nALL PASS' : '\nSOME FAILED');
})();
