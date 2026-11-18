// Usage: node scripts/native-platform.mjs [win32|linux]
// Without an argument, accepts every platform that has a native app.
const names = { win32: "Windows", linux: "Linux" };
const required = process.argv[2];
const allowed = required ? [required] : Object.keys(names);

if (!allowed.includes(process.platform)) {
  const target = allowed.map((platform) => names[platform] ?? platform).join(" e ");
  console.error(
    `Este comando está disponível somente para ${target}. Use npm run dev:web para visualizar a interface.`,
  );
  process.exit(1);
}
