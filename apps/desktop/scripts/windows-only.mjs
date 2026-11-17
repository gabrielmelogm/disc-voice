if (process.platform !== "win32") {
  console.error(
    "O aplicativo nativo está disponível somente para Windows. Use npm run dev:web para visualizar a interface.",
  );
  process.exit(1);
}
