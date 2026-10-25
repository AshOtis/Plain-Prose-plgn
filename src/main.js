/* Plain Prose: a writing coach for Obsidian that points things out and never rewrites.
 * Your own grade range (not "lower is better"), the rhythm of your sentences, habits worth a second look,
 * and how this note compares with the others in its folder. Write mode hides the marks while you draft. */

const PP_VIEW = 'plain-prose-view';
const PP_MAX_CHARS = 600000;
const PP_SET = {
  mode: 'edit', floor: 4, ceiling: 10, delay: 600, window: 60, flatCv: 0.25,
  cats: { filler: true, adverb: true, repeat: true, bookism: true, flat: true, hard: false },
  hidden: [], extraFiller: [], extraBookism: [], ignore: [], wpm: 230
};
const ppList = s => String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
const ppFmt = (n, d = 0) => Number(n || 0).toFixed(d);

class PlainProse extends Plugin {
  async onload() {
    const d = (await this.loadData()) || {};
    this.set = Object.assign({}, PP_SET, d);
    this.set.cats = Object.assign({}, PP_SET.cats, d.cats || {});
    this.watchers = new Set();
    this.folderCache = new Map();                  // path -> { mtime, sum }
    this.registerEditorExtension(ppEditorExtension(this));
    this.registerView(PP_VIEW, leaf => new PPView(leaf, this));
    this.addRibbonIcon('feather', 'Open Plain Prose', () => this.activate());
    this.addCommand({ id: 'open', name: 'Open the panel', callback: () => this.activate() });
    this.addCommand({ id: 'toggle-mode', name: 'Switch between Write and Edit mode', callback: () => this.setMode(this.set.mode === 'write' ? 'edit' : 'write') });
    this.addCommand({ id: 'next', name: 'Go to the next thing marked', callback: () => this.jumpNext() });
    this.addCommand({ id: 'compare', name: 'Compare this note with its folder', callback: async () => { await this.activate(); for (const v of this.views()) v.compare(); } });
    this.status = this.addStatusBarItem(); this.status.addClass('pp-status');
    this.status.onclick = () => this.setMode(this.set.mode === 'write' ? 'edit' : 'write');
    this.addSettingTab(new PPSettings(this.app, this));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf && leaf.view instanceof MarkdownView) this.lastMd = leaf.view;
      this.refresh();
    }));
    this.registerEvent(this.app.vault.on('modify', f => {
      this.folderCache.delete(f.path);
      for (const v of this.views()) if (v.cmp && f.path !== v.cmp.path && f.parent && v.cmp.path.startsWith((f.parent.path === '/' ? '' : f.parent.path + '/')) && !v.cmp.path.slice(f.parent.path.length + 1).includes('/')) v.cmp = null;
    }));
    this.app.workspace.onLayoutReady(() => { const v = this.app.workspace.getActiveViewOfType(MarkdownView); if (v) this.lastMd = v; this.refresh(); });
  }
  save() { return this.saveData(this.set); }
  opts() { return { floor: this.set.floor, ceiling: this.set.ceiling, window: this.set.window, flatCv: this.set.flatCv, extraFiller: this.set.extraFiller, extraBookism: this.set.extraBookism, ignore: this.set.ignore }; }
  views() { return this.app.workspace.getLeavesOfType(PP_VIEW).map(l => l.view).filter(v => v instanceof PPView); }
  async activate() {
    let leaf = this.app.workspace.getLeavesOfType(PP_VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: PP_VIEW, active: true }); }
    this.app.workspace.revealLeaf(leaf);
  }
  setMode(m) { this.set.mode = m; this.save(); this.repaintAll(); this.refresh(); }
  repaintAll() { for (const w of this.watchers) w.paint(); }
  rerunAll() { for (const w of this.watchers) w.soon(0); }

  // the note you're working on: the active one, or the last one if the panel has focus
  md() { const v = this.app.workspace.getActiveViewOfType(MarkdownView); if (v) this.lastMd = v; return this.lastMd && this.lastMd.file ? this.lastMd : null; }
  current() {
    const md = this.md(), cm = md && md.editor && md.editor.cm;
    for (const w of this.watchers) if (w.view === cm) return { md, w };
    return { md, w: null };
  }
  resultChanged(w) { const c = this.current(); if (!c.w || c.w === w) this.refresh(); }
  refresh() {
    const { w } = this.current(), r = w && w.result;
    this.status.setText(r && r.words ? `Grade ${ppFmt(r.grade)} · ${this.set.mode === 'write' ? 'Write' : 'Edit'}` : (this.set.mode === 'write' ? 'Write mode' : ''));
    this.status.setAttr('aria-label', 'Plain Prose: click to switch Write / Edit');
    for (const v of this.views()) v.paint();
  }
  // jump to a range in the note
  jump(from, to) {
    const md = this.md(); if (!md) return;
    const ed = md.editor, a = ed.offsetToPos(from), b = ed.offsetToPos(to);
    this.app.workspace.setActiveLeaf(md.leaf, { focus: true });
    ed.setSelection(a, b); ed.scrollIntoView({ from: a, to: b }, true);
  }
  jumpNext(type) {
    const { md, w } = this.current(); if (!md || !w || !w.result) return;
    const at = md.editor.posToOffset(md.editor.getCursor('to'));
    const list = w.result.issues.filter(i => (type ? i.type === type : this.set.cats[i.type] && !this.set.hidden.includes(i.type)));
    if (!list.length) { new Notice('Nothing marked here.'); return; }
    const next = list.find(i => i.from >= at) || list[0];
    this.jump(next.from, next.to);
  }
  // the other notes in this note's folder, summarised (cached until they change)
  async folderSummary(file) {
    const folder = file.parent, notes = (folder ? folder.children : []).filter(f => f.extension === 'md' && f !== file).slice(0, 300);
    const sums = [];
    for (const f of notes) {
      const hit = this.folderCache.get(f.path);
      if (hit && hit.mtime === f.stat.mtime) { if (hit.sum.words >= 150) sums.push(hit.sum); continue; }
      const text = await this.app.vault.cachedRead(f);
      const sum = text.length > PP_MAX_CHARS ? { words: 0 } : ppSummary(ppAnalyze(text, this.opts()));
      this.folderCache.set(f.path, { mtime: f.stat.mtime, sum });
      if (sum.words >= 150) sums.push(sum);
      await new Promise(r => window.setTimeout(r, 0));          // stay responsive on a big folder
    }
    if (!sums.length) return null;
    const avg = {}; for (const k of ['grade', 'avgLen', 'cv', 'filler', 'adverb', 'repeat', 'bookism']) avg[k] = ppMean(sums.map(s => s[k]));
    return { n: sums.length, folder: folder ? folder.path || '/' : '/', avg };
  }
}

