const MAX_BODY = 24 * 1024;
export const MAX_MEDIA_FILES = 5;
export const MAX_MEDIA_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_MEDIA_TOTAL_SIZE = 30 * 1024 * 1024;

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

export function promotionQuantity(value = 1) {
  if ((typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,2}$/.test(value)))
    || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 50) {
    throw new ApiError(400, 'Antall promoteringsoppgaver må være et heltall fra 1 til 50.');
  }
  return Number(value);
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

export async function readMultipart(req) {
  if (!/^multipart\/form-data\s*;/i.test(req.headers['content-type'] || '')) {
    throw new ApiError(415, 'Last opp filer med multipart/form-data.');
  }
  const maxBody = MAX_MEDIA_TOTAL_SIZE + 256 * 1024;
  const declaredSize = Number(req.headers['content-length']);
  if (Number.isFinite(declaredSize) && declaredSize > maxBody) throw new ApiError(413, 'Opplastingen er for stor.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new ApiError(413, 'Opplastingen er for stor.');
    chunks.push(chunk);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': req.headers['content-type'] },
    }).formData();
  } catch {
    throw new ApiError(400, 'Ugyldig filopplasting.');
  }
}

export function validateSubmission(form) {
  if ([...form.keys()].some((key) => !['files', 'caption', 'link'].includes(key))) {
    throw new ApiError(400, 'Opplastingen inneholder ukjente felt.');
  }
  if (form.getAll('caption').length > 1 || form.getAll('link').length > 1) {
    throw new ApiError(400, 'Bildetekst og lenke kan bare oppgis én gang.');
  }
  const captionValue = form.get('caption') ?? '';
  if (typeof captionValue !== 'string' || captionValue.length > 1500) throw new ApiError(400, 'Bildeteksten kan ikke være lengre enn 1500 tegn.');
  const linkValue = form.get('link') ?? '';
  let link = '';
  if (typeof linkValue !== 'string' || linkValue.length > 2000) throw new ApiError(400, 'Lenken er ugyldig eller for lang.');
  if (linkValue.trim()) {
    let url;
    try { url = new URL(linkValue.trim()); } catch { throw new ApiError(400, 'Oppgi en gyldig HTTPS-lenke.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new ApiError(400, 'Lenken må bruke HTTPS.');
    link = url.href;
  }
  const entries = [...form.entries()].filter(([key]) => key === 'files');
  if (!entries.length || entries.length > MAX_MEDIA_FILES) throw new ApiError(400, `Velg mellom 1 og ${MAX_MEDIA_FILES} bilder eller videoer.`);
  let total = 0;
  const files = entries.map(([, file]) => {
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') throw new ApiError(400, 'Ugyldig mediefil.');
    if (!file.size || file.size > MAX_MEDIA_FILE_SIZE) throw new ApiError(413, 'Hver fil må være mindre enn 20 MB.');
    total += file.size;
    if (total > MAX_MEDIA_TOTAL_SIZE) throw new ApiError(413, 'Samlet opplasting kan ikke overstige 30 MB.');
    return file.arrayBuffer().then((arrayBuffer) => {
      const data = Buffer.from(arrayBuffer);
      const type = mediaType(data);
      if (!type || type !== file.type) throw new ApiError(400, 'Bare gyldige JPEG-, PNG- eller WebP-bilder og MP4- eller WebM-videoer støttes.');
      const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm' })[type];
      const safeName = file.name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
      const baseName = safeName.replace(/\.[a-z0-9]+$/i, '') || 'media';
      return { name: `${baseName}${extension}`, type, size: data.length, data };
    });
  });
  return Promise.all(files).then((validatedFiles) => ({
    caption: captionValue.trim(), link, files: validatedFiles,
  }));
}

function mediaType(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (data.length >= 12 && data.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return '';
}
