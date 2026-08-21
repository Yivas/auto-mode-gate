import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contentRoot = new URL("../src/content/docs/", import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const canonicalLogo = fileURLToPath(new URL("../src/assets/auto-mode-gate.svg", import.meta.url));
const publicFavicon = fileURLToPath(new URL("../public/favicon.svg", import.meta.url));
const rawTextTags = new Set(["script", "style", "textarea"]);
const linkTags = new Set(["a", "linkcard"]);
const assetTags = new Set(["img"]);

export async function checkDocumentation() {
  const pages = await collectFiles(contentRoot, new Set([".md", ".mdx"]));
  const routes = new Set(pages.map(routeFor));
  const failures = [];

  for (const page of pages) {
    const source = await readFile(page, "utf8");
    const route = routeFor(page);

    for (const { target, type } of documentationTargets(source)) {
      if (type === "asset") {
        await validateAssetTarget(page, target, failures);
      } else {
        validateRouteTarget(page, route, target, routes, failures);
      }
    }
  }

  const repositoryMarkdown = await collectFiles(
    new URL("../../", import.meta.url),
    new Set([".md"]),
    new Set([".git", "node_modules", "wiki"]),
  );

  for (const page of repositoryMarkdown) {
    const source = await readFile(page, "utf8");
    for (const { target } of markdownTargets(source)) {
      if (isExternalTarget(target)) {
        continue;
      }

      if (!(await resolvesWithin(repositoryRoot, dirname(fileURLToPath(page)), target))) {
        failures.push(`${relative(repositoryRoot, fileURLToPath(page))}: ${target}`);
      }
    }
  }

  const [logo, favicon] = await Promise.all([readFile(canonicalLogo), readFile(publicFavicon)]);
  if (!logo.equals(favicon)) {
    failures.push("wiki/public/favicon.svg differs from the canonical wiki/src/assets/auto-mode-gate.svg");
  }

  return { failures, pageCount: pages.length, repositoryMarkdownCount: repositoryMarkdown.length };
}

export function documentationTargets(source) {
  const targets = markdownTargets(source);
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? "";
  targets.push(...frontmatterTargets(frontmatter));
  return targets;
}

export function frontmatterTargets(frontmatter) {
  const targets = [];
  for (const match of frontmatter.matchAll(/^\s*(link|file):\s*(.*?)\s*$/gmu)) {
    const target = yamlScalar(match[2]);
    if (target !== undefined) {
      targets.push({ target, type: match[1] === "file" ? "asset" : "link" });
    }
  }
  return targets;
}

function yamlScalar(raw) {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) {
    return undefined;
  }
  if (value.startsWith('"')) {
    const match = value.match(/^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/u);
    return match ? JSON.parse(match[1]) : undefined;
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/u);
    return match ? match[1].replaceAll("''", "'") : undefined;
  }
  return value.replace(/\s+#.*$/u, "").trim() || undefined;
}

export function markdownTargets(source) {
  const targets = [];
  const searchable = stripMarkdownCode(source);

  targets.push(...inlineMarkdownTargets(searchable));

  for (const match of searchable.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(.+)$/gmu)) {
    targets.push({ target: destination(match[1]), type: "link" });
  }
  targets.push(...htmlTargets(searchable));

  return targets;
}

function validateRouteTarget(page, route, target, routes, failures) {
  if (isExternalTarget(target)) {
    return;
  }

  const resolved = new URL(target, `https://docs.invalid${route}`).pathname;
  if (!routes.has(resolved)) {
    failures.push(`${relative(fileURLToPath(contentRoot), fileURLToPath(page))}: ${target}`);
  }
}

async function validateAssetTarget(page, target, failures) {
  if (isExternalTarget(target)) {
    return;
  }

  const path = localPath(target);
  const root = path.startsWith("/") ? publicRoot : sourceRoot;
  const resolved = path.startsWith("/")
    ? resolve(publicRoot, path.replace(/^\/(?:auto-mode-gate\/)?/u, ""))
    : resolve(dirname(fileURLToPath(page)), path);
  if (!path || !isWithin(root, resolved) || !(await exists(resolved))) {
    failures.push(`${relative(fileURLToPath(contentRoot), fileURLToPath(page))}: ${target}`);
    return;
  }

  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  if (!isWithin(realRoot, realTarget)) {
    failures.push(`${relative(fileURLToPath(contentRoot), fileURLToPath(page))}: ${target}`);
  }
}

function stripMarkdownCode(source) {
  const lines = stripHtmlComments(source).split("\n");
  let fence;
  const unfenced = lines.map((line) => {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`, "u").test(line)) {
        fence = undefined;
      }
      return "";
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (opening) {
      fence = { character: opening[0], length: opening.length };
      return "";
    }
    return /^(?: {4}|\t)/u.test(line) ? "" : line;
  }).join("\n");

  let result = "";
  for (let index = 0; index < unfenced.length;) {
    if (unfenced[index] !== "`") {
      result += unfenced[index];
      index += 1;
      continue;
    }

    let length = 1;
    while (unfenced[index + length] === "`") {
      length += 1;
    }
    const delimiter = "`".repeat(length);
    const closing = unfenced.indexOf(delimiter, index + length);
    if (closing === -1) {
      result += delimiter;
      index += length;
    } else {
      result += " ".repeat(closing + length - index);
      index = closing + length;
    }
  }
  return result;
}

