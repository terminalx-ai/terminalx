// Verify a Tauri updater artifact's minisign signature (<artifact>.sig) against the public key in
// src-tauri/tauri.conf.json, the way an installed app does before it installs an update.
// Usage, from the repository root: node scripts/release/verify-updater.mjs <path to TerminalX.app.tar.gz>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
const artifact = process.argv[2];
if (!artifact) throw new Error('Provide the artifact path');
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const publicLines = Buffer.from(config.plugins.updater.pubkey, 'base64').toString('utf8').trim().split('\n');
const publicKey = Buffer.from(publicLines[1], 'base64');
const lines = Buffer.from(readFileSync(`${artifact}.sig`, 'utf8').trim(), 'base64').toString('utf8').trim().split('\n');
const signature = Buffer.from(lines[1], 'base64');
if (publicKey.length !== 42 || signature.length !== 74) throw new Error('Invalid key/signature format');
if (!publicKey.subarray(2, 10).equals(signature.subarray(2, 10))) throw new Error('Signing key ID mismatch');
const algorithm = signature.subarray(0, 2).toString();
if (!['Ed', 'ED'].includes(algorithm)) throw new Error(`Unknown signature algorithm: ${algorithm}`);
const bytes = readFileSync(artifact);
const message = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
if (!nacl.sign.detached.verify(message, signature.subarray(10), publicKey.subarray(10))) throw new Error('Artifact signature is invalid');
if (!lines[2].startsWith('trusted comment: ')) throw new Error('Missing trusted comment');
const comment = Buffer.from(lines[2].slice('trusted comment: '.length));
const globalSignature = Buffer.from(lines[3], 'base64');
if (!nacl.sign.detached.verify(Buffer.concat([signature.subarray(10), comment]), globalSignature, publicKey.subarray(10))) throw new Error('Trusted comment signature is invalid');
console.log(JSON.stringify({ artifact, algorithm, signatureVerified: true, trustedCommentVerified: true, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));