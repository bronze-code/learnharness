/**
 * build-server.mjs — curate the Electron shell's server payload.
 *
 * `next build` (output: "standalone") produces .next/standalone/ with
 * server.js + the traced node_modules subset, but leaves two pieces
 * outside that the docs require us to copy: public/ and .next/static/.
 * This script finishes the job and sanity-checks the result — including
 * the exclusion that keeps the repo's real data/ OUT of the bundle
 * (see next.config.ts outputFileTracingExcludes). It also removes exact
 * build-only paths the tracer sweeps in: plugin authoring projects,
 * old installers and the development Electron runtime. Broad trace exclusions break externals.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { validateCorePackages } from "./build-core-plugins.mjs";
import { buildPluginAuthoring } from "./build-plugin-authoring.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");

const copyTree = (from, to) => {
	fs.cpSync(from, to, { recursive: true });
};

const exists = (p) => fs.existsSync(p);

if (!exists(path.join(STANDALONE, "server.js"))) {
	console.error("[build-server] .next/standalone/server.js missing — run `next build` first (output: 'standalone').");
	process.exit(1);
}

// 1) Static assets: public/ → standalone/public, .next/static → standalone/.next/static
const staticFrom = path.join(ROOT, ".next", "static");
const staticTo = path.join(STANDALONE, ".next", "static");
if (!exists(staticFrom)) {
	console.error("[build-server] .next/static missing — the build looks incomplete.");
	process.exit(1);
}
copyTree(staticFrom, staticTo);
if (exists(path.join(ROOT, "public"))) {
	copyTree(path.join(ROOT, "public"), path.join(STANDALONE, "public"));
}

// 2) Safety: the repo's real data/ must NEVER ride along in the bundle.
const leakedData = path.join(STANDALONE, "data");
if (exists(leakedData)) {
	console.error("[build-server] REFUSING: standalone contains a data/ directory — repo session data would ship in the app.");
	console.error("             Check outputFileTracingExcludes in next.config.ts.");
	process.exit(1);
}

// 2b) Safety: the repo's dev SECRETS must never ride along either — the
// same trace sweep that catches data/ shipped the repo-root auth.json
// (the DEV BYOK key store, 0600) byte-identical into the DMG (caught in
// the 2026-10-08 payload audit; excluded in next.config.ts — this guard
// makes a regression loud instead of silent).
const subscriptionSecrets = fs.readdirSync(STANDALONE).filter((name) => /^(chatgpt|github-copilot|xai)-credentials\.json/.test(name));
for (const secret of ["auth.json", ...subscriptionSecrets, ".env", ".env.local"]) {
	if (exists(path.join(STANDALONE, secret))) {
		console.error(`[build-server] REFUSING: standalone contains ${secret} — dev secrets would ship in the app.`);
		console.error("             Check outputFileTracingExcludes in next.config.ts.");
		process.exit(1);
	}
}

// Assemble plugin assets only after refusing unsafe traced data/credentials.
// Runtime native plugin loader is deliberately outside Next's module graph.
// Copy it explicitly: external plugin entries must be loaded by native Node,
// not interpreted as build-time imports by webpack/Turbopack.
copyTree(path.join(ROOT, "scripts", "plugin-loader.cjs"), path.join(STANDALONE, "scripts", "plugin-loader.cjs"));
try {
	const core = path.join(ROOT, "core-plugins"), packagedCore = path.join(STANDALONE, "core-plugins");
	validateCorePackages(ROOT, core);
	fs.rmSync(packagedCore, { recursive: true, force: true });
	copyTree(core, packagedCore);
	validateCorePackages(ROOT, packagedCore);
} catch (error) {
	console.error("[build-server] REFUSING: Core plugin payload is missing or unsafe. Run npm run plugins:build-core.", error);
	process.exit(1);
}

// Reassemble from current source, never reuse a potentially stale dev download.
// Ship the complete portable skill plus its static ZIP; no application toolchain.
buildPluginAuthoring({ root: ROOT, standalone: true });

// 2c) Payload curation (2026-10-11): the trace sweep can copy repo-root
// plugins/ (authoring sources/tests), dist/ (previous installers), and the development Electron
// runtime (the demo helper's dev-only require). Neither belongs in the
// server: packaged helpers use process.execPath, the app's own binary.
// Remove ONLY these standalone-root paths AFTER tracing — excluding a
// generic dist/** earlier broke pi-ai / pi-agent-core's runtime dist/.
// Never touch ROOT/dist or ROOT/node_modules/electron (the running app
// and the build runtime); native canvas/resvg packages stay untouched.
for (const extra of ["plugins", "dist", path.join("node_modules", "electron")]) {
	const target = path.join(STANDALONE, extra);
	if (exists(target)) {
		fs.rmSync(target, { recursive: true, force: true });
		console.log(`[build-server] removed build-only payload: ${extra}`);
	}
}

// 2d) Nested-dependency closure for Next's hashed external aliases.
// .next/node_modules/<pkg>-<hash> is a SYMLINK to the real package. When that
// package lives in a NESTED node_modules (shiki sits under
// @streamdown/code/node_modules), its own dependencies (@shikijs/core, …)
// are its siblings there and resolve only through the link's real path.
// Windows packaging materializes the link as a plain copy, so the copy
// resolves upward from .next/node_modules and never reaches those siblings:
// the packaged server threw "Cannot find package '@shikijs/core'" on render
// (0.6.1, Windows). Copy the missing siblings next to the alias, where both
// the link and a materialized copy find them first.
const aliasRoot = path.join(STANDALONE, ".next", "node_modules");
const topModules = path.join(STANDALONE, "node_modules");
const packagesIn = (dir) =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".")) return [];
		if (!entry.name.startsWith("@")) return [entry.name];
		return fs.readdirSync(path.join(dir, entry.name)).map((name) => `${entry.name}/${name}`);
	});
if (exists(aliasRoot)) {
	for (const alias of packagesIn(aliasRoot)) {
		const aliasPath = path.join(aliasRoot, alias);
		if (!fs.lstatSync(aliasPath).isSymbolicLink()) continue;
		const real = fs.realpathSync(aliasPath);
		// The node_modules directory that holds the real package.
		const holder = real.slice(0, real.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
		if (holder === topModules || !holder.startsWith(topModules)) continue;
		for (const sibling of packagesIn(holder)) {
			const from = path.join(holder, sibling);
			const to = path.join(aliasRoot, sibling);
			if (from === real || exists(to)) continue;
			copyTree(from, to);
			console.log(`[build-server] nested dependency of ${alias}: ${sibling}`);
		}
	}
}

// 3) Sanity: the runtime-read prompt assets must be present (the teacher
//    agent reads them from disk at request time).
for (const asset of [
	path.join("scripts", "plugin-loader.cjs"),
	path.join("public", "plugin-loader.js"),
	path.join("src", "agent", "system-prompt.md"),
	path.join("src", "agent", "prompts", "teacher", "20-teaching.md"),
	path.join("src", "agent", "prompts", "side-chat", "00-base.md"),
	path.join("src", "agent", "prompts", "side-chat", "90-style.md"),
]) {
	if (!exists(path.join(STANDALONE, asset))) {
		console.error(`[build-server] prompt asset missing from the trace: ${asset}`);
		process.exit(1);
	}
}

console.log("[build-server] server payload ready:", STANDALONE);