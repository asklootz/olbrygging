import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = resolve(process.env.DATA_FILE ?? resolve(root, 'data/workspace.json'));
if (existsSync(dataFile)) {
  console.log(`Demo workspace already exists at ${dataFile}; leaving it unchanged.`);
} else {
  // Demo mode seeds and persists the workspace without listening or contacting a backend.
  createApp({ pocketbaseUrl: '', pocketbaseAdminEmail: '', pocketbaseAdminPassword: '', dataFile });
  console.log(`Seeded the demo workspace at ${dataFile}.`);
}