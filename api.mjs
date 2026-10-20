const MAX_BODY = 24 * 1024;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function text(value, field, max, { optional = false, min = 1 } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) {
    throw new ApiError(400, `${field} må være tekst på ${min}–${max} tegn.`);
  }
  return value.trim();
}

export function dateValue(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'Frist må være en gyldig dato (ÅÅÅÅ-MM-DD).');
  }
  return value;
}

export function checkFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Forventet et JSON-objekt.');
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new ApiError(400, 'Forespørselen inneholder ukjente felt.');
}

export async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'Bruk Content-Type: application/json.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'Forespørselen er for stor.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Ugyldig JSON.');
  }
}
