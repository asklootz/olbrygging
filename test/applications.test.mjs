import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import application from '../pb_hooks/application.cjs';

const validApplication = {
  name: ' Test Applicant ', phone: '+47 123 45 678', email: 'APPLICANT@example.invalid',
  addressLine1: 'Testveien 12', addressLine2: 'Leilighet 2', postalCode: '0123', city: 'Oslo',
  region: 'Oslo', country: 'Norge',
  socialLinks: { instagram: 'https://www.instagram.com/test', facebook: '', tiktok: '', twitter: '', bluesky: '', youtube: 'https://www.youtube.com/@test' }, termsAccepted: true,
};
const validate = (input) => application.validateApplication(input, (message) => new Error(message));

test('application validation normalizes contact data and preserves independent social links and postal zeros', () => {
  const result = validate(validApplication);
  assert.equal(result.name, 'Test Applicant');
  assert.equal(result.email, 'applicant@example.invalid');
  assert.equal(result.postalCode, '0123');
  assert.deepEqual(result.socialLinks, validApplication.socialLinks);
  assert.equal(validate({ ...validApplication, addressLine2: undefined, region: undefined }).addressLine2, '');
});

test('applications reject missing contact/address, malformed links, absent consent and forged metadata', () => {
  const invalid = [null, [], {}, ...['name', 'phone', 'email', 'addressLine1', 'postalCode', 'city', 'country'].map((key) => ({ ...validApplication, [key]: '' }))];
  for (const changes of [
    { termsAccepted: false }, { termsAccepted: 'true' }, { termsAccepted: undefined },
    { phone: '123' }, { phone: '+47 not-a-phone' }, { email: 'bad email' },
    { socialLinks: {} }, { socialLinks: [] }, { socialLinks: null },
    { socialLinks: { instagram: 'javascript:alert(1)' } }, { socialLinks: { instagram: 'http://www.instagram.com/test' } },
    { socialLinks: { instagram: 'https://user:password@instagram.com/profile' } }, { socialLinks: { instagram: 'https://instagram.com:443/profile' } },
    { socialLinks: { instagram: 'https://instagram.com\\evil' } }, { socialLinks: { unknown: 'https://instagram.com/test' } },
    { socialLinks: { instagram: 'https://facebook.com/test' } }, { socialLinks: { twitter: 'https://instagram.com/test' } },
    { socialLinks: { instagram: 'https://instagram.com/' + 'a'.repeat(1000) } }, { socialLinks: { instagram: null } },
    { socialLinks: { instagram: 'https://instagram.com/test', facebook: 'https://instagram.com/test' } },
    { name: 'Name\nInjected' }, { userId: 'ambassador00001' }, { status: 'approved' },
    { termsVersion: 'forged' }, { termsAcceptedAt: '2020-01-01' }, { password: 'not-allowed' },
  ]) invalid.push({ ...validApplication, ...changes });
  for (const input of invalid) assert.throws(() => validate(input));
});

test('the exact same validator runs in PocketBase without Node or browser-only APIs', () => {
  const context = createContext({ module: { exports: {} } });
  runInContext(readFileSync(new URL('../pb_hooks/application.cjs', import.meta.url), 'utf8'), context);
  context.input = validApplication;
  const result = runInContext('module.exports.validateApplication(input, message => new Error(message))', context);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), validate(validApplication));
});