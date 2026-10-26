/* Plain Prose: the analysis. Plain JavaScript, no libraries, no network.
 * It looks at habits (filler words, adverbs, words repeated close together, "said"-bookisms), the rhythm of
 * your sentences, and the note's grade against the range you set. It never rewrites anything. */

const PP_CATS = {
  filler: { name: 'Filler words', tip: 'Often doing no work. Cut it, or keep it if the voice needs it.' },
  adverb: { name: 'Adverbs', tip: 'Could a stronger verb carry this?' },
  weak: { name: 'Weak verbs', tip: 'Was, got, went, made, seemed… Could a sharper verb carry this?' },
  repeat: { name: 'Repeated words', tip: 'Used again close by.' },
  bookism: { name: '“Said” alternatives', tip: '“Said” is usually invisible. A showy tag can pull focus from the dialogue.' },
  flat: { name: 'Flat rhythm', tip: 'These sentences are all about the same length.' },
  hard: { name: 'Above your ceiling', tip: 'Harder than the range you set for this piece.' }
};
const PP_CAT_KEYS = Object.keys(PP_CATS);

const PP_FILLER = ['just', 'really', 'very', 'actually', 'basically', 'simply', 'quite', 'rather', 'somewhat', 'literally', 'totally',
  'completely', 'definitely', 'certainly', 'truly', 'suddenly', 'slightly', 'sort of', 'kind of', 'a bit', 'a little bit', 'in order to',
  'began to', 'started to', 'seemed to', 'managed to', 'decided to', 'that being said', 'needless to say', 'at the end of the day',
  'for all intents and purposes', 'all of a sudden', 'the fact that'];
// -ly words that aren't adverbs (or are rarely worth flagging)
const PP_NOT_ADVERB = new Set(('only early likely unlikely daily weekly monthly yearly hourly nightly family july italy reply apply supply imply comply rely ally rally '
  + 'bully belly jelly holy ugly lonely lovely friendly unfriendly silly chilly curly smelly surly burly hilly jolly folly melancholy monopoly anomaly assembly '
  + 'fly butterfly dragonfly firefly lily emily molly sally holly polly kelly billy willy elderly orderly costly deadly lively lowly manly womanly kindly '
  + 'cowardly scholarly heavenly worldly ghostly gnarly grisly prickly wobbly bubbly cuddly sickly stately timely untimely homely comely courtly beastly '
  + 'brotherly sisterly fatherly motherly neighbourly neighborly leisurely shapely sprightly unruly wily woolly oily wooly doily gully sully tally dally '
  + 'multiply panoply rely mealy steely bodily').split(' '));
const PP_BOOKISM = ['exclaimed', 'hissed', 'snapped', 'growled', 'snarled', 'retorted', 'queried', 'interjected', 'chortled', 'opined', 'ejaculated',
  'expostulated', 'declared', 'proclaimed', 'announced', 'remarked', 'stated', 'uttered', 'quipped', 'chuckled', 'laughed', 'smiled', 'grinned', 'sighed',
  'breathed', 'gasped', 'spat', 'barked', 'roared', 'bellowed', 'shrieked', 'squealed', 'purred', 'cooed', 'gushed', 'beamed', 'smirked', 'sneered',
  'scoffed', 'huffed', 'harrumphed', 'intoned', 'enthused', 'admonished', 'reiterated', 'responded', 'replied', 'answered', 'questioned', 'inquired',
  'enquired', 'mused', 'pondered', 'surmised', 'cajoled', 'pleaded', 'begged', 'demanded', 'insisted', 'warned', 'threatened', 'whined', 'groaned', 'moaned'];
// common words that don't count as repeats
// verbs that carry little on their own. Forms of "be" are skipped before an -ing word (was walking is a tense, not a weak verb),
// and do/did before "not"
const PP_WEAK = new Set('was were is are am be been being got get gets getting went go goes made make makes put puts did do does seemed seem seems'.split(' '));
const PP_BE = new Set('was were is are am be been being'.split(' '));
const PP_STOP = new Set(('the a an and or but if then so of to in on at by for with from up down out over under into onto off as is was were be been being '
  + 'am are do does did done have has had having i me my mine we us our you your he him his she her hers it its they them their this that these those '
  + 'there here what which who whom whose when where why how not no yes all any some each every both few more most other such than too can could will '
  + 'would shall should may might must just very also only even still yet again back now then said says say asked one two like about after before '
  + 'through while because though although around away upon well know think thought see saw look looked come came go went get got make made take took '
  + 'into than them then were what with would your said mrs mr dr ms').split(' '));
