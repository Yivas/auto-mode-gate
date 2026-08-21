import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const requiredFiles = [
  "index.html",
  "404.html",
  "favicon.svg",
  "sitemap-index.xml",
  "pagefind/pagefind.js",
  "getting-started/install/index.html",
  "getting-started/configure/index.html",
  "getting-started/migrate/index.html",
  "guide/verify-and-operate/index.html",
  "guide/pi-controls/index.html",
  "guide/decisions/index.html",
  "guide/modes-and-logs/index.html",
  "guide/coverage-and-boundaries/index.html",
  "reference/validated-baselines/index.html",
  "project/participation/index.html",
];
const failures = [];

for (const path of requiredFiles) {
  if (!(await isFile(resolve(distRoot, path)))) {
    failures.push(`Missing build artifact: ${path}`);
  }
}

const home = await readGeneratedFile("index.html");
const notFound = await readGeneratedFile("404.html");

if (home !== undefined) {
  expect(home, 'rel="canonical" href="https://yivas.github.io/auto-mode-gate/"', "canonical home URL");
  expect(home, 'href="/auto-mode-gate/favicon.svg"', "favicon under the published base path");
  expect(home, 'href="/auto-mode-gate/getting-started/install/"', "primary install route");
  expect(home, 'id="what-the-gate-does"', "generated section anchors");
  reject(home, "github.com/Yivas/auto-mode-gate/edit/main/wiki/", "edit link while pull requests are not accepted");

  const logoPath = home.match(/src="(\/auto-mode-gate\/_astro\/auto-mode-gate\.[^"]+\.svg)"/u)?.[1];
  if (!logoPath) {
    failures.push("Missing optimized Auto Mode Gate logo in the generated home page");
  } else {
    const relativeLogoPath = logoPath.replace(/^\/auto-mode-gate\//u, "");
    if (!(await isFile(resolve(distRoot, relativeLogoPath)))) {
      failures.push(`Missing generated logo asset: ${relativeLogoPath}`);
    }
  }
}

if (notFound !== undefined) {
  expect(notFound, 'href="/auto-mode-gate/"', "404 return route");
  reject(notFound, "/auto-mode-gate//", "double slash in the 404 return route");
  expect(notFound, "github.com/Yivas/auto-mode-gate/issues", "404 issue-report route");
}

if (failures.length > 0) {
  console.error(`Invalid documentation build:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${requiredFiles.length} build artifacts and generated navigation metadata.`);
}

function expect(source, value, description) {
  if (!source.includes(value)) {
    failures.push(`Missing ${description}`);
  }
}

function reject(source, value, description) {
  if (source.includes(value)) {
    failures.push(`Unexpected ${description}`);
  }
}

async function readGeneratedFile(path) {
  const target = resolve(distRoot, path);
  return (await isFile(target)) ? readFile(target, "utf8") : undefined;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
