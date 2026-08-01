try {
  await import('tsx/esm');
  await import('./sway-live-room-test-money-config.behavior.test.ts');
} catch (error) {
  console.error(error);
  process.exit(1);
}
