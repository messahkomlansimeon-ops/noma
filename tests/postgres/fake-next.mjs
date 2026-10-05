// Faux « next dev » pour les tests de dev:full (NOMA_DEV_FULL_NEXT_SCRIPT) : attend un signal, puis sort avec 0.
// FAKE_NEXT_EXIT_AFTER_MS : sort de lui-même avec le code 3 après ce délai (arrêt inattendu de Next).
console.log(`[fake-next] prêt pid=${process.pid} NODE_OPTIONS=${process.env.NODE_OPTIONS ?? ""}`);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`[fake-next] signal ${signal}`);
    process.exit(0);
  });
}
const exitAfter = Number(process.env.FAKE_NEXT_EXIT_AFTER_MS ?? "0");
if (exitAfter > 0) setTimeout(() => process.exit(3), exitAfter);
setInterval(() => {}, 1000);
