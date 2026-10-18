// The web shows API errors in Mongolian; every English message the API can send must get a translation.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { errorMessage } from '../../web/src/lib/errors';

/** Internal / developer-only messages a shop worker never triggers through the screens. */
const INTERNAL = /log_vehicles|Web order actor|Missing authenticated user|Unsupported payment method|E-Barimt issue failed|Unknown module|tickets$|does not belong|missing from inventory|zoneId is required|Customer linking|Invalid or inactive delivery|No delivery zone|external supplier|No remaining quantity|Hired transport|Cannot update transport|Transport can no longer|Cannot reconcile|refund is paid out|E-Barimt can only/;

function apiMessages(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) apiMessages(p, out);
    else if (p.endsWith('.ts')) {
      for (const m of readFileSync(p, 'utf8').matchAll(/Exception\((['`])([^'`]*)\1/g)) out.push(m[2].replace(/\$\{[^}]*\}/g, 'X'));
    }
  }
  return out;
}

describe('API errors in Mongolian', () => {
  it('keeps the Mongolian half of bilingual messages', () => {
    assert.equal(errorMessage(400, 'Дүн буруу / Amount is wrong'), 'Дүн буруу');
  });

  it('translates known messages, families, validation and bare statuses', () => {
    assert.equal(errorMessage(401, 'Invalid credentials'), 'Нэвтрэх нэр эсвэл нууц үг буруу байна.');
    assert.equal(errorMessage(404, 'Order not found'), 'Захиалга олдсонгүй.');
    assert.match(errorMessage(403, 'Only managers or admin can assign an external supplier'), /эрх/);
    assert.match(errorMessage(409, 'A payment just changed; reload and try again'), /шинэчлээд/);
    assert.match(errorMessage(400, ['quantity must be a positive number']), /«quantity»/);
    assert.match(errorMessage(500, undefined), /Системд алдаа/);
  });

  it('every English message the API can send to a shop worker has a translation', () => {
    const english = [...new Set(apiMessages(join(__dirname, '../src')))].filter((m) => !/[А-Яа-яӨөҮү]/.test(m) && !INTERNAL.test(m));
    const untranslated = english.filter((m) => errorMessage(400, m).includes(`(${m})`));
    assert.deepEqual(untranslated, []);
  });
});
