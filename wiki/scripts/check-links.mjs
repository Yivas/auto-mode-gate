import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contentRoot = new URL("../src/content/docs/", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const pages = await collectFiles(contentRoot, new Set([".md", ".mdx"]));
const routes = new Set(pages.map(routeFor));
const failures = [];

for (const page of pages) {
  const source = await readFile(page, "utf8");
  const route = routeFor(page);

  for (const target of markdownTargets(source)) {
    validateRouteTarget(page, route, target);
  }

  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? "";
  for (const match of frontmatter.matchAll(/^\s*link:\s*(\S+)\s*$/gmu)) {
    validateRouteTarget(page, route, match[1]);
  }
}

const repositoryMarkdown = await collectFiles(
  new URL("../../", import.meta.url),
  new Set([".md"]),
  new Set([".git", "node_modules", "wiki"]),
);

for (const page of repositoryMarkdown) {
  const source = await readFile(page, "utf8");
  for (const target of markdownTargets(source)) {
    if (isExternalTarget(target)) {
      continue;
    }

    const path = localPath(target);
    if (!path || !(await exists(resolve(dirname(fileURLToPath(page)), path)))) {
      failures.push(`${relative(repositoryRoot, fileURLToPath(page))}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Broken links:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${pages.length} documentation routes and ${repositoryMarkdown.length} repository Markdown files.`,
  );
}

function validateRouteTarget(page, route, target) {
  if (isExternalTarget(target)) {
    return;
  }

  const resolved = new URL(target, `https://docs.invalid${route}`).pathname;
  if (!routes.has(resolved)) {
    failures.push(`${relative(fileURLToPath(contentRoot), fileURLToPath(page))}: ${target}`);
  }
}

function markdownTargets(source) {
  return [...source.matchAll(/(?<!!)\[[^\]]*\]\(([^)]+)\)/gu)].map((match) =>
    destination(match[1]),
  );
}

function destination(raw) {
  const value = raw.trim();
  if (value.startsWith("<")) {
    return value.slice(1, value.indexOf(">"));
  }
  return value.split(/\s+/u, 1)[0];
}

function isExternalTarget(target) {
  return target.startsWith("#") || /^[a-z][a-z\d+.-]*:/iu.test(target);
}

function localPath(target) {
  const path = target.split(/[?#]/u, 1)[0];
  try {
    return decodeURIComponent(path);
  } catch {
    return "";
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(directory, extensions, ignoredDirectories = new Set()) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }

    const url = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      files.push(
        ...(await collectFiles(new URL(`${entry.name}/`, directory), extensions, ignoredDirectories)),
      );
    } else if (extensions.has(extname(entry.name))) {
      files.push(url);
    }
  }
  return files;
}

function routeFor(page) {
  const path = relative(fileURLToPath(contentRoot), fileURLToPath(page))
    .replaceAll("\\", "/")
    .replace(/\.(?:md|mdx)$/u, "");
  return path === "index" ? "/" : `/${path}/`;
}