/* ---------- the coach: what the numbers mean ---------- */
// each check: ok (fine), look (worth a glance), fix (worth a revision pass), with a plain-English line
function ppCoach(r, usual, s) {
  const me = ppSummary(r), out = [];
  const close = r.issues.filter(i => i.type === 'repeat' && i.gap <= 20).length, closeK = r.words ? close * 1000 / r.words : 0;
  // benchmarks for fiction, nudged by your own usual when we know it: double your usual is worth a look
  const level = (v, look, fix, mine) => {
    let l = v >= fix ? 'fix' : v >= look ? 'look' : 'ok';
    if (l === 'ok' && mine != null && mine > 0.5 && v >= mine * 2 && v >= look * 0.6) l = 'look';
    return l;
  };
  const vs = (v, u, look) => {
    if (u == null) return v >= look ? ' — on the high side for fiction' : '';
    const rel = v > u * 1.15 ? 'more than you usually use' : v < u * 0.85 ? 'fewer than usual' : 'about your usual';
    return ' — ' + rel + (v >= look && v <= u * 1.15 ? ', though high for fiction' : '');
  };
  const g = r.band === 'in' ? 'ok' : 'look';
  out.push({ key: 'grade', label: 'Readability', level: g,
    say: r.band === 'in' ? `Grade ${ppFmt(r.grade)}, inside your range.` : r.band === 'above' ? `Grade ${ppFmt(r.grade)}, denser than your range. Fine for a slow, close scene; otherwise look at the longest sentences.` : `Grade ${ppFmt(r.grade)}, simpler than your range. Fine for fast action or dialogue.`,
    extra: usual ? (r.grade > usual.grade + 1.5 ? 'Denser than your usual.' : r.grade < usual.grade - 1.5 ? 'Lighter than your usual.' : 'Close to your usual.') : '' });
  const cvL = r.sentences.length < 6 ? 'ok' : r.cv >= 0.5 ? 'ok' : r.cv >= 0.35 ? 'look' : 'fix';
  out.push({ key: 'rhythm', label: 'Rhythm', level: r.counts.flat > 1 ? 'fix' : r.counts.flat === 1 && cvL === 'ok' ? 'look' : cvL,
    say: cvL === 'ok' && !r.counts.flat ? 'Good mix of long and short sentences.' : r.counts.flat ? `${r.counts.flat} paragraph${r.counts.flat === 1 ? '' : 's'} where every sentence is a similar length. Break one up, or let one run long.` : 'Sentences are fairly alike in length. Try a short one after a long one.' });
  out.push({ key: 'adverb', label: 'Adverbs', level: level(me.adverb, 8, 12, usual && usual.adverb),
    say: `${r.counts.adverb} (${ppFmt(me.adverb, 1)} per 1,000 words)${vs(me.adverb, usual && usual.adverb, 8)}. Keep the ones a stronger verb can’t replace.` });
  out.push({ key: 'filler', label: 'Filler words', level: level(me.filler, 5, 8, usual && usual.filler),
    say: `${r.counts.filler} (${ppFmt(me.filler, 1)} per 1,000)${vs(me.filler, usual && usual.filler, 5)}. Cut the ones that do no work; keep any that are a character’s voice.` });
  out.push({ key: 'repeat', label: 'Close repeats', level: level(closeK, 4, 8),
    say: close ? `${close} word${close === 1 ? '' : 's'} used again within 20 words. Change one if it wasn’t on purpose.` : 'No words repeated very close together.' });
  if (s.cats.bookism) out.push({ key: 'bookism', label: '“Said” alternatives', level: level(me.bookism, 2.5, 5),
    say: r.counts.bookism ? `${r.counts.bookism} showy dialogue tag${r.counts.bookism === 1 ? '' : 's'}. “Said” usually reads better.` : 'Dialogue tags are plain. Good.' });
  const fixes = out.filter(x => x.level === 'fix').map(x => x.label.toLowerCase()), looks = out.filter(x => x.level === 'look').map(x => x.label.toLowerCase());
  const and = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0];
  const head = !fixes.length && !looks.length ? 'Reads well. Nothing stands out — this looks like you at your usual.'
    : fixes.length ? `Worth a revision pass on ${and(fixes)}.` + (looks.length ? ` Maybe a glance at ${and(looks)}.` : '')
    : `Mostly fine. Worth a glance at ${and(looks)}.`;
  return { head, checks: out };
}
const PP_LIGHT = { ok: '✓', look: '•', fix: '!' };

