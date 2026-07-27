/**
 * Grant, change, or revoke PROCUREMENT access — the bootstrap path that did not
 * exist. Until this script there was no UI, no CLI and no seeded row: the only
 * way to give anybody (including the owner) access to this app was hand-written
 * SQL against RDS. That meant a freshly installed box could not onboard a single
 * person.
 *
 *   npm run access                                        # who has access today
 *   npm run access -- bootstrap                            # seed the FIRST admin
 *   npm run access -- grant sam@ajace.com --role writer
 *   npm run access -- revoke sam@ajace.com
 *   npm run access -- deactivate sam@ajace.com             # reversible suspend
 *   npm run access -- activate sam@ajace.com
 *   npm run access -- log                                  # recent privilege changes
 *
 * Add --yes (or -y) to APPLY. Without it every mutating command is a DRY RUN
 * that prints the exact change and touches nothing — see printPlan() below.
 *
 * WHY --conditions=react-server: this reaches src/lib/db/access.ts → pg.ts, which
 * opens with `import "server-only"`. That package's exports map throws outside
 * the react-server condition, which is why package.json invokes every script
 * this way ("crawl": "tsx --conditions=react-server …"). The db modules are
 * imported DYNAMICALLY below so `--help` and the DATABASE_URL check still run
 * under a plain `npx tsx` with no flag.
 *
 * SAFETY:
 *   * Refuses to do ANYTHING without DATABASE_URL — it will not silently fall
 *     back to a local database and report success against the wrong box.
 *   * Prints the current state and the intended change BEFORE writing.
 *   * Idempotent: re-running a grant at the same role reports "unchanged" and
 *     writes nothing, including no audit row.
 *   * Every applied change writes public.user_access_log, the same audit table
 *     the /admin/access screen writes, with actor "script:<user>@<host>".
 *   * It will not remove or demote the last active admin. Lock yourself out of
 *     the UI and this script is the only way back in; lock yourself out of both
 *     and it is psql again.
 */
import { userInfo, hostname } from "node:os";
import type { UserRole } from "../src/lib/types.ts";

const USAGE = `
grant-procurement-access — manage who may use the Procurement app

  npm run access                                 list access
  npm run access -- bootstrap [--email E] [--name N]
  npm run access -- grant EMAIL --role ROLE [--name NAME] [--reason R]
  npm run access -- revoke EMAIL [--reason R]
  npm run access -- deactivate EMAIL [--reason R]
  npm run access -- activate EMAIL [--reason R]
  npm run access -- log [--limit N]

  ROLE   viewer | writer | approver | admin
  --yes  apply the change (default is a dry run that writes nothing)

Procurement access is a public.users row. The AJACE login itself lives in the
timesheet's public.auth_users and is never created or deleted here.
`;

const ROLES: UserRole[] = ["viewer", "writer", "approver", "admin"];
const BOOTSTRAP_EMAIL = "richard@ajace.com";
const BOOTSTRAP_NAME = "Richard";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (...names: string[]) => names.some((n) => argv.includes(n));

const apply = has("--yes", "-y");
const positional = ((): string[] => {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      // Skip this flag's value too, unless it is a bare boolean switch.
      if (!["--yes", "-y", "--help", "-h"].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
})();

const command = (positional[0] ?? "list").toLowerCase();
const emailArg = positional[1];
const reason = flag("--reason") ?? null;

if (has("--help", "-h")) {
  console.log(USAGE);
  process.exit(0);
}

// ── the DATABASE_URL gate ────────────────────────────────────────────────────
// Deliberately before any import of the db layer: pg.ts would happily construct
// a Pool with connectionString undefined and then connect to whatever PG* env
// vars are lying around, which is exactly the "it said OK but nothing changed"
// failure this script exists to prevent.
if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL is not set.\n");
  console.error("  This script edits privileges in the shared AJACE database, so it refuses");
  console.error("  to guess which one. Point it at the RDS instance and re-run, e.g.\n");
  console.error("    DATABASE_URL='postgres://…' npm run access -- list\n");
  console.error("  (On the box, `set -a; . /etc/ajace.env; set +a` first.)");
  process.exit(1);
}

const {
  listAccess,
  listAccessLog,
  findAccount,
  findLogin,
  countActiveAdmins,
  grantAccess,
  revokeAccess,
  setAccountActive,
} = await import("../src/lib/db/access.ts");
const { pool } = await import("../src/lib/db/pg.ts");

