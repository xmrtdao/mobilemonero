import assert from "node:assert/strict";
import { parseObsidianWikiLinks } from "../lib/obsidian-graph-links.mjs";

const links = parseObsidianWikiLinks(`
[[Data Team]]
[[Data Team|predicate:talks-to]]
[[Ticket Information|verb:consumes]]
--produces--> [[Customer Answers]]
[[Product Team]] --runs--> [[Slack Questions Workflow]]
[[Data Team|Product data team]]
`);

assert.deepEqual(links, [
  { target: "Data Team", type: "wiki-link" },
  { target: "Data Team", type: "talks-to" },
  { target: "Ticket Information", type: "consumes" },
  { target: "Customer Answers", type: "produces" },
  { target: "Product Team", type: "runs" },
  { target: "Slack Questions Workflow", type: "wiki-link" },
  { target: "Data Team", type: "wiki-link" },
]);

const documentedLinks = parseObsidianWikiLinks(`
\`\`\`md
[[Example Team]] --example--> [[Example Workflow]]
\`\`\`

Inline example: \`[[Inline Team]] --example--> [[Inline Workflow]]\`.

[[Product Team]] --runs--> [[Slack Questions Workflow]]
`);

assert.deepEqual(documentedLinks, [
  { target: "Product Team", type: "runs" },
  { target: "Slack Questions Workflow", type: "wiki-link" },
]);

console.log("obsidian-graph-links: 9 assertions passed");