function stripHtmlComments(source) {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<!--", index);
    if (start === -1) {
      return result + source.slice(index);
    }
    result += source.slice(index, start);
    const end = source.indexOf("-->", start + 4);
    if (end === -1) {
      throw new Error("Unclosed HTML comment");
    }
    index = end + 3;
  }
  return result;
}

export function htmlTargets(source) {
  const targets = [];
  let index = 0;

  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start === -1) {
      break;
    }
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }

    let cursor = start + 1;
    const closing = source[cursor] === "/";
    if (closing) {
      cursor += 1;
    }
    const name = source.slice(cursor).match(/^[a-z][a-z\d-]*/iu)?.[0];
    if (!name) {
      index = start + 1;
      continue;
    }

    cursor += name.length;
    const end = htmlTagEnd(source, cursor);
    if (end === -1) {
      throw new Error(`Unclosed HTML tag near: <${name}`);
    }

    const tag = name.toLowerCase();
    if (!closing && rawTextTags.has(tag)) {
      const closingTag = new RegExp(`</${tag}\\s*>`, "igu");
      closingTag.lastIndex = end + 1;
      const closingMatch = closingTag.exec(source);
      if (!closingMatch) {
        throw new Error(`Unclosed raw-text HTML element: <${tag}>`);
      }
      index = closingTag.lastIndex;
      continue;
    }
    if (!closing) {
      const attributes = htmlAttributes(source.slice(cursor, end));
      if (linkTags.has(tag)) {
        const target = staticAttributeTarget(attributes.get("href"));
        if (target !== undefined) {
          targets.push({ target, type: "link" });
        }
      }
      if (assetTags.has(tag)) {
        const target = staticAttributeTarget(attributes.get("src"));
        if (target !== undefined) {
          targets.push({ target, type: "asset" });
        }
      }
    }
    index = end + 1;
  }

  return targets;
}

function staticAttributeTarget(value) {
  if (value === undefined || value === "" || value.startsWith("{")) {
    return undefined;
  }
  return destination(value);
}

function htmlTagEnd(source, start) {
  let quote;
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{") {
      braceDepth += 1;
    } else if (character === "}" && braceDepth > 0) {
      braceDepth -= 1;
    } else if (character === ">" && braceDepth === 0) {
      return index;
    }
  }
  return -1;
}

function htmlAttributes(source) {
  const attributes = new Map();
  let index = 0;

  while (index < source.length) {
    while (/\s|\//u.test(source[index] ?? "")) {
      index += 1;
    }
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/u.test(source[index])) {
      index += 1;
    }
    if (index === nameStart) {
      index += 1;
      continue;
    }

    const name = source.slice(nameStart, index).toLowerCase();
    while (/\s/u.test(source[index] ?? "")) {
      index += 1;
    }
    if (source[index] !== "=") {
      if (!attributes.has(name)) {
        attributes.set(name, "");
      }
      continue;
    }

    index += 1;
    while (/\s/u.test(source[index] ?? "")) {
      index += 1;
    }
    const quote = source[index] === '"' || source[index] === "'" ? source[index++] : undefined;
    const valueStart = index;
    if (quote) {
      while (index < source.length && source[index] !== quote) {
        index += 1;
      }
    } else {
      while (index < source.length && !/[\s>]/u.test(source[index])) {
        index += 1;
      }
    }
    if (!attributes.has(name)) {
      attributes.set(name, source.slice(valueStart, index));
    }
    if (quote && source[index] === quote) {
      index += 1;
    }
  }

  return attributes;
}

function inlineMarkdownTargets(source) {
  const targets = [];
  const opening = /(!?)\[[^\]]*\]\(/gu;

  for (const match of source.matchAll(opening)) {
    let depth = 1;
    let escaped = false;
    let index = match.index + match[0].length;
    const start = index;

    for (; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }

    if (depth !== 0) {
      throw new Error(`Unclosed Markdown link near: ${match[0]}`);
    }

    targets.push({
      target: destination(source.slice(start, index)),
      type: match[1] ? "asset" : "link",
    });
  }

  return targets;
}

function destination(raw) {
  const value = raw.trim();
  const target = value.startsWith("<") ? value.slice(1, value.indexOf(">")) : value.split(/\s+/u, 1)[0];
  return target.replace(/\\([\\()[\]])/gu, "$1");
}

function isExternalTarget(target) {
  return target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(target);
}

function isWithin(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function resolvesWithin(root, directory, target) {
  const path = localPath(target);
  if (!path) {
    return false;
  }
  const resolved = resolve(directory, path);
  if (!isWithin(root, resolved) || !(await exists(resolved))) {
    return false;
  }
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  return isWithin(realRoot, realTarget);
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

async function main() {
  const result = await checkDocumentation();
  if (result.failures.length > 0) {
    console.error(`Broken links:\n${result.failures.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Checked ${result.pageCount} documentation routes and ${result.repositoryMarkdownCount} repository Markdown files.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
