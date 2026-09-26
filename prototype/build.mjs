// Builds the prototype into ONE self-contained HTML file (docs/index.html) that works by
// double-clicking it or via GitHub Pages. No server, no network requests.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, "..");
const out = path.join(repo, "docs");
mkdirSync(out, { recursive: true });

const js = await build({
  entryPoints: [path.join(root, "src/main.tsx")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  alias: { "@": path.join(repo, "src") },
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "empty" },
  legalComments: "none",
});

const cssFile = path.join(out, ".tmp.css");
execFileSync(process.execPath, [path.join(repo, "node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", path.join(root, "src/styles.css"), "-o", cssFile, "--minify"], { cwd: root, stdio: "inherit" });
const css = readFileSync(cssFile, "utf8");

const script = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Boekhouding dispuut (prototype)</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📒</text></svg>">
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<noscript>Zet JavaScript aan om de boekhouding te gebruiken.</noscript>
<script>${script}</script>
</body>
</html>
`;
writeFileSync(path.join(out, "index.html"), html);
writeFileSync(path.join(out, ".nojekyll"), "");
execFileSync("rm", ["-f", cssFile]);
console.log(`docs/index.html geschreven (${(html.length / 1024).toFixed(0)} kB)`);
