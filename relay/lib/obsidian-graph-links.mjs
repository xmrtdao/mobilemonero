// Parse Obsidian wikilinks into entity targets and optional typed predicates.
//
// Supported forms:
// - [[Data Team]]                         -> { target: "Data Team", type: "wiki-link" }
// - [[Data Team|predicate:talks-to]]      -> { target: "Data Team", type: "talks-to" }
// - [[Ticket Information|verb:consumes]]  -> { target: "Ticket Information", type: "consumes" }
// - --produces--> [[Customer Answers]]    -> { target: "Customer Answers", type: "produces" }
// - [[Product Team]] --runs--> [[Workflow]] -> typed edge on the source link
//
// Plain Obsidian aliases such as [[Data Team|Product data team]] remain generic
// wiki-link edges so existing notes do not change meaning accidentally.

const LINK_RE = /\[\[([^\]\n]+)\]\]/g;
const PREDICATE_PREFIX_RE = /^(?:predicate|verb|edge|relation|relationship)\s*:\s*(.+)$/i;
const INCOMING_ARROW_RE = /--\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*-+>\s*$/;
const OUTGOING_ARROW_RE = /^\s*--\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*-+>/;

function normalizePredicate(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function lineStartFor(content, index) {
  return content.lastIndexOf("\n", index - 1) + 1;
}

function nextLinkIndex(content, index) {
  const rest = content.slice(index);
  const offset = rest.search(/\[\[/);
  return offset < 0 ? content.length : index + offset;
}

function maskMarkdownCode(content) {
  return maskInlineCode(maskFencedCode(content));
}

function maskFencedCode(content) {
  const chars = content.split('');
  const lines = content.split(/(\r?\n)/);
  let offset = 0;
  let fence = null;

  for (const line of lines) {
    if (!line) continue;

    const lineStart = offset;
    const lineEnd = lineStart + line.length;

    if (fence) {
      const closer = new RegExp(`^[ \\t]*${fence.char}{${fence.count},}[ \\t]*$`);
      if (closer.test(line)) fence = null;
      for (let i = lineStart; i < lineEnd; i++) {
        if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = ' ';
      }
    } else {
      const opening = line.match(/^[ \t]*(`{3,}|~{3,})[^\r\n]*$/);
      if (opening) {
        fence = { char: opening[1][0], count: opening[1].length };
        for (let i = lineStart; i < lineEnd; i++) {
          if (chars[i] !== '\r' && chars[i] !== '\n') chars[i] = ' ';
        }
      }
    }

    offset = lineEnd;
  }

  return chars.join('');
}

function maskInlineCode(content) {
  const chars = content.split('');
  let i = 0;

  while (i < chars.length) {
    if (chars[i] !== '`') {
      i++;
      continue;
    }

    const start = i;
    while (i < chars.length && chars[i] === '`') i++;
    const count = i - start;
    const delimiter = '`'.repeat(count);
    let end = i;

    while (end < chars.length && chars.slice(end, end + count).join('') !== delimiter) {
      end++;
    }

    if (end < chars.length) {
      for (let j = start; j < end; j++) {
        if (chars[j] !== '\r' && chars[j] !== '\n') chars[j] = ' ';
      }
      i = end + count;
    } else {
      i = start + 1;
    }
  }

  return chars.join('');
}

export function parseObsidianWikiLinks(content) {
  const parseableContent = maskMarkdownCode(content);
  const links = [];
  let match;
  LINK_RE.lastIndex = 0;

  while ((match = LINK_RE.exec(parseableContent)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;

    const parts = raw.split("|").map((part) => part.trim());
    const target = parts[0];
    const metadataPredicate = PREDICATE_PREFIX_RE.exec(parts[1] || "");
    let type = metadataPredicate
      ? normalizePredicate(metadataPredicate[1])
      : "wiki-link";

    // Metadata predicates are explicit and take precedence over nearby arrows.
    // This keeps `[[Ticket Information|verb:consumes]]` from inheriting the
    // `--produces-->` arrow that belongs to the following workflow line.
    if (!metadataPredicate) {
      const lineStart = lineStartFor(content, match.index);
      const linePrefix = content.slice(lineStart, match.index);
      const priorLinkEndInLine = content.lastIndexOf("]]", match.index - 1);
      const incomingArrow = linePrefix.match(INCOMING_ARROW_RE);

      // An arrow between two links belongs to the source link, not the target.
      // A leading arrow with no prior link on the same line belongs to this link.
      if (incomingArrow && priorLinkEndInLine < lineStart) {
        type = normalizePredicate(incomingArrow[1]);
      } else {
        const lineEnd = content.indexOf("\n", match.index);
        const lineBoundary = lineEnd < 0 ? content.length : lineEnd;
        const after = content.slice(
          match.index + match[0].length,
          nextLinkIndex(content, match.index + match[0].length)
        );
        const outgoingArrow = after.match(OUTGOING_ARROW_RE);
        if (outgoingArrow) {
          type = normalizePredicate(outgoingArrow[1]);
        }
      }
    }

    if (target) links.push({ target, type });
  }

  return links;
}