/* ---------- the panel ---------- */
class PPView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.cmp = null; }
  getViewType() { return PP_VIEW; }
  getDisplayText() { return 'Plain Prose'; }
  getIcon() { return 'feather'; }
  async onOpen() { this.contentEl.addClass('pp-view'); this.paint(); }
  paint() {
    const p = this.plugin, s = p.set, el = this.contentEl; el.empty();
    const { md, w } = p.current(), r = w && w.result;
    const top = el.createDiv('pp-top');
    top.createEl('b', { text: 'Plain Prose', cls: 'pp-title' });
    const seg = top.createDiv('pp-seg');
    for (const [k, t] of [['write', 'Write'], ['edit', 'Edit']]) {
      const b = seg.createEl('button', { text: t, cls: s.mode === k ? 'is-on' : '' });
      b.onclick = () => p.setMode(k);
      b.setAttr('aria-label', k === 'write' ? 'Write: no marks while you draft' : 'Edit: show what to look at');
    }
    if (!md) { el.createDiv({ cls: 'pp-empty', text: 'Open a note to see how it reads.' }); return; }
    if (w && w.tooLong) { el.createDiv({ cls: 'pp-empty', text: 'This note is very long. Plain Prose works best on a chapter at a time.' }); return; }
    if (!r || !r.words) { el.createDiv({ cls: 'pp-empty', text: r ? 'No prose in this note yet.' : 'Reading…' }); return; }
    if (!this.cmp || this.cmp.path !== md.file.path) window.setTimeout(() => this.compare(), 0);     // so "your usual" is known
    const usual = this.cmp && this.cmp.path === md.file.path && this.cmp.res ? this.cmp.res.avg : null;

    if (s.mode === 'write') el.createDiv({ cls: 'pp-note', text: 'Write mode: nothing is marked in the note. Switch to Edit when you revise.' });

    // grade against your range
    const lo = r.floor, hiG = r.ceiling, own = lo !== s.floor || hiG !== s.ceiling;
    const g = el.createDiv('pp-card');
    const gh = g.createDiv('pp-grade');
    gh.createEl('b', { text: ppFmt(r.grade) }); gh.createSpan({ text: 'grade' });
    const verdict = { in: `In your range (${lo}–${hiG})`, below: `Below your floor (${lo})`, above: `Above your ceiling (${hiG})` }[r.band] + (own ? ' · this note’s own range' : '');
    gh.createDiv({ cls: 'pp-verdict pp-' + r.band, text: verdict });
    const scale = g.createDiv('pp-scale'), max = 20, pct = v => Math.max(0, Math.min(100, v / max * 100)) + '%';
    const band = scale.createDiv('pp-band'); band.setCssProps({ left: pct(lo), width: `calc(${pct(hiG)} - ${pct(lo)})` });
    const mk = scale.createDiv('pp-marker'); mk.setCssProps({ left: pct(r.grade) });
    const sl = g.createDiv('pp-scale-l'); sl.createSpan({ text: 'simpler' }); sl.createSpan({ text: 'denser' });
    const meta = g.createDiv('pp-meta');
    meta.createSpan({ text: `${r.words.toLocaleString()} words` }); meta.createSpan({ text: `${r.sentences.length} sentences` });
    meta.createSpan({ text: `${Math.max(1, Math.round(r.words / s.wpm))} min read` });

    const coach = ppCoach(r, usual, s);

    // rhythm
    const rh = el.createDiv('pp-card');
    const rt = rh.createDiv('pp-h'); rt.createEl('b', { text: 'Rhythm' });
    const feel = r.cv >= 0.55 ? 'Varied' : r.cv >= 0.35 ? 'Steady' : 'Even';
    rt.createSpan({ cls: 'pp-dim', text: `${feel} · average ${ppFmt(r.avgLen)} words a sentence` });
    const bars = rh.createDiv('pp-bars');
    const list = r.sentences.slice(0, 160), hi = Math.max(12, ...list.map(x => x.words));
    const flatAt = r.paras.filter(x => x.flat);
    for (const x of list) {
      const b = bars.createDiv('pp-bar' + (flatAt.some(f => x.from >= f.from && x.to <= f.to) ? ' is-flat' : '') + (s.cats.hard && x.grade > hiG && x.words >= 8 ? ' is-hard' : ''));
      b.setCssProps({ height: Math.max(6, x.words / hi * 100) + '%' });
      b.setAttr('aria-label', `${x.words} words`); b.onclick = () => p.jump(x.from, x.to);
    }
    if (r.sentences.length > 160) rh.createDiv({ cls: 'pp-dim', text: `First 160 of ${r.sentences.length} sentences.` });

    // habits
    const hb = el.createDiv('pp-card');
    const hh = hb.createDiv('pp-h'); hh.createEl('b', { text: 'Worth a second look' });
    // the same judgement as the Coach tab, for each row: ✓ fine · • a glance · ! a revision pass
    const lv = {}; for (const c of coach.checks) lv[c.key] = c.level;
    lv.flat = !r.counts.flat ? 'ok' : r.counts.flat === 1 ? 'look' : 'fix';
    lv.hard = !r.counts.hard ? 'ok' : 'look';
    const aim = { filler: 'Aim: under 5/1k', adverb: 'Aim: under 8/1k', repeat: 'Aim: few close together', bookism: 'Aim: 0–2/1k, “said” is best', flat: 'Aim: none', hard: 'Aim: none, unless wanted' };
    for (const k of PP_CAT_KEYS) {
      if (!s.cats[k]) continue;
      const n = r.counts[k], row = hb.createDiv('pp-row' + (s.hidden.includes(k) ? ' is-hidden' : ''));
      row.createSpan({ cls: 'pp-dot pp-c-' + k });
      const nameBox = row.createDiv('pp-namebox');
      const name = nameBox.createEl('a', { cls: 'pp-name', text: PP_CATS[k].name, attr: { 'aria-label': n ? 'Go to the next one' : PP_CATS[k].tip } });
      name.onclick = () => n && p.jumpNext(k);
      nameBox.createDiv({ cls: 'pp-aim', text: aim[k] });
      const l = lv[k] || 'ok', num = row.createSpan({ cls: 'pp-n pp-v-' + l, text: String(n) });
      num.setAttr('aria-label', l === 'ok' ? 'Fine' : l === 'look' ? 'Worth a glance' : 'Worth a revision pass');
      row.createSpan({ cls: 'pp-dim pp-per', text: k === 'flat' || k === 'hard' ? '' : `${ppFmt(r.per1000(k), 1)}/1k` });
      const eye = row.createEl('button', { cls: 'pp-eye clickable-icon', attr: { 'aria-label': s.hidden.includes(k) ? 'Show these in the note' : 'Hide these in the note' } });
      setIcon(eye, s.hidden.includes(k) ? 'eye-off' : 'eye');
      eye.onclick = () => { s.hidden = s.hidden.includes(k) ? s.hidden.filter(x => x !== k) : s.hidden.concat(k); p.save(); p.repaintAll(); this.paint(); };
    }
    // the words you lean on most in this note
    const rep = new Map(); for (const i of r.issues) if (i.type === 'repeat') { const k = ppStem(i.word); rep.set(k, (rep.get(k) || 0) + 1); }
    const topRep = [...rep.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (topRep.length) { const t = hb.createDiv('pp-tags'); t.createSpan({ cls: 'pp-dim', text: 'Leaning on: ' }); for (const [wd, n] of topRep) t.createSpan({ cls: 'pp-tag', text: `${wd} ×${n + 1}` }); }

    // compared with your other notes in this folder
    const cp = el.createDiv('pp-card');
    const ch = cp.createDiv('pp-h'); ch.createEl('b', { text: 'Compared with your folder' });
    if (!this.cmp || this.cmp.path !== md.file.path) {
      cp.createDiv({ cls: 'pp-dim pp-small', text: 'How this note reads next to the others in the same folder (your other chapters, say).' });
      cp.createEl('button', { text: 'Compare' }).onclick = () => this.compare();
    } else if (this.cmp.busy) cp.createDiv({ cls: 'pp-dim', text: 'Reading the folder…' });
    else if (!this.cmp.res) cp.createDiv({ cls: 'pp-dim', text: 'No other notes with enough prose in this folder yet.' });
    else {
      const a = this.cmp.res.avg, me = ppSummary(r), t = cp.createEl('table', { cls: 'pp-cmp' });
      const hr = t.createEl('tr'); hr.createEl('th'); hr.createEl('th', { text: 'Note' }); hr.createEl('th', { text: 'Usual', attr: { 'aria-label': `Average of your other ${this.cmp.res.n} notes here` } }); hr.createEl('th', { text: 'Aim' });
      // aim: [text, is this note on target?] (null where there's no general target)
      const line = (label, mine, avg, d, unit, aim) => {
        const tr = t.createEl('tr'); tr.createEl('td', { text: label });
        const diff = avg ? (mine - avg) / avg : 0, td = tr.createEl('td', { text: ppFmt(mine, d) + (unit || '') });
        if (Math.abs(diff) >= 0.15) td.createSpan({ cls: 'pp-arrow', text: diff > 0 ? ' ▲' : ' ▼' });
        tr.createEl('td', { cls: 'pp-dim', text: ppFmt(avg, d) + (unit || '') });
        const at = tr.createEl('td', { cls: 'pp-aimcol' + (aim ? (aim[1] ? ' is-on' : ' is-off') : ''), text: aim ? aim[0] : '—' });
        if (aim) at.setAttr('aria-label', aim[1] ? 'On target' : 'Off target');
      };
      line('Grade', me.grade, a.grade, 1, '', [`${r.floor}–${r.ceiling}`, r.band === 'in']);
      line('Words/sentence', me.avgLen, a.avgLen, 1, '', ['10–20', me.avgLen >= 10 && me.avgLen <= 20]);
      line('Variety', me.cv * 100, a.cv * 100, 0, '%', ['50%+', me.cv >= 0.5]);
      line('Filler /1k', me.filler, a.filler, 1, '', ['under 5', me.filler < 5]);
      line('Adverbs /1k', me.adverb, a.adverb, 1, '', ['under 8', me.adverb < 8]);
      line('Repeats /1k', me.repeat, a.repeat, 1, '', null);
      line('“Said” alts /1k', me.bookism, a.bookism, 1, '', ['0–2', me.bookism <= 2]);
    }
  }
  async compare() {
    const md = this.plugin.md(); if (!md) return;
    this.cmp = { path: md.file.path, busy: true }; this.paint();
    const res = await this.plugin.folderSummary(md.file);
    if (this.cmp && this.cmp.path === md.file.path) { this.cmp = { path: md.file.path, res }; this.paint(); }
  }
}

