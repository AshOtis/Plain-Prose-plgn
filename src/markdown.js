/* Plain Prose: turns a Markdown note into prose blocks. Each block is { from, text }, where text is the same
 * length as the source, with Markdown syntax replaced by spaces, so offsets map 1:1 back to the editor. */

const ppBlank = (s) => s.replace(/[^\n]/g, ' ');

// Replace every match of re in line with spaces (or only group 1, if keepGroup).
function ppMaskAll(line, re, keep) {
  return line.replace(re, (m, ...g) => {
    if (keep === undefined) return ppBlank(m);
    // keep the captured inner text, blank everything around it
    const inner = g[keep - 1] ?? '';
    const at = m.indexOf(inner);
    return ppBlank(m.slice(0, at)) + inner + ppBlank(m.slice(at + inner.length));
  });
}

function ppMaskInline(line) {
  line = ppMaskAll(line, /`[^`]*`/g);                                  // inline code
  line = ppMaskAll(line, /\$[^$\n]+\$/g);                              // inline math
  line = ppMaskAll(line, /%%.*?%%/g);                                  // inline comments
  line = ppMaskAll(line, /<!--.*?-->/g);                               // html comments
  line = ppMaskAll(line, /!\[\[[^\]]*\]\]/g);                          // embeds
  line = ppMaskAll(line, /!\[[^\]]*\]\([^)]*\)/g);                     // images
  line = ppMaskAll(line, /\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, 1);        // [[target|alias]] -> alias
  line = ppMaskAll(line, /\[([^\]]*)\]\([^)]*\)/g, 1);                 // [text](url) -> text
  line = ppMaskAll(line, /\[\^[^\]]*\]/g);                             // footnote refs
  line = ppMaskAll(line, /https?:\/\/\S+/g);                           // bare URLs
  line = ppMaskAll(line, /<\/?[a-zA-Z][^>]*>/g);                       // html tags
  line = ppMaskAll(line, /(^|\s)#[\p{L}\p{N}_/-]+/gu);                // #tags
  line = ppMaskAll(line, /\s\^[\w-]+\s*$/g);                           // block ids
  line = line.replace(/(\*\*|__|~~|==|\*|_)/g, (m) => ' '.repeat(m.length)); // emphasis
  return line;
}

// Leading block syntax: blockquotes, callouts, headings, list items, tasks.
const PP_LEAD = /^(\s*(?:>\s?)*)(\[![^\]]+\][+-]?\s*)?(#{1,6}\s+|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+(?:\[.\]\s+)?)?/;

function ppBlocks(doc) {
  const blocks = [];
  const lines = doc.split('\n');
  let pos = 0;
  let i = 0;

  // Frontmatter
  if (lines[0] === '---') {
    let j = 1;
    while (j < lines.length && lines[j] !== '---' && lines[j] !== '...') j++;
    if (j < lines.length) {
      for (let k = 0; k <= j; k++) pos += lines[k].length + 1;
      i = j + 1;
    }
  }

  let cur = null; // { from, parts: [] }
  const flush = () => { if (cur) { blocks.push({ from: cur.from, text: cur.parts.join('\n') }); cur = null; } };

  let fence = null;      // ``` or ~~~ marker
  let inMath = false, inComment = false, inHtmlComment = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    const start = pos;
    pos += line.length + 1;
    const t = line.trim();
    const bare = t.replace(/^(>\s?)+/, '').trim();

    if (fence) { if (bare.startsWith(fence)) fence = null; continue; }
    if (inMath) { if (bare.startsWith('$$')) inMath = false; continue; }
    if (inComment) { if (t.includes('%%')) inComment = false; continue; }
    if (inHtmlComment) { if (t.includes('-->')) inHtmlComment = false; continue; }

    const f = bare.match(/^(`{3,}|~{3,})/);
    if (f) { flush(); fence = f[1]; continue; }
    if (bare.startsWith('$$')) { flush(); if (!(bare.length > 2 && bare.endsWith('$$'))) inMath = true; continue; }
    if (t.startsWith('%%') && !t.slice(2).includes('%%')) { flush(); inComment = true; continue; }
    if (t.startsWith('<!--') && !t.includes('-->')) { flush(); inHtmlComment = true; continue; }

    // Lines that are never prose
    if (!bare || /^\|/.test(bare) || /^(-{3,}|\*{3,}|_{3,})$/.test(bare) || /^\[\^[^\]]+\]:/.test(bare) || /^\[[^\]]+\]:\s/.test(bare)) {
      flush(); continue;
    }

    const lead = line.match(PP_LEAD);
    const leadLen = lead ? lead[0].length : 0;
    const startsItem = lead && (lead[3] || lead[2]);
    const isHeading = lead && lead[3] && lead[3].startsWith('#');

    const masked = ppBlank(line.slice(0, leadLen)) + ppMaskInline(line.slice(leadLen));

    if (startsItem || isHeading) flush();
    if (!cur) cur = { from: start, parts: [] };
    cur.parts.push(masked);
    if (isHeading || (lead && lead[2])) flush(); // headings and callout titles stand alone
  }
  flush();
  return blocks.filter((b) => /\p{L}/u.test(b.text));
}
