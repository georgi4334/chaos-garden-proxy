// Keeps contracts/ in step with the source of truth in the Chaos-Garden repo.
//   node scripts/contract.mjs check   local copy unedited, and identical to the source
//   node scripts/contract.mjs sync    replace the local copy with the source's files
// CONTRACT_SOURCE overrides where the source lives: an https:// URL or a local folder path.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const local = resolve(dirname(fileURLToPath(import.meta.url)), '../contracts');
const source = process.env.CONTRACT_SOURCE ?? 'https://raw.githubusercontent.com/georgi4334/Chaos-Garden/main/contracts/';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function readSource(path) {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(new URL(path, source.endsWith('/') ? source : `${source}/`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path} from the contract source: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const file = join(source, path);
  return existsSync(file) ? readFileSync(file) : null;
}

const localManifest = JSON.parse(readFileSync(join(local, 'manifest.json'), 'utf8'));

async function check() {
  let ok = true;
  // 1. Nobody edited the copy by hand.
  for (const [file, hash] of Object.entries(localManifest.files)) {
    const path = join(local, file);
    if (!existsSync(path)) {
      console.error(`missing: contracts/${file}`);
      ok = false;
    } else if (sha256(readFileSync(path)) !== hash) {
      console.error(`edited locally: contracts/${file} (change the contract in Chaos-Garden, then sync)`);
      ok = false;
    }
  }
  // 2. The copy matches the source of truth.
  const remote = await readSource('manifest.json');
  if (remote === null) {
    console.warn(`warning: no contract published at ${source} yet; only the local copy was checked`);
  } else {
    const upstream = JSON.parse(remote.toString('utf8')).files;
    const names = new Set([...Object.keys(upstream), ...Object.keys(localManifest.files)]);
    for (const file of [...names].sort()) {
      if (upstream[file] === localManifest.files[file]) continue;
      ok = false;
      if (!(file in upstream)) console.error(`only in this copy: ${file}`);
      else if (!(file in localManifest.files)) console.error(`only in the source: ${file}`);
      else console.error(`differs from the source: ${file}`);
    }
  }
  if (!ok) {
    console.error('\nThe contract copy is out of step. Run `npm run contract:sync`, then check the producer still passes its tests.');
    process.exit(1);
  }
  console.log(`contract copy OK (${Object.keys(localManifest.files).length} files${remote === null ? ', local check only' : ', matches the source'})`);
}

async function sync() {
  const remote = await readSource('manifest.json');
  if (remote === null) throw new Error(`no contract published at ${source}`);
  const manifest = JSON.parse(remote.toString('utf8'));
  for (const [file, hash] of Object.entries(manifest.files)) {
    const body = await readSource(file);
    if (body === null || sha256(body) !== hash) throw new Error(`source file ${file} is missing or doesn't match its manifest`);
    mkdirSync(dirname(join(local, file)), { recursive: true });
    writeFileSync(join(local, file), body);
  }
  for (const file of Object.keys(localManifest.files)) {
    if (!(file in manifest.files)) rmSync(join(local, file), { force: true }); // removed upstream
  }
  writeFileSync(join(local, 'manifest.json'), remote);
  console.log(`synced ${Object.keys(manifest.files).length} contract files from ${source}`);
}

const command = process.argv[2];
if (command === 'check') await check();
else if (command === 'sync') await sync();
else {
  console.error('usage: node scripts/contract.mjs check|sync');
  process.exit(2);
}