/* ---------- settings ---------- */
class PPSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const p = this.plugin, s = p.set, el = this.containerEl; el.empty();
    const again = () => { p.save(); p.rerunAll(); };
    new Setting(el).setName('Reading the panel').setHeading();
    const lg = el.createDiv('pp-legend');
    const item = (h, t) => { const d = lg.createDiv(); d.createEl('b', { text: h }); d.appendText(' ' + t); };
    item('Worth a second look:', 'fewer is better for all of these, and 0 is good. The count is green when it’s fine, amber when it’s worth a glance, and red when it’s worth a revision pass. The aim under each name is a rough guide for fiction.');
    const c = lg.createDiv('pp-legend-c');
    for (const [cls, t] of [['ok', 'Fine'], ['look', 'Worth a glance'], ['fix', 'Worth a revision pass']]) { const x = c.createSpan(); x.createSpan({ cls: 'pp-n pp-v-' + cls, text: '3' }); x.appendText(' ' + t); }
    item('Compared with your folder:', '“Usual” is the average of your other notes in the same folder (ones with at least 150 words). ▲ ▼ means this note is more than 15% above or below your usual. Neither is wrong: it’s just how this one differs. The Aim column turns green when this note is on target and amber when it’s worth a look. Repeats depend on the scene, so they have no general aim.');
    item('Rhythm:', 'each bar is a sentence (click one to go to it). Good prose usually mixes long and short. Teal bars are a paragraph where every sentence is a similar length.');
    item('Write and Edit:', 'Write hides every mark in the note while you draft. Edit shows them when you revise.');

    new Setting(el).setName('Your grade range').setHeading();
    el.createDiv({ cls: 'setting-item-description', text: 'Lower isn’t better: set the range that suits what you write. The easiest way is from your own work: look at “Usual” for Grade in the panel’s comparison, and set a range about 2 either side of it. On this scale (the Automated Readability Index) most fiction sits around 3–9. One note can have its own range: add  prose-range: 5-10  to its properties.' });
    new Setting(el).setName('Floor').addSlider(x => x.setLimits(1, 18, 1).setValue(s.floor).setDynamicTooltip().onChange(v => { s.floor = Math.min(v, s.ceiling - 1); again(); }));
    new Setting(el).setName('Ceiling').addSlider(x => x.setLimits(2, 20, 1).setValue(s.ceiling).setDynamicTooltip().onChange(v => { s.ceiling = Math.max(v, s.floor + 1); again(); }));

    new Setting(el).setName('What to look for').setHeading();
    for (const k of PP_CAT_KEYS) new Setting(el).setName(PP_CATS[k].name).setDesc(PP_CATS[k].tip + (k === 'hard' ? ' Off by default: long sentences aren’t a fault.' : ''))
      .addToggle(t => t.setValue(s.cats[k]).onChange(v => { s.cats[k] = v; p.save(); p.repaintAll(); p.refresh(); }));
    new Setting(el).setName('Repeats: how close').setDesc('A word counts as repeated if it comes back within this many words.')
      .addDropdown(d => d.addOptions({ 30: '30 words', 60: '60 words', 100: '100 words', 150: '150 words' }).setValue(String(s.window)).onChange(v => { s.window = Number(v); again(); }));
    new Setting(el).setName('Flat rhythm: how even').setDesc('How alike sentence lengths must be for a paragraph (4+ sentences) to count as flat. Lower marks fewer.')
      .addDropdown(d => d.addOptions({ 0.15: 'Very even only', 0.25: 'Even (default)', 0.35: 'Fairly even' }).setValue(String(s.flatCv)).onChange(v => { s.flatCv = Number(v); again(); }));
    new Setting(el).setName('Your words').setHeading();
    new Setting(el).setName('More filler words').setDesc('Words or phrases you overuse, separated by commas.')
      .addTextArea(t => t.setValue(s.extraFiller.join(', ')).onChange(v => { s.extraFiller = ppList(v); again(); }));
    new Setting(el).setName('More “said” alternatives').setDesc('Dialogue tags to mark, separated by commas.')
      .addTextArea(t => t.setValue(s.extraBookism.join(', ')).onChange(v => { s.extraBookism = ppList(v); again(); }));
    new Setting(el).setName('Never mark').setDesc('Words to leave alone: names, dialect, your style. Separated by commas.')
      .addTextArea(t => t.setValue(s.ignore.join(', ')).onChange(v => { s.ignore = ppList(v); again(); }));
    new Setting(el).setName('Reading speed').setDesc('Words a minute, for the read time.')
      .addText(t => t.setValue(String(s.wpm)).onChange(v => { s.wpm = Math.max(80, Number(v) || 230); p.save(); p.refresh(); }));
  }
}