const ACTOR = `script:${(() => { try { return userInfo().username; } catch { return "unknown"; } })()}@${hostname()}`;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  void pool().end();
  process.exit(1);
}

/**
 * The "print exactly what it will do before doing it" contract. Everything
 * mutating routes through here, so a dry run and a real run report the same
 * plan and differ only in whether the write happens.
 */
function printPlan(lines: string[]): boolean {
  console.log("\nPLAN");
  for (const l of lines) console.log(`  ${l}`);
  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --yes to apply.\n");
    return false;
  }
  console.log(`\napplying as ${ACTOR} …\n`);
  return true;
}

function requireEmail(): string {
  if (!emailArg) die(`${command} needs an email address. See --help.`);
  const e = emailArg.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) die(`"${emailArg}" is not an email address.`);
  return e;
}

async function showList() {
  const rows = await listAccess();
  const withAccess = rows.filter((r) => r.user_id);
  const loginOnly = rows.filter((r) => !r.user_id);

  console.log(`\nPROCUREMENT ACCESS — ${withAccess.length} account(s)\n`);
  if (withAccess.length === 0) {
    console.log("  (none — nobody can use this app. Run: npm run access -- bootstrap --yes)");
  }
  for (const r of withAccess) {
    const state = r.is_active ? "" : "  [DEACTIVATED]";
    const login = r.has_login ? "" : "  [no AJACE login — cannot sign in]";
    console.log(`  ${String(r.role).padEnd(9)} ${r.email.padEnd(34)} ${r.name ?? ""}${state}${login}`);
  }
  if (loginOnly.length) {
    console.log(`\nAJACE LOGINS WITHOUT PROCUREMENT ACCESS — ${loginOnly.length}\n`);
    for (const r of loginOnly) console.log(`  ${"—".padEnd(9)} ${r.email}`);
    console.log(`\n  grant one:  npm run access -- grant ${loginOnly[0].email} --role viewer --yes`);
  }
  console.log("");
}

async function showLog() {
  const limit = Number(flag("--limit") ?? 25);
  const rows = await listAccessLog(Number.isFinite(limit) ? limit : 25);
  console.log(`\nPRIVILEGE CHANGES — most recent ${rows.length}\n`);
  if (!rows.length) console.log("  (no changes recorded yet)");
  for (const r of rows) {
    const when = new Date(r.changed_at).toISOString().replace("T", " ").slice(0, 16);
    const change = [r.old_value, r.new_value].filter(Boolean).join(" -> ") || "—";
    console.log(`  ${when}  ${r.action.padEnd(12)} ${r.target_email.padEnd(30)} ${change.padEnd(22)} by ${r.actor}${r.reason ? `  (${r.reason})` : ""}`);
  }
  console.log("");
}

async function doBootstrap() {
  const email = (flag("--email") ?? BOOTSTRAP_EMAIL).trim().toLowerCase();
  const name = flag("--name") ?? BOOTSTRAP_NAME;
  const admins = await countActiveAdmins();
  const existing = await findAccount(email);
  const login = await findLogin(email);

  console.log(`\nBOOTSTRAP FIRST ADMIN`);
  console.log(`  active admins now : ${admins}`);
  console.log(`  target            : ${name} <${email}>`);
  console.log(`  AJACE login       : ${login ? `yes (${login.email})` : "NO — they cannot sign in until the timesheet account exists"}`);
  console.log(`  procurement row   : ${existing ? `${existing.role}${existing.is_active ? "" : " (deactivated)"}` : "none"}`);

  if (admins > 0 && existing?.role === "admin" && existing.is_active) {
    console.log(`\n✓ nothing to do — ${email} is already an active admin.\n`);
    return;
  }
  if (admins > 0) {
    // Refuse rather than quietly minting a second admin: "bootstrap" means
    // "there is nobody" and its whole safety story is that it only runs then.
    console.log(`\n✗ this install already has ${admins} active admin(s), so bootstrap is not the right tool.`);
    console.log(`  Use:  npm run access -- grant ${email} --role admin --yes\n`);
    process.exitCode = 1;
    return;
  }

  if (!printPlan([`CREATE procurement account ${email} with role "admin"`, `name: ${name}`])) return;
  const res = await grantAccess({ email, role: "admin", name, actor: ACTOR, reason: reason ?? "first-admin bootstrap" });
  console.log(`✓ ${res.effect === "unchanged" ? "already" : res.effect}: ${res.user.email} is admin (id ${res.user.id})\n`);
}

