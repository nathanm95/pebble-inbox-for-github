// What the Pebble app does to every update before an app sees it (libpebble3
// ShapeValidation.kt, read 2026-11-04): a shape the manifest doesn't declare, or a payload that
// doesn't fit its shape, is dropped. A shortText longer than ~7 characters is only a warning.
//
// Tests treat any drop as a failure, so a plugin can't quietly lose a reading on the phone.

const SHORT_TEXT_GUIDE = 7;
const MAX_PALETTE = 16;
const TEXT_SHAPES = ['shortText', 'longText'];

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function base64Length(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
  return Buffer.from(value, 'base64').length;
}

function bitmapProblem(shape, fields, iconPixelSize) {
  if (!fields || typeof fields !== 'object') return `${shape} isn't an object`;
  const { width, height } = fields;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return `${shape} needs a positive width and height`;
  }
  if (iconPixelSize && (width > iconPixelSize.w || height > iconPixelSize.h)) {
    return `${shape} is ${width}x${height}, larger than the ${iconPixelSize.w}x${iconPixelSize.h} asked for`;
  }
  const pixels = base64Length(fields.pixels);
  const palette = base64Length(fields.palette);
  if (pixels === null) return `${shape}'s pixels aren't base64`;
  if (palette === null) return `${shape}'s palette isn't base64`;
  const expected = Math.floor((width + 1) / 2) * height;
  if (pixels !== expected) return `${shape} has ${pixels} pixel bytes, not the ${expected} ${width}x${height} needs`;
  if (palette === 0 || palette > MAX_PALETTE) return `${shape}'s palette has ${palette} colours, not 1-${MAX_PALETTE}`;
  return null;
}

function pointProblem(shape, reading, iconPixelSize, warn) {
  if (TEXT_SHAPES.includes(shape)) {
    if (typeof reading !== 'string') return `${shape} needs its text as a string`;
    if (shape === 'shortText' && reading.length > SHORT_TEXT_GUIDE) warn(`shortText "${reading}" is longer than ~${SHORT_TEXT_GUIDE} characters`);
    return null;
  }
  switch (shape) {
    case 'numericValue': return isNumber(reading) ? null : 'numericValue needs a number';
    case 'timestamp': return Number.isInteger(reading) ? null : 'timestamp needs whole epoch seconds';
    case 'boolean': return typeof reading === 'boolean' ? null : 'boolean needs true or false';
    case 'icon':
    case 'image': return bitmapProblem(shape, reading, iconPixelSize);
    default: return null;
  }
}

function sharedNumericProblem(fields) {
  if (fields.unit !== undefined && typeof fields.unit !== 'string') return "numericValue's unit must be a string";
  if ((fields.min === undefined) !== (fields.max === undefined)) return "numericValue's min and max come as a pair";
  if (fields.min !== undefined && (!isNumber(fields.min) || !isNumber(fields.max))) return "numericValue's min and max must be numbers";
  return null;
}

function shapeProblem(shape, payload, iconPixelSize, warn) {
  if (!payload || typeof payload !== 'object') return `${shape} isn't an object`;
  if (shape === 'icon' || shape === 'image') return bitmapProblem(shape, payload, iconPixelSize);
  const reading = TEXT_SHAPES.includes(shape) ? payload.text : payload.value;
  const problem = pointProblem(shape, reading, iconPixelSize, warn);
  if (problem) return problem;
  return shape === 'numericValue' ? sharedNumericProblem(payload) : null;
}

function seriesProblem(payload, declared, iconPixelSize, warn) {
  if (!payload || typeof payload !== 'object') return "series isn't an object";
  if (!declared.length) return "series isn't declared";
  const { start, stepSec } = payload;
  if ((start === undefined) !== (stepSec === undefined)) return "series' start and stepSec come as a pair";
  if (start !== undefined && !Number.isInteger(start)) return "series' start needs whole epoch seconds";
  if (stepSec !== undefined && !(Number.isInteger(stepSec) && stepSec > 0)) return "series' stepSec needs to be a positive whole number";
  const shapes = Object.keys(payload).filter((key) => key !== 'start' && key !== 'stepSec');
  if (!shapes.length) return 'series has no shapes';
  let length = null;
  for (const shape of shapes) {
    if (!declared.includes(shape)) return `series.${shape} isn't declared`;
    const series = payload[shape];
    if (!series || !Array.isArray(series.values)) return `series.${shape} needs values`;
    if (length !== null && series.values.length !== length) return "series' values aren't all the same length";
    length = series.values.length;
    for (const point of series.values) {
      if (point === null) continue;
      const problem = pointProblem(shape, point, iconPixelSize, warn);
      if (problem) return `series.${shape}: ${problem}`;
    }
    if (shape === 'numericValue') {
      const problem = sharedNumericProblem(series);
      if (problem) return `series.${shape}: ${problem}`;
    }
  }
  return null;
}

/** The source declaration serving category/item in a plugin manifest, or undefined. */
function declarationFor(plugin, category, item) {
  return (plugin.sources || []).find((source) => source.category === category && source.items.includes(item));
}

/**
 * Every problem the app would find with an envelope: { dropped: [...], warnings: [...] }.
 * Structure problems (no instances array, an instance without a string id) count as drops.
 */
function validateEnvelope(envelope, declaration, iconPixelSize) {
  const dropped = [];
  const warnings = [];
  if (!envelope || !Array.isArray(envelope.instances)) {
    return { dropped: ['envelope has no instances array'], warnings };
  }
  if (envelope.validUntilMs !== undefined && !isNumber(envelope.validUntilMs)) dropped.push('validUntilMs must be a number');
  const ids = new Set();
  for (const instance of envelope.instances) {
    if (typeof instance.instanceId !== 'string' || !instance.instanceId) dropped.push('an instance has no string instanceId');
    else if (ids.has(instance.instanceId)) dropped.push(`instanceId ${instance.instanceId} appears twice`);
    ids.add(instance.instanceId);
    for (const [property, shapes] of Object.entries(instance.properties || {})) {
      const declared = declaration.properties[property] || [];
      const seriesShapes = declared.filter((s) => s.startsWith('series.')).map((s) => s.slice('series.'.length));
      for (const [shape, payload] of Object.entries(shapes)) {
        const warn = (message) => warnings.push(`${instance.instanceId}.${property}: ${message}`);
        let problem;
        if (shape === 'series') problem = seriesProblem(payload, seriesShapes, iconPixelSize, warn);
        else if (!declared.includes(shape)) problem = `${shape} isn't declared`;
        else problem = shapeProblem(shape, payload, iconPixelSize, warn);
        if (problem) dropped.push(`${instance.instanceId}.${property}: ${problem}`);
      }
    }
  }
  return { dropped, warnings };
}

module.exports = { declarationFor, validateEnvelope, SHORT_TEXT_GUIDE };
