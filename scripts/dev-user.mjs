#!/usr/bin/env node
// Creates (or reuses) a user in the local database and a session for it, for
// testing without Google or Discord login. Only touches the compose `db`.
//
//   npm run dev:user -- "Ana Souza"            -> ana-souza@local.test
//   npm run dev:user -- "Ana Souza" ana@x.test
//
// Then, in the DevTools console of the web app (http://127.0.0.1:1420), run the
// line it prints. Use another browser profile or a private window per user.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const name = (process.argv[2] || "Dev").trim().split(/\s+/).join(" ");
if (!name || [...name].length > 32) {
  console.error("O nome deve ter entre 1 e 32 caracteres.");
  process.exit(1);
}
const slug = name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dev";
const email = process.argv[3] || `${slug}@local.test`;

// Same shape as the API's tokens (64 characters); the database keeps only the SHA-256.
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");

const sql = `
INSERT INTO users (id, email, name, pronouns, bio, banner, created_at)
VALUES (gen_random_uuid(), :'email', :'name', '', '', 'brand', now())
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
RETURNING id \\gset
INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (:'hash', :'id', now() + interval '30 days');
SELECT :'id';
`;

const result = spawnSync("docker", [
  "compose", "exec", "-T", "db", "psql", "-U", "discvoice", "-d", "discvoice",
  "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", `name=${name}`, "-v", `email=${email}`, "-v", `hash=${hash}`,
], { input: sql, encoding: "utf8" });

if (result.error || result.status !== 0) {
  console.error(result.error?.message || result.stderr.trim());
  console.error("O banco está rodando? Inicie com `npm run db:up`. A API precisa ter rodado uma vez (migrações).");
  process.exit(1);
}

const id = result.stdout.trim().split("\n").at(-1);
console.log(`Usuário ${name} <${email}> (${id}) com sessão válida por 30 dias.`);
console.log("\nCole no console do DevTools do app web (http://127.0.0.1:1420):\n");
console.log(`localStorage.setItem("discvoice.session", "${token}"); location.reload();`);
