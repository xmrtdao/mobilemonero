// relay/public/markdown.js - the markdown renderer the bulletin board uses.
//
// This file is loaded by a <script> tag in the dashboard template and defines
// exactly one global: renderMarkdown(text).
//
// Why it exists as a separate file rather than inline in dashboard.js: the board
// post bodies are rendered into innerHTML, and the template literal that carries
// them is full of backslashes. Keeping the renderer out of that literal is what
// makes the escaping here reviewable - the whole security property of this file
// rests on it being read in isolation.
//
// The security property, stated once: post bodies come from the API and are not
// trusted. Every character is HTML-escaped FIRST, and only then are markdown
// transforms applied to the escaped text. Because the transforms only ever insert
// a fixed set of tags, and the text they operate on has no live angle brackets
// left in it, a post body cannot inject markup. Reversing those two steps - or
// "just" inserting a <br> - reintroduces stored XSS on a page that is
// authenticated with a shared API key, so the order here is not negotiable.
//
// The feature set matches .board-post-body in the dashboard stylesheet, which
// already styles p, h1-h6, ul/ol/li, code, pre, blockquote, hr, table, a, strong,
// em, br and del. Anything outside that list renders as text, which is the correct
// outcome for an unrecognised construct rather than a silently dropped one.

(function (global) {
  'use strict';

  /**
   * A delimiter for stashed code fragments that input cannot forge.
   *
   * It has to be a character escaping removes, or one that cannot appear in the
   * escaped text at all. A readable token like "%%0%%" would not do: post bodies
   * are attacker-controlled, so a post could contain that literal and the restore
   * pass would splice real code into the middle of it. A NUL is not reachable -
   * it does not survive JSON and cannot be typed.
   */
  var NUL = String.fromCharCode(0);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Render a small, safe subset of markdown to HTML.
   *
   * The signature is deliberately (text) -> string. Returning a string rather than
   * assigning to the DOM means the caller decides where it goes, and this function
   * has no way to write somewhere the caller did not intend.
   */
  function renderMarkdown(text) {
    if (text == null) return '';

    // Normalise line endings before anything else, so a CRLF from the API does not
    // leave a stray \r inside a generated tag.
    var src = String(text).replace(/\r\n?/g, '\n');

    // Step 1: escape. Nothing below this line ever sees a live angle bracket.
    var html = escapeHtml(src);

    // Code is stashed out of the way of every later transform, so a heading or a
    // list marker inside a code block stays literal text.
    var stash = [];
    function keep(fragment) {
      stash.push(fragment);
      return NUL + (stash.length - 1) + NUL;
    }

    // Fenced blocks first: nothing inside a fence may be read as markdown.
    html = html.replace(/```([\s\S]*?)```/g, function (_, body) {
      return keep('<pre><code>' + body.replace(/^\n/, '').replace(/\n$/, '') + '</code></pre>');
    });

    // Inline code, for the same reason.
    html = html.replace(/`([^`\n]+)`/g, function (_, body) {
      return keep('<code>' + body + '</code>');
    });

    function splitRow(line) {
      return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    }

    // Tables. Consumed before a horizontal rule can claim a separator row, which
    // is the reason this runs first among the block transforms.
    html = html.replace(
      /^(?:[^\n]*\|[^\n]*)\n\|?[\s:|-]*-[\s:|-]*\|?\n(?:[^\n]*\|[^\n]*\n?)*/gm,
      function (block) {
        var lines = block.replace(/\n$/, '').split('\n');
        if (lines.length < 2) return block;
        var out = '<table><thead><tr>';
        splitRow(lines[0]).forEach(function (c) { out += '<th>' + c.trim() + '</th>'; });
        out += '</tr></thead>';
        if (lines.length > 2) {
          out += '<tbody>';
          for (var i = 2; i < lines.length; i++) {
            out += '<tr>';
            splitRow(lines[i]).forEach(function (c) { out += '<td>' + c.trim() + '</td>'; });
            out += '</tr>';
          }
          out += '</tbody>';
        }
        return out + '</table>';
      });

    // Headings, emitted as a block surrounded by blank lines rather than by
    // opening and closing a <p> around them.
    //
    // The paragraph pass below works by segmenting on blank lines, so a block
    // delimited that way is recognised as a block on its own terms. The previous
    // version instead emitted "</p><h2>..</h2><p>", which assumed the paragraph
    // wrapper was already open - and when the heading was not between two
    // paragraphs, it produced a stray empty <p></p> and, in the middle of a post,
    // a <p> wrapped around a <ul>.
    //
    // Clamped to h4: the .board-post-body stylesheet defines rules for h1 through
    // h4 and no further, so emitting an h5 would produce a tag with no styling -
    // a larger, unstyled default heading in the middle of 11px chat text. Clamping
    // makes the invariant structural instead of depending on the CSS staying in
    // step with this file.
    html = html.replace(/^([ \t]*)(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/gm,
      function (_, __, hashes, body) {
        var n = Math.min(hashes.length, 4);
        return '\n\n<h' + n + '>' + body + '</h' + n + '>\n\n';
      });

    // Horizontal rules. All three of markdown's markers, and "-" has to be among
    // them: an earlier version handled only "*" and "_", so the single most
    // common rule in agent-written markdown rendered as a literal "---".
    //
    // A run of three or more "-" is only a rule on a line of its own, which is
    // what keeps it from eating a table separator or a list item.
    html = html.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '<hr>');

    // Lists. One pass, no nesting: board posts are short prose, and a list that
    // renders slightly flat beats one that renders wrong.
    //
    // The continuation lines accept zero leading whitespace, which they have to -
    // a flush-left second item is the normal way these are written, and requiring
    // indentation made every list render as a series of one-item lists.
    html = html.replace(/^[ \t]*[-*+][ \t]+(.*(?:\n[ \t]*[-*+][ \t]+.*)*)/gm,
      function (_, body) {
        var items = body.split('\n').map(function (l) {
          return l.replace(/^[ \t]*[-*+][ \t]+/, '');
        });
        return '<ul>' + items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ul>';
      });

    html = html.replace(/^[ \t]*\d+[.)][ \t]+(.*(?:\n[ \t]*\d+[.)][ \t]+.*)*)/gm,
      function (_, body) {
        var items = body.split('\n').map(function (l) {
          return l.replace(/^[ \t]*\d+[.)][ \t]+/, '');
        });
        return '<ol>' + items.map(function (i) { return '<li>' + i + '</li>'; }).join('') + '</ol>';
      });

    // Blockquote. The marker is already &gt; at this point, because escaping ran
    // first - matching the raw ">" here would silently never match.
    html = html.replace(/^[ \t]*&gt;[ \t]+(.*(?:\n[ \t]*&gt;[ \t]+.*)*)/gm,
      function (_, body) {
        var items = body.split('\n').map(function (l) {
          return l.replace(/^[ \t]*&gt;[ \t]+/, '');
        });
        return '<blockquote>' + items.join('<br>') + '</blockquote>';
      });

    // Paragraphs, by segmenting on blank lines.
    //
    // Working segment-by-segment rather than with one greedy regex is what keeps
    // the nesting correct. A regex that wraps "runs of text" will happily wrap a
    // run that already contains a <ul> or an <h2> that an earlier pass inserted,
    // producing <p><ul>...</ul></p> - invalid HTML that the browser silently
    // repairs by closing the <p> early and leaving the rest outside it, which
    // looks like the markdown "didn't work" rather than like a bug.
    //
    // Single newlines inside a segment become a hard break, which is what an agent
    // writing in a chat-shaped box actually means.
    var BLOCK_START = /^<(p|ul|ol|blockquote|pre|table|hr|h[1-6]|div)\b/;

    html = html
      .split(/\n[ \t]*\n+/)
      .map(function (segment) {
        var s = segment.trim();
        if (!s) return '';
        // Already a block - a table, list, heading, rule or stashed code. Leaving
        // it alone is the whole point: it must not gain a paragraph wrapper.
        if (BLOCK_START.test(s)) return s;
        return '<p>' + s.replace(/\n/g, '<br>') + '</p>';
      })
      .filter(Boolean)
      .join('');

    // Inline spans, after the blocks, so text inside a list item or a heading
    // still gets emphasis.
    //
    // Links: only http(s) and mailto survive. A javascript: URL cannot match, so
    // it falls through as literal text rather than being stripped - the reader can
    // see what was actually written.
    html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (whole, label, href) {
      if (!/^(https?:\/\/|mailto:)/i.test(href)) return whole;
      return '<a href="' + safeUrl(href) + '" target="_blank" rel="noopener noreferrer">'
        + label + '</a>';
    });

    // Bare autolinks, same scheme allowlist.
    html = html.replace(/(^|[\s(])((?:https?:\/\/|mailto:)[^\s<)]+)/g,
      function (_, lead, url) {
        return lead + '<a href="' + safeUrl(url) + '" target="_blank" rel="noopener noreferrer">'
          + url + '</a>';
      });

    html = html.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
    html = html.replace(/(^|[^\w_])__([^_\n]+)__(?![\w_])/g, '$1<strong>$2</strong>');
    html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // Restore the stashed code, now that every other transform has run.
    html = html.replace(new RegExp(NUL + '(\\d+)' + NUL, 'g'), function (_, i) {
      var v = stash[Number(i)];
      return v === undefined ? '' : v;
    });

    return html;
  }

  /**
   * Escape a URL for use inside a double-quoted href.
   *
   * The scheme has already been allowlisted by the caller. This handles the
   * attribute boundary only, which is all that is left to handle: the input is
   * escaped HTML, so a quote in it is already &quot; and cannot break out - but a
   * percent-encoded one is not, so it is encoded here.
   */
  function safeUrl(url) {
    return String(url)
      .replace(/"/g, '%22')
      .replace(/</g, '%3C')
      .replace(/>/g, '%3E');
  }

  // Single global. dashboard.js calls this by bare name at the board render, so
  // it has to be a global rather than a module export.
  global.renderMarkdown = renderMarkdown;

  // Exposed for the tests, which need to check the escaping property without a
  // DOM. Harmless in the page: nothing else reads it.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderMarkdown: renderMarkdown, escapeHtml: escapeHtml };
  }
})(typeof window !== 'undefined' ? window : globalThis);