async function doGrant() {
  const email = requireEmail();
  const role = (flag("--role") ?? "").trim().toLowerCase() as UserRole;
  if (!ROLES.includes(role)) die(`--role must be one of: ${ROLES.join(", ")}`);

  const existing = await findAccount(email);
  const login = await findLogin(email);

  console.log(`\nGRANT`);
  console.log(`  target          : ${email}`);
  console.log(`  AJACE login     : ${login ? "yes" : "NO — a procurement row alone does not let them sign in"}`);
  console.log(`  current access  : ${existing ? `${existing.role}${existing.is_active ? "" : " (deactivated)"}` : "none"}`);
  console.log(`  requested role  : ${role}`);

  if (existing && existing.role === role && existing.is_active) {
    console.log(`\n✓ nothing to do — already ${role}.\n`);
    return;
  }
  // Demoting the only admin leaves an app nobody can administer.
  if (existing?.role === "admin" && existing.is_active && role !== "admin" && (await countActiveAdmins()) <= 1) {
    die("that is the last active admin — promote somebody else before demoting them.");
  }

  const verb = existing ? (existing.is_active ? "CHANGE ROLE of" : "REACTIVATE and set role of") : "CREATE procurement account for";
  if (!printPlan([`${verb} ${email} -> "${role}"`, reason ? `reason: ${reason}` : "reason: (none given)"])) return;
  const res = await grantAccess({ email, role, name: flag("--name") ?? null, actor: ACTOR, reason });
  console.log(`✓ ${res.effect}: ${res.user.email} is now ${res.user.role}\n`);
}

async function doRevoke() {
  const email = requireEmail();
  const existing = await findAccount(email);
  if (!existing) {
    console.log(`\n✓ nothing to do — ${email} has no procurement account.\n`);
    return;
  }
  if (existing.role === "admin" && existing.is_active && (await countActiveAdmins()) <= 1) {
    die("that is the last active admin — grant admin to somebody else first.");
  }
  console.log(`\nREVOKE`);
  console.log(`  target         : ${email}`);
  console.log(`  current access : ${existing.role}${existing.is_active ? "" : " (deactivated)"}`);
  if (!printPlan([
    `DELETE the procurement account for ${email} (was "${existing.role}")`,
    `their AJACE login is NOT touched — they keep the timesheet`,
    `assignments and authored responses survive (FKs are ON DELETE SET NULL)`,
    reason ? `reason: ${reason}` : "reason: (none given)",
  ])) return;
  const res = await revokeAccess({ email, actor: ACTOR, reason });
  console.log(`✓ removed ${email} (was ${res.previousRole})\n`);
}

async function doSetActive(active: boolean) {
  const email = requireEmail();
  const existing = await findAccount(email);
  if (!existing) die(`${email} has no procurement account — grant one first.`);
  if (existing.is_active === active) {
    console.log(`\n✓ nothing to do — ${email} is already ${active ? "active" : "deactivated"}.\n`);
    return;
  }
  if (!active && existing.role === "admin" && (await countActiveAdmins()) <= 1) {
    die("that is the last active admin — grant admin to somebody else first.");
  }
  if (!printPlan([
    `${active ? "REACTIVATE" : "DEACTIVATE"} ${email} (role "${existing.role}")`,
    active ? "they regain access on their next request" : "they lose access on their next request; the account and its history stay",
    reason ? `reason: ${reason}` : "reason: (none given)",
  ])) return;
  await setAccountActive({ email, active, actor: ACTOR, reason });
  console.log(`✓ ${email} is now ${active ? "active" : "deactivated"}\n`);
}

try {
  switch (command) {
    case "list":     await showList(); break;
    case "log":      await showLog(); break;
    case "bootstrap": await doBootstrap(); break;
    case "grant":    await doGrant(); break;
    case "revoke":   await doRevoke(); break;
    case "deactivate": await doSetActive(false); break;
    case "activate": await doSetActive(true); break;
    default:
      console.error(`✗ unknown command "${command}".`);
      console.error(USAGE);
      process.exitCode = 1;
  }
} finally {
  // pg keeps the event loop alive; without this the script hangs after printing.
  await pool().end();
}
