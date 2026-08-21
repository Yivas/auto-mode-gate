import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  checkDocumentation,
  documentationTargets,
  frontmatterTargets,
  htmlTargets,
  markdownTargets,
  resolvesWithin,
} from "./check-links.mjs";

test("frontmatter targets include quoted values, comments, actions, and assets", () => {
  assert.deepEqual(
    frontmatterTargets(`
hero:
  image:
    file: "../../assets/logo.svg"
  actions:
    - text: Install
      link: './install/' # primary route
`),
    [
      { target: "../../assets/logo.svg", type: "asset" },
      { target: "./install/", type: "link" },
    ],
  );
});

test("MDX component targets include supported static href and src attributes", () => {
  assert.deepEqual(
    htmlTargets(`
<LinkCard condition={count > 1} title="Install" href="./install/" />
<img src="../../assets/logo.svg" alt="Logo">
<a href={dynamicTarget}>Dynamic</a>
<link href="./custom.css">
`),
    [
      { target: "./install/", type: "link" },
      { target: "../../assets/logo.svg", type: "asset" },
    ],
  );
});

test("documentation targets ignore fenced examples", () => {
  const targets = documentationTargets(`---
hero:
  actions:
    - text: Start
      link: ./start/
---

[Guide](./guide/)

\`\`\`mdx
<LinkCard href="./not-a-real-route/" />
\`\`\`
`);

  assert.deepEqual(targets, [
    { target: "./guide/", type: "link" },
    { target: "./start/", type: "link" },
  ]);
});

test("inline Markdown parsing keeps nested destinations", () => {
  assert.deepEqual(markdownTargets("[Reference](./guide/(advanced)/)"), [
    { target: "./guide/(advanced)/", type: "link" },
  ]);
});

test("repository Markdown targets cannot escape the repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "amg-links-"));
  const outside = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}-outside.md`);
  try {
    const docs = join(root, "docs");
    await mkdir(docs);
    await writeFile(join(docs, "inside.md"), "inside");
    await writeFile(outside, "outside");

    assert.equal(await resolvesWithin(root, docs, "./inside.md"), true);
    assert.equal(await resolvesWithin(root, docs, `../../${outside.split(/[\\/]/u).at(-1)}`), false);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { force: true }),
    ]);
  }
});

test("the current documentation and identity outputs pass", async () => {
  const result = await checkDocumentation();
  assert.deepEqual(result.failures, []);
});
