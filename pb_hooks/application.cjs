// Shared by the Node adapter and PocketBase's JavaScript runtime.
const TERMS_VERSION = '2026-10-30';
const SOCIAL_PLATFORMS = {
  instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.watch'], tiktok: ['tiktok.com'],
  twitter: ['x.com', 'twitter.com'], bluesky: ['bsky.app'], youtube: ['youtube.com', 'youtu.be'],
};
const APPLICATION_FIELDS = ['name', 'phone', 'email', 'addressLine1', 'addressLine2', 'postalCode', 'city', 'region', 'country', 'socialLinks', 'termsAccepted'];

function validateApplication(input, fail) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !APPLICATION_FIELDS.includes(key))) {
    throw fail('Søknaden inneholder ukjente eller ugyldige felt.');
  }
  function value(key, label, max, optional = false) {
    const raw = input[key] === undefined && optional ? '' : input[key];
    if (typeof raw !== 'string' || (!optional && !raw.trim()) || raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw fail(`${label} må fylles ut med gyldig tekst (maks ${max} tegn).`);
    }
    return raw.trim();
  }
  const result = {
    name: value('name', 'Navn', 160), phone: value('phone', 'Telefon', 40),
    email: value('email', 'E-post', 254).toLowerCase(),
    addressLine1: value('addressLine1', 'Gateadresse', 200), addressLine2: value('addressLine2', 'Adresselinje 2', 200, true),
    postalCode: value('postalCode', 'Postnummer', 20), city: value('city', 'Poststed', 100),
    region: value('region', 'Fylke / region', 100, true), country: value('country', 'Land', 100),
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw fail('Oppgi en gyldig e-postadresse.');
  if (!/^\+?[0-9 ()\-.]+$/.test(result.phone) || result.phone.replace(/\D/g, '').length < 6
    || result.phone.replace(/\D/g, '').length > 15) throw fail('Oppgi et gyldig telefonnummer, gjerne med landskode.');
  if (!input.socialLinks || typeof input.socialLinks !== 'object' || Array.isArray(input.socialLinks)
    || Object.keys(input.socialLinks).some((key) => !Object.prototype.hasOwnProperty.call(SOCIAL_PLATFORMS, key))) {
    throw fail('Bruk de egne feltene for Instagram, Facebook, TikTok, X/Twitter, Bluesky og YouTube.');
  }
  result.socialLinks = {};
  for (const [platform, domains] of Object.entries(SOCIAL_PLATFORMS)) {
    const raw = input.socialLinks[platform] === undefined ? '' : input.socialLinks[platform];
    if (typeof raw !== 'string' || raw.length > 1000 || /[\s\\<>\u0000-\u001f\u007f]/.test(raw)) {
      throw fail('Hver sosial lenke må være en HTTPS-adresse på maks 1000 tegn.');
    }
    const match = raw.match(/^https:\/\/([^/?#:@]+)(?:[/?#].*)?$/i);
    if (raw && (!match || match[1].length > 253 || !match[1].split('.').every((part) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)) || !match[1].includes('.'))) {
      throw fail('Bruk fullstendige HTTPS-lenker uten brukernavn, passord eller port.');
    }
    if (raw && !domains.some((domain) => match[1].toLowerCase() === domain || match[1].toLowerCase().endsWith(`.${domain}`))) {
      throw fail(`Lenken i feltet ${platform} må være fra ${domains.join(' eller ')}.`);
    }
    result.socialLinks[platform] = raw;
  }
  if (!Object.values(result.socialLinks).some(Boolean)) throw fail('Legg inn minst én sosial medieprofil.');
  const providedLinks = Object.values(result.socialLinks).filter(Boolean);
  if (new Set(providedLinks).size !== providedLinks.length) throw fail('Hver sosial lenke skal bare legges til én gang.');
  if (input.termsAccepted !== true) throw fail('Du må godta søknadsvilkårene før du sender søknaden.');
  result.termsAccepted = true;
  return result;
}

module.exports = { validateApplication, TERMS_VERSION, APPLICATION_FIELDS };