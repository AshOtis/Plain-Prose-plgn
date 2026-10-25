/* Plain Prose: the editor side. Analyses the note a moment after you stop typing, and in Edit mode
 * marks what it found. In Write mode nothing is marked, so drafting stays clean. */

const { StateEffect, StateField } = require('@codemirror/state');
const { Decoration, EditorView, ViewPlugin } = require('@codemirror/view');

const ppSetMarks = StateEffect.define();
const ppMarkField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) if (e.is(ppSetMarks)) marks = e.value;
    return marks;
  },
  provide: f => EditorView.decorations.from(f)
});

const ppMarkCache = new Map();
function ppMark(type, note) {
  const key = type + '\u0000' + note;
  let m = ppMarkCache.get(key);
  if (!m) { m = Decoration.mark({ class: `pp-mark pp-${type}`, attributes: { title: note } }); if (ppMarkCache.size > 400) ppMarkCache.clear(); ppMarkCache.set(key, m); }
  return m;
}
function ppNote(i) {
  const c = PP_CATS[i.type];
  if (i.type === 'repeat') return `“${i.word}” again, ${i.gap} words after the last one`;
  if (i.type === 'hard') return `Grade ${i.grade.toFixed(0)}: above your ceiling`;
  if (i.type === 'flat') return c.tip + ' Try a short one, or a long one.';
  return `${c.name}: ${c.tip}`;
}
function ppMarks(plugin, result) {
  const s = plugin.set;
  if (!result || s.mode === 'write') return Decoration.none;
  const ranges = [];
  for (const i of result.issues) if (s.cats[i.type] && !s.hidden.includes(i.type) && i.to > i.from) ranges.push(ppMark(i.type, ppNote(i)).range(i.from, i.to));
  return Decoration.set(ranges, true);
}

function ppEditorExtension(plugin) {
  const watcher = ViewPlugin.fromClass(class {
    constructor(view) { this.view = view; plugin.watchers.add(this); this.soon(60); }
    update(u) { if (u.docChanged) this.soon(plugin.set.delay); }
    soon(ms) { window.clearTimeout(this.t); this.t = window.setTimeout(() => this.run(), ms); }
    run() {
      const text = this.view.state.doc.toString();
      const opts = plugin.opts();
      // a note's own range, from its properties:  prose-range: 7-12
      const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/), fm = head && head[1].match(/^prose-range:\s*(\d+)\s*[-–]\s*(\d+)/m);
      if (fm) { opts.floor = Number(fm[1]); opts.ceiling = Math.max(Number(fm[2]), opts.floor + 1); }
      this.result = text.length > PP_MAX_CHARS ? null : ppAnalyze(text, opts);
      this.tooLong = text.length > PP_MAX_CHARS;
      this.paint();
      plugin.resultChanged(this);
    }
    paint() { this.view.dispatch({ effects: ppSetMarks.of(ppMarks(plugin, this.result)) }); }
    destroy() { window.clearTimeout(this.t); plugin.watchers.delete(this); }
  });
  return [ppMarkField, watcher];
}
