// The validator is what stands between a plugin and a silently dropped reading on the phone,
// so it has to catch what the app catches.

const test = require('node:test');
const assert = require('node:assert');
const { validateEnvelope } = require('./lib/validate.cjs');

const declaration = {
  properties: {
    name: ['shortText'],
    level: ['numericValue', 'shortText'],
    at: ['timestamp'],
    on: ['boolean'],
    art: ['icon'],
    hourly: ['series.numericValue'],
  },
};
const check = (properties, iconPixelSize) => validateEnvelope({ instances: [{ instanceId: 'a', properties }] }, declaration, iconPixelSize);
const icon = (w, h, pixelBytes, paletteBytes = 2) => ({
  width: w, height: h,
  pixels: Buffer.alloc(pixelBytes).toString('base64'),
  palette: Buffer.alloc(paletteBytes).toString('base64'),
});

test('a good envelope passes untouched', () => {
  const result = check({
    name: { shortText: { text: 'Here' } },
    level: { numericValue: { value: 3, unit: '%', min: 0, max: 10 }, shortText: { text: '3%' } },
    at: { timestamp: { value: 1700000000 } },
    on: { boolean: { value: true } },
    art: { icon: icon(5, 4, 12) },
    hourly: { series: { start: 1700000000, stepSec: 3600, numericValue: { values: [1, null, 3] } } },
  }, { w: 8, h: 8 });
  assert.deepStrictEqual(result, { dropped: [], warnings: [] });
});

test('what the app drops, this drops', () => {
  const cases = [
    [{ name: { longText: { text: 'x' } } }, "longText isn't declared"],
    [{ level: { numericValue: { value: '3' } } }, 'numericValue needs a number'],
    [{ level: { numericValue: { value: 3, min: 0 } } }, 'min and max come as a pair'],
    [{ at: { timestamp: { value: 1700000000.5 } } }, 'whole epoch seconds'],
    [{ on: { boolean: { value: 'yes' } } }, 'true or false'],
    [{ art: { icon: icon(5, 4, 10) } }, '10 pixel bytes, not the 12'],
    [{ art: { icon: icon(4, 4, 8, 17) } }, 'palette has 17 colours'],
    [{ hourly: { series: { start: 1, numericValue: { values: [1] } } } }, 'start and stepSec come as a pair'],
    [{ hourly: { series: { shortText: { values: ['a'] } } } }, "series.shortText isn't declared"],
    [{ undeclared: { shortText: { text: 'x' } } }, "shortText isn't declared"],
  ];
  for (const [properties, expected] of cases) {
    const { dropped } = check(properties);
    assert.strictEqual(dropped.length, 1, JSON.stringify(properties));
    assert.ok(dropped[0].includes(expected), `${dropped[0]} should mention ${expected}`);
  }
});

test('a bitmap bigger than asked for is dropped', () => {
  assert.strictEqual(check({ art: { icon: icon(10, 10, 50) } }, { w: 8, h: 8 }).dropped.length, 1);
});

test('a long shortText is kept, with a warning', () => {
  const result = check({ name: { shortText: { text: 'Much too long' } } });
  assert.deepStrictEqual(result.dropped, []);
  assert.strictEqual(result.warnings.length, 1);
});
