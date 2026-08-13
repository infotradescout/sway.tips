import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const sampleRate = 8_000;
const durationSeconds = 1;
const channelCount = 1;
const bitsPerSample = 16;
const bytesPerSample = bitsPerSample / 8;
const frameCount = sampleRate * durationSeconds;
const pcmByteSize = frameCount * channelCount * bytesPerSample;

function outputDirectory() {
  const outputIndex = process.argv.indexOf('--output-dir');
  const requested = outputIndex >= 0 ? process.argv[outputIndex + 1] : '';
  return resolve(requested || join(tmpdir(), 'sway-audio-production-proof'));
}

function createProofWav() {
  const wav = Buffer.alloc(44 + pcmByteSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcmByteSize, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  wav.writeUInt16LE(channelCount * bytesPerSample, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmByteSize, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const envelope = Math.min(1, frame / 160, (frameCount - frame - 1) / 160);
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 8_000 * Math.max(0, envelope));
    wav.writeInt16LE(sample, 44 + frame * bytesPerSample);
  }

  return wav;
}

const directory = outputDirectory();
mkdirSync(directory, { recursive: true });
const fixture = createProofWav();
const sha256 = createHash('sha256').update(fixture).digest('hex');
const filePath = join(directory, `sway-storage-proof-${sha256.slice(0, 12)}.wav`);
writeFileSync(filePath, fixture, { flag: 'w', mode: 0o600 });

console.log(JSON.stringify({
  outcome: 'generated',
  filePath,
  filename: basename(filePath),
  byteSize: fixture.byteLength,
  sha256,
  generatedFixture: true,
  userOwned: false
}));