const PP_ABBR = /\b(Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|Mt|vs|etc|e\.g|i\.e|cf|No)\.$/;

const ppEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ppPhraseRe(list) { return new RegExp('\\b(' + list.slice().sort((a, b) => b.length - a.length).map(w => ppEsc(w).replace(/\s+/g, '\\s+')).join('|') + ')\\b', 'giu'); }
const ppStem = w => { w = w.toLowerCase().replace(/[’']s$/, ''); if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; if (w.length > 4 && /[^s]s$/.test(w)) return w.slice(0, -1); return w; };
const ppAri = (chars, words, sents) => words && sents ? Math.max(0, 4.71 * (chars / words) + 0.5 * (words / sents) - 21.43) : 0;
const ppMean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function ppCv(a) { if (a.length < 2) return 0; const m = ppMean(a); if (!m) return 0; const v = ppMean(a.map(x => (x - m) ** 2)); return Math.sqrt(v) / m; }

// sentences in one prose block: [{ from, to, text }] (offsets inside the block)
function ppSentences(text) {
  const out = []; let start = 0;
  const re = /[.!?…]+["”’')\]]*(?=\s|$)/g; let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length, piece = text.slice(start, end);
    if (m[0][0] === '.' && PP_ABBR.test(text.slice(Math.max(0, m.index - 5), m.index + 1))) continue;  // Mr. Dr. e.g.
    if (/^\s+[a-z]/.test(text.slice(end, end + 3))) continue;            // “No!” she said. → one sentence
    if (/[\p{L}\p{N}]/u.test(piece)) out.push({ from: start, to: end });
    start = end;
  }
  if (/[\p{L}\p{N}]/u.test(text.slice(start))) out.push({ from: start, to: text.length });
  for (const s of out) { while (s.from < s.to && /\s/.test(text[s.from])) s.from++; s.text = text.slice(s.from, s.to); }
  return out;
}

// the whole note. opts: { floor, ceiling, cats: {key: bool}, window, flatCv, extraFiller, extraBookism, ignore }
function ppAnalyze(doc, opts) {
  const o = Object.assign({ floor: 5, ceiling: 11, window: 60, flatCv: 0.25, extraFiller: [], extraBookism: [], ignore: [] }, opts || {});
  const ignore = new Set(o.ignore.map(w => w.toLowerCase()));
  const fillers = PP_FILLER.concat(o.extraFiller).filter(w => !ignore.has(w.toLowerCase()));
  const fillerRe = ppPhraseRe(fillers), fillerWord = new Set(fillers.filter(w => !/\s/.test(w)).map(w => w.toLowerCase()));
  const bookisms = new Set(PP_BOOKISM.concat(o.extraBookism).map(w => w.toLowerCase()).filter(w => !ignore.has(w)));
  const issues = [], sentences = [], paras = [];
  let words = 0, chars = 0;
  const recent = [];                                   // [{ stem, idx, from }] for repeats
  let wordIdx = 0;
  // names: words written with a capital letter in the middle of a sentence (Teddy, Jack). They're meant to recur.
  // Also: a word that's always capitalised and appears more than once (Teddy, even when it starts every sentence).
  const names = new Set(), capN = new Map(), lowSeen = new Set();
  for (const b of ppBlocks(doc)) for (const s of ppSentences(b.text)) {
    let first = true;
    for (const m of s.text.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
      const w = m[0], l = w.toLowerCase(), before = s.text.slice(Math.max(0, m.index - 2), m.index);
      if (/^\p{Lu}/u.test(w)) { capN.set(l, (capN.get(l) || 0) + 1); if (!first && w !== 'I' && !/[“"‘(]\s*$/.test(before)) names.add(l); }
      else lowSeen.add(l);
      first = false;
    }
  }
  for (const [l, n] of capN) if (n >= 2 && !lowSeen.has(l)) names.add(l);
  for (const l of lowSeen) if (names.has(l) && !capN.has(l)) names.delete(l);
  for (const b of ppBlocks(doc)) {
    if (/^\s*(#{1,6}\s|[-*+]\s+\[.\])/.test(doc.slice(b.from, b.from + 12))) continue;   // headings and tasks aren't prose
    const sents = ppSentences(b.text), lens = [];
    for (const s of sents) {
      const sFrom = b.from + s.from;
      let w = 0, c = 0;
      const toks = [...s.text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
      let skipTo = -1;
      for (let ti = 0; ti < toks.length; ti++) {
        const m = toks[ti], tok = m[0], from = sFrom + m.index, to = from + tok.length, low = tok.toLowerCase();
        const next = toks[ti + 1] ? toks[ti + 1][0].toLowerCase() : '';
        w++; c += tok.replace(/[^\p{L}\p{N}]/gu, '').length; wordIdx++;
        if (ignore.has(low)) continue;
        // adverbs: -ly words that are adverbs
        if (low.length > 4 && low.endsWith('ly') && !PP_NOT_ADVERB.has(low) && !fillerWord.has(low)) issues.push({ type: 'adverb', from, to, word: tok });
        // weak verbs ("there was" counts as one)
        if (ti > skipTo && low === 'there' && /^(was|were|is|are)$/.test(next)) { issues.push({ type: 'weak', from, to: sFrom + toks[ti + 1].index + toks[ti + 1][0].length, word: tok + ' ' + toks[ti + 1][0] }); skipTo = ti + 1; }
        else if (ti > skipTo && PP_WEAK.has(low) && !(PP_BE.has(low) && /ing$/.test(next)) && !(/^(do|does|did)$/.test(low) && next === 'not')) issues.push({ type: 'weak', from, to, word: tok });
        // repeats: a content word used again within the window (names don't count)
        if (low.length >= 4 && !PP_STOP.has(low) && !names.has(low) && !/^\d/.test(low)) {
          const st = ppStem(low);
          while (recent.length && wordIdx - recent[0].idx > o.window) recent.shift();
          const prev = recent.find(r => r.stem === st);
          if (prev) issues.push({ type: 'repeat', from, to, word: tok, first: prev.from, gap: wordIdx - prev.idx });
          recent.push({ stem: st, idx: wordIdx, from });
        }
      }
      // filler words and phrases
      for (const m of s.text.matchAll(fillerRe)) issues.push({ type: 'filler', from: sFrom + m.index, to: sFrom + m.index + m[0].length, word: m[0] });
      const grade = ppAri(c, w, 1);
      sentences.push({ from: sFrom, to: b.from + s.to, words: w, grade });
      lens.push(w); words += w; chars += c;
      if (w >= 8 && grade > o.ceiling) issues.push({ type: 'hard', from: sFrom, to: b.from + s.to, grade });
    }
    // "said"-bookisms: a tag verb just after a closing quote (“No!” she hissed) or just before an opening one (She hissed, “No!”)
    for (const m of b.text.matchAll(/\p{L}+/gu)) {
      const low = m[0].toLowerCase(); if (!bookisms.has(low)) continue;
      const before = b.text.slice(Math.max(0, m.index - 30), m.index), after = b.text.slice(m.index + m[0].length, m.index + m[0].length + 12);
      const afterQuote = /[”"][^”"“.!?]{0,24}$/.test(before), beforeQuote = /^\s*[,:]\s*[“"]/.test(after);
      if (afterQuote || beforeQuote) issues.push({ type: 'bookism', from: b.from + m.index, to: b.from + m.index + m[0].length, word: m[0] });
    }
    // rhythm: a paragraph of 4+ sentences that are all about the same length
    if (sents.length) {
      const cv = ppCv(lens);
      const para = { from: b.from, to: b.from + b.text.length, lens, cv, flat: lens.length >= 4 && cv < o.flatCv };
      paras.push(para);
      if (para.flat) issues.push({ type: 'flat', from: b.from + sents[0].from, to: b.from + sents[sents.length - 1].to, cv });
    }
  }
  issues.sort((a, b) => a.from - b.from || a.to - b.to);
  const lens = sentences.map(s => s.words);
  const grade = ppAri(chars, words, sentences.length);
  const counts = {}; for (const k of PP_CAT_KEYS) counts[k] = 0; for (const i of issues) counts[i.type]++;
  return {
    words, sentences, paras, issues, counts, grade, floor: o.floor, ceiling: o.ceiling,
    band: !words ? 'none' : grade < o.floor ? 'below' : grade > o.ceiling ? 'above' : 'in',
    avgLen: ppMean(lens), cv: ppCv(lens),
    per1000: k => words ? counts[k] * 1000 / words : 0
  };
}
// the few numbers used to compare one note with others
function ppSummary(r) {
  const p = k => r.words ? r.counts[k] * 1000 / r.words : 0;
  return { words: r.words, grade: r.grade, avgLen: r.avgLen, cv: r.cv, filler: p('filler'), adverb: p('adverb'), weak: p('weak'), repeat: p('repeat'), bookism: p('bookism') };
}
