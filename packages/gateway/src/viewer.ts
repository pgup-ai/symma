/**
 * The whole viewer, inlined as a string so the bundled gateway is one file
 * with zero static assets — `node dist/gateway/server.js` serves everything.
 * Rendering knowledge lives HERE, not in the gateway: the server relays
 * envelopes opaquely, so new ACP update kinds only ever touch this page.
 */
export const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>jbot observer</title>
<style>
  :root {
    --bg:#0c0f14; --panel:#11161e; --elev:#18202b; --line:#232c39;
    --text:#e7edf4; --dim:#8a95a6; --faint:#525d6e;
    --accent:#5aa2f2; --ok:#43b06a; --warn:#d3a03a; --bad:#ef6a5f; --think:#9a86d6;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --ui:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.62 var(--ui);
         display:flex; -webkit-font-smoothing:antialiased; }
  ::selection { background:rgba(90,162,242,.28); }

  aside { width:270px; min-width:224px; border-right:1px solid var(--line); background:var(--panel);
          overflow-y:auto; }
  .brand { padding:17px 16px 13px; font-weight:600; letter-spacing:.2px; display:flex; align-items:center; gap:9px; }
  .brand .mark { width:9px; height:9px; border-radius:2px; background:var(--accent); transform:rotate(45deg); }
  /* connection health (viewer ↔ gateway), distinct from any review's state */
  .conn { margin-left:auto; display:flex; align-items:center; gap:6px; color:var(--faint); font:10px var(--mono);
          text-transform:uppercase; letter-spacing:.4px; }
  .conn .cdot { width:7px; height:7px; border-radius:50%; background:var(--faint); }
  .conn.ok .cdot { background:var(--ok); } .conn.warn .cdot { background:var(--warn); } .conn.bad .cdot { background:var(--bad); }
  .runs { padding:2px 10px 20px; }
  .run { margin-bottom:15px; }
  .run-id { font:11px/1.5 var(--mono); color:var(--faint); padding:5px 8px 3px; word-break:break-all;
            display:flex; align-items:center; gap:7px; }
  .run-id .rdot { width:6px; height:6px; border-radius:50%; background:var(--faint); flex:none; }
  .run-id.completed .rdot { background:var(--ok); } .run-id.failed .rdot { background:var(--bad); }
  .run-id.reviewing .rdot { background:var(--warn); }
  .session { display:flex; align-items:center; gap:9px; width:100%; text-align:left; background:none;
             border:1px solid transparent; color:var(--dim); font:12px/1.3 var(--mono); padding:7px 9px;
             border-radius:8px; cursor:pointer; transition:background .12s,border-color .12s,color .12s; }
  .session:hover { background:var(--elev); color:var(--text); }
  .session.active { border-color:var(--line); background:var(--elev); color:var(--text); }
  .session .sdot { width:6px; height:6px; border-radius:50%; background:var(--faint); flex:none; }
  .session.active .sdot { background:var(--accent); }

  main { flex:1; display:flex; flex-direction:column; min-width:0; position:relative; }
  header.meta { border-bottom:1px solid var(--line); padding:15px 24px 14px;
                display:flex; flex-direction:column; gap:9px;
                background:linear-gradient(180deg,var(--panel),transparent); }
  .meta-top { display:flex; align-items:baseline; gap:10px; }
  .meta-title { font-size:15px; font-weight:600; letter-spacing:.1px; }
  .meta-title .prov { color:var(--dim); font-weight:400; font:12px var(--mono); margin-left:2px; }
  .status { margin-left:auto; align-self:center; display:flex; align-items:center; gap:8px;
            font:12px var(--mono); color:var(--dim); }
  .status .dot { width:8px; height:8px; border-radius:50%; background:var(--faint); }
  .status.reviewing .dot { background:var(--ok); animation:pulse 1.9s infinite; }
  .status.completed .dot { background:var(--ok); }
  .status.failed .dot { background:var(--bad); }
  .status.incomplete .dot { background:var(--warn); }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(67,176,106,.5)} 70%{box-shadow:0 0 0 6px rgba(67,176,106,0)} 100%{box-shadow:0 0 0 0 rgba(67,176,106,0)} }
  .facts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .fact { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border:1px solid var(--line);
          border-radius:20px; background:var(--panel); font:11px var(--mono); white-space:nowrap; }
  .fact .k { color:var(--faint); text-transform:uppercase; letter-spacing:.4px; font-size:10px; }
  .fact b { color:var(--text); font-weight:500; }

  #log { flex:1; overflow-y:auto; padding:22px 24px 44px; }
  .stream { max-width:864px; }
  .msg { white-space:pre-wrap; word-break:break-word; margin:3px 0 15px; }
  .thought { white-space:pre-wrap; word-break:break-word; color:var(--dim); font-style:italic;
             border-left:2px solid var(--think); padding:1px 0 1px 13px; margin:3px 0 15px; opacity:.92; }
  .turn { color:var(--faint); font:10px var(--mono); letter-spacing:.6px; text-transform:uppercase;
          margin:22px 0 13px; display:flex; align-items:center; gap:12px; }
  .turn::after { content:""; flex:1; height:1px; background:var(--line); }
  .chip { display:inline-flex; align-items:center; gap:8px; font:12px var(--mono); border:1px solid var(--line);
          border-radius:7px; padding:4px 10px; margin:2px 7px 9px 0; color:var(--dim); background:var(--panel); }
  .chip .tag { text-transform:uppercase; letter-spacing:.5px; font-size:10px; color:var(--faint); }
  .chip.ok { border-color:rgba(67,176,106,.42); } .chip.ok .tag { color:var(--ok); }
  .chip.bad { border-color:rgba(239,106,95,.42); } .chip.bad .tag { color:var(--bad); }
  .chip.ask { border-color:rgba(211,160,58,.42); } .chip.ask .tag { color:var(--warn); }
  .chip.end { border-color:rgba(90,162,242,.42); color:var(--text); } .chip.end .tag { color:var(--accent); }

  #jump { position:absolute; right:24px; bottom:24px; display:none; align-items:center; gap:6px;
          background:var(--accent); color:#06121f; border:none; border-radius:20px; padding:8px 14px;
          font:12px var(--ui); font-weight:600; cursor:pointer; box-shadow:0 5px 18px rgba(0,0,0,.45); }
  #jump.show { display:inline-flex; }

  #empty { color:var(--faint); padding:52px 8px; max-width:600px; }
  #empty p { margin:0 0 12px; }
  #empty code { font:12px var(--mono); color:var(--dim); background:var(--panel); border:1px solid var(--line);
                padding:2px 7px; border-radius:6px; }
</style>
</head>
<body>
<aside>
  <div class="brand"><span class="mark"></span> jbot observer
    <span class="conn" id="conn"><span class="cdot"></span><span id="connText">connecting</span></span>
  </div>
  <div class="runs" id="runs"></div>
</aside>
<main>
  <header class="meta" id="meta" hidden>
    <div class="meta-top">
      <div class="meta-title"><span id="mRole"></span><span class="prov" id="mProv"></span><span class="prov" id="mSig"></span></div>
      <div class="status" id="mStatus"><span class="dot"></span><span id="mStatusText">idle</span></div>
    </div>
    <div class="facts" id="mFacts"></div>
  </header>
  <div id="log"><div id="empty">
    <p>Pick a session to watch it stream — reasoning, tool calls, permission decisions and findings appear as they happen.</p>
    <p>Feed a real review by pointing it here:<br /><code>JBOT_OBSERVER_URL=http://127.0.0.1:8790 npm run review:local</code></p>
  </div></div>
  <button id="jump">↓ latest</button>
</main>
<script>
var qs = new URLSearchParams(location.search);
var token = qs.get('token');
function withToken(u) { return token ? u + (u.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(token) : u; }

var runsEl = document.getElementById('runs');
var logEl = document.getElementById('log');
var jumpEl = document.getElementById('jump');
var metaEl = document.getElementById('meta');
var connEl = document.getElementById('conn');
var connText = document.getElementById('connText');
var mRole = document.getElementById('mRole');
var mProv = document.getElementById('mProv');
var mStatus = document.getElementById('mStatus');
var mStatusText = document.getElementById('mStatusText');
var mFacts = document.getElementById('mFacts');

// Human labels: "guideline-compliance-2" -> "Guideline compliance 2".
var LABELS = { 'guideline-compliance': 'Guideline compliance', 'addressed-prior-comments': 'Addressed comments',
  'finding-verification': 'Verification', 'changes-since-last-review': 'Changes summary', review: 'Review' };
function pretty(id) {
  var m = id.match(/^(.*?)(?:-(\\d+))?$/);
  var base = m[1], n = m[2];
  var name = LABELS[base] || base.replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  return n ? name + ' ' + n : name;
}
function connState(cls, text) { connEl.className = 'conn ' + cls; connText.textContent = text; }

var es = null, active = null, sseDown = false, staticView = false;
// runId -> status, from the runs poll: a finished run is fetched whole instead
// of replayed frame by frame.
var runStatusById = Object.create(null);
// runId -> updatedAt, so a static view can notice a frame that landed after the
// run was marked terminal and re-read the journal rather than stay short.
var runUpdatedById = Object.create(null);
var staticUpdatedAt = 0;
var msgEl = null, thoughtEl = null;
var meta = null, tick = null;

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function atBottom() { return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80; }
// Measure BEFORE mutating, restore after — otherwise a growing transcript
// pushes the bottom away and following silently stops.
function pinned(mutate) {
  var stick = atBottom();
  mutate();
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}
// Flush first: a chip or turn marker appended now must not jump ahead of the
// text that arrived before it.
function append(node) { flushPending(); pinned(function () { logEl.appendChild(node); }); return node; }
function closeStreams() { flushPending(); msgEl = null; thoughtEl = null; }

// A finished review replays in one burst — 24k frames is normal. Writing each
// straight to the DOM meant a forced layout per frame (pinned measures before,
// scrolls after) and a textContent += whose cost grows with the transcript, so
// the tab stalled for the whole replay. Buffer instead and apply once per
// animation frame: one measure, one scroll, one concatenation per block.
var pending = [], pendingFrame = 0, metaDirty = false;
// Past this many characters a block starts a new element, so appending stays
// proportional to the chunk rather than to everything before it.
var MAX_BLOCK = 64000;
function stream(kind, text) {
  var last = pending[pending.length - 1];
  if (last && last.kind === kind) last.text += text;
  else pending.push({ kind: kind, text: text });
  if (!pendingFrame) pendingFrame = requestAnimationFrame(flushPending);
}
// Drops buffered text without writing it. open() clears the log for the new
// session, so anything still queued belongs to the old one and must not follow
// it in — flushing there would paint the previous transcript into this pane.
function discardPending() {
  if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
  pending = [];
  metaDirty = false;
}
function flushPending() {
  if (pendingFrame) { cancelAnimationFrame(pendingFrame); pendingFrame = 0; }
  if (pending.length > 0) {
    var batch = pending;
    pending = [];
    pinned(function () {
      for (var i = 0; i < batch.length; i++) {
        var kind = batch[i].kind, text = batch[i].text;
        if (kind === 'msg') {
          thoughtEl = null;
          if (!msgEl || msgEl.textContent.length > MAX_BLOCK) { msgEl = el('div', 'msg'); logEl.appendChild(msgEl); }
          msgEl.textContent += text;
        } else {
          msgEl = null;
          if (!thoughtEl || thoughtEl.textContent.length > MAX_BLOCK) { thoughtEl = el('div', 'thought'); logEl.appendChild(thoughtEl); }
          thoughtEl.textContent += text;
        }
      }
    });
  }
  if (metaDirty) { metaDirty = false; renderMeta(); }
}
function chip(cls, tag, text) {
  var c = el('span', 'chip' + (cls ? ' ' + cls : ''));
  c.appendChild(el('span', 'tag', tag));
  if (text) c.appendChild(document.createTextNode(text));
  closeStreams();
  return append(c);
}

function fmt(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n || 0); }
// Local time, and the date only when it is not today — a long transcript is
// usually read the same day it ran, and the date is noise then.
function stamp(ts) {
  var d = new Date(ts);
  var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
}
function elapsed() {
  if (!meta || !meta.firstTs) return '0:00';
  var end = meta.live ? Date.now() : meta.lastTs;
  var s = Math.max(0, Math.round((end - meta.firstTs) / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fact(k, v) {
  var f = el('span', 'fact');
  f.appendChild(el('span', 'k', k));
  f.appendChild(el('b', null, v));
  return f;
}
function renderMeta() {
  if (!meta) return;
  var facts = [];
  if (meta.model) facts.push(fact('model', meta.model));
  if (meta.mode) facts.push(fact('mode', meta.mode));
  if (meta.inTok || meta.outTok) facts.push(fact('tokens', '↑' + fmt(meta.inTok) + '  ↓' + fmt(meta.outTok)));
  if (meta.ctxSize) facts.push(fact('context', fmt(meta.ctxUsed) + ' / ' + fmt(meta.ctxSize)));
  // When it ran, in the reader's timezone: elapsed alone cannot tell yesterday's
  // session from this one, and the sidebar groups by run rather than by time.
  if (meta.firstTs) facts.push(fact('started', stamp(meta.firstTs)));
  if (!meta.live && meta.lastTs) facts.push(fact('ended', stamp(meta.lastTs)));
  facts.push(fact('elapsed', elapsed()));
  mFacts.textContent = '';
  facts.forEach(function (f) { mFacts.appendChild(f); });
  mProv.textContent = meta.version ? meta.agent + ' ' + meta.version : meta.agent;
}
// Review state (reviewing/completed/failed/…) is separate from connection
// health — a dropped socket must never look like a failed review.
function setReview(state, text) {
  mStatus.className = 'status' + (state ? ' ' + state : '');
  mStatusText.textContent = text;
}
function terminal() { return meta && (meta.runStatus === 'completed' || meta.runStatus === 'failed'); }
function onRunStatus(d) {
  if (!meta || d.runId !== (active || '').split('/')[0]) return;
  meta.runStatus = d.status;
  // 'reviewing' is non-terminal: keep the session live so elapsed keeps ticking
  // and frames still flow. completed/failed are terminal.
  meta.live = d.status === 'reviewing';
  setReview(d.status === 'reviewing' ? 'reviewing' : d.status, 'review ' + d.status);
  renderMeta();
}

// Envelope signatures (M2d): the companion signs what it emits, so the page
// checks frames against the key that endpoint advertised rather than trusting
// the gateway that served them.
var sigUnsignedSeq = 0;
var sigKeys = Object.create(null), sigOk = 0, sigBad = 0, sigGaps = 0, sigLastSeq = Object.create(null), sigSeen = {}, sigGen = 0, sigLoadSeq = 0, sigReady = null, sigLoaded = false, sigStarved = false, sigSessionSigned = false, sigPendingUnsigned = 0, sigEl = document.getElementById('mSig');
function b64bytes(b64) {
  var raw = atob(b64), out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function renderSig() {
  var alerts = [];
  if (sigBad > 0) alerts.push(sigBad + ' unverified');
  if (sigGaps > 0) alerts.push(sigGaps + ' sequence gap' + (sigGaps > 1 ? 's' : ''));
  // Colour set on every branch: leaving it behind bleeds a previous session's
  // warning onto a clean one.
  sigEl.style.color = alerts.length > 0 ? 'var(--bad)' : '';
  if (alerts.length > 0) sigEl.textContent = '\u26a0 ' + alerts.join(' \u00b7 ');
  else if (sigOk > 0) sigEl.textContent = '\u2713 signed';
  else sigEl.textContent = '';
}
function loadSigKeys() {
  // Loads race (every poll and open starts one); only the newest may write, or
  // a slow older response would put back keys a later load had replaced.
  var mySeq = ++sigLoadSeq;
  return fetch(withToken('/api/endpoints')).then(function (r) { return r.json(); }).then(function (list) {
    return Promise.all(list.map(function (entry) {
      if (!entry.publicKey) return null;
      // Per entry: one malformed PEM (atob throws synchronously) must cost that
      // endpoint its key, not reject the whole load and blind every session.
      try {
        var der = b64bytes(entry.publicKey.replace(/-----[^-]+-----/g, '').replace(/\\s+/g, ''));
        return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify'])
          .then(function (k) { if (mySeq === sigLoadSeq) sigKeys[entry.endpoint] = k; },
                function () { if (mySeq === sigLoadSeq) delete sigKeys[entry.endpoint]; });
      } catch (err) {
        // An unreadable advertisement must also unseat the previous key, or
        // frames keep reading signed against a key the endpoint no longer
        // provably holds — costing the endpoint its key means exactly that.
        if (mySeq === sigLoadSeq) delete sigKeys[entry.endpoint];
        return null;
      }
    }));
  }).then(function () {
    sigLoaded = true;
    // A session that streamed while keys were missing was never judged (its
    // frames stayed unseen) — replay it now that judging is possible.
    if (sigStarved && active) {
      sigStarved = false;
      var parts = active.split('/');
      open(parts[0], parts[1]);
    }
  }, function () { sigReady = null; });
}
function sha256hex(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
    var bytes = new Uint8Array(buf), out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  });
}
function sigFailed(gen) { if (gen === sigGen) { sigBad++; renderSig(); } }
function checkSig(e) {
  // Invariants, in order: no judging without keys, and no memory of frames seen
  // keyless (a later load must still judge them); one verdict per distinct
  // envelope per generation, where distinct means the WHOLE envelope — seq and
  // sig can each be copied onto rewritten bytes and must not carry a verdict
  // with them; verdicts landing after a session switch are dropped.
  if (!sigLoaded) { sigStarved = true; return; }
  // No signature anywhere in this session and no key for this endpoint: there is
  // no verdict to dedup, so skip the digest. Hashing every frame of an unsigned
  // observer run spends a digest and a retained key per frame to decide nothing.
  // The pending count only needs replay safety, which the seq high-water gives.
  if (typeof e.sig !== 'string' && !sigSessionSigned && !sigKeys[e.endpoint]) {
    if (typeof e.seq === 'number') {
      if (e.seq <= sigUnsignedSeq) return;
      sigUnsignedSeq = e.seq;
    }
    judgeSig(e, sigGen);
    return;
  }
  var gen = sigGen;
  sha256hex(JSON.stringify(e)).then(function (id) {
    if (gen !== sigGen || sigSeen[id]) return;
    sigSeen[id] = 1;
    judgeSig(e, gen);
  });
}
function judgeSig(e, gen) {
  if (typeof e.sig !== 'string') {
    // Client frames are unsigned by design; inbound frames are not. Per frame
    // an all-stripped companion frame and a plain observer frame look alike,
    // so the rule is session-level: signed at all means signed throughout.
    // Strips before the first signature wait in a pending count and land the
    // moment one appears; a never-signed observer session stays blank.
    if (e.dir === 'out') return;
    if (sigSessionSigned || sigKeys[e.endpoint]) return sigFailed(gen);
    if (gen === sigGen) sigPendingUnsigned++;
    return;
  }
  if (!sigSessionSigned && gen === sigGen) {
    sigSessionSigned = true;
    if (sigPendingUnsigned > 0) { sigBad += sigPendingUnsigned; sigPendingUnsigned = 0; renderSig(); }
  }
  // Arrival-order gap tracking, since verdicts resolve async and out of order:
  // a deleted or reordered frame surfaces here, a faked filler fails crypto
  // below, so the badge warns either way. Exact duplicates are folded by the
  // replay dedup and stay an offline finding.
  if (gen === sigGen && typeof e.endpoint === 'string' && typeof e.seq === 'number') {
    if (e.seq !== (sigLastSeq[e.endpoint] || 0) + 1) { sigGaps++; renderSig(); }
    sigLastSeq[e.endpoint] = e.seq;
  }
  var key = sigKeys[e.endpoint];
  // A signature nobody can be checked against is unverified, not unchecked.
  if (!key) return sigFailed(gen);
  var sig;
  // atob throws on malformed base64, and unwinding out of ingest would drop
  // the frame entirely — a tampered journal must not hide one.
  try { sig = b64bytes(e.sig); } catch (err) { return sigFailed(gen); }
  var rest = {};
  for (var k in e) if (k !== 'sig') rest[k] = e[k];
  crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(JSON.stringify(rest)))
    .then(function (ok) {
      // A late result from a session the viewer already left must not count.
      if (gen !== sigGen) return;
      if (ok) sigOk++; else sigBad++;
      renderSig();
    }, function () { sigFailed(gen); });
}

function ingest(e) {
  // Only the named session: a straggler from a just-closed stream would
  // otherwise tally into this session's badge and poison its seq dedup.
  if (active !== e.runId + '/' + e.sessionId) return;
  checkSig(e);
  if (!meta) return;
  // EventSource auto-reconnects on any blip and the server replays the whole
  // journal, so drop frames already rendered (seq is monotonic per session).
  if (typeof e.seq === 'number') {
    if (e.seq <= meta.lastSeq) return;
    meta.lastSeq = e.seq;
  }

  meta.agent = e.agent || meta.agent;
  if (e.model) meta.model = e.model;
  if (!meta.firstTs) meta.firstTs = e.ts;
  meta.lastTs = e.ts;
  if (!meta.started) { meta.started = true; if (meta.live && !terminal()) setReview('reviewing', 'reviewing'); }
  var f = e.frame || {};
  var p = f.params || {};

  if (f.method === 'session/update' && p.update) {
    var u = p.update, k = u.sessionUpdate;
    if (k === 'agent_message_chunk' && u.content && u.content.type === 'text') stream('msg', u.content.text);
    else if (k === 'agent_thought_chunk' && u.content && u.content.type === 'text') stream('think', u.content.text);
    else if (k === 'tool_call') chip('', 'tool', u.title || u.kind || u.toolCallId || 'tool');
    else if (k === 'usage_update') { if (u.used !== undefined) meta.ctxUsed = u.used; if (u.size) meta.ctxSize = u.size; }
  } else if (f.method === 'session/prompt' && e.dir === 'out') {
    closeStreams();
    append(el('div', 'turn', 'prompt · ' + (e.label || '')));
  } else if (f.method === 'session/set_config_option' && e.dir === 'out') {
    if (p.configId === 'model' && p.value) meta.model = p.value;
    if (p.configId === 'mode' && p.value) meta.mode = p.value;
  } else if (f.method === 'session/set_mode' && e.dir === 'out' && p.modeId) {
    meta.mode = p.modeId;
  } else if (f.method === 'session/request_permission' && p.toolCall) {
    chip('ask', 'ask', p.toolCall.kind || p.toolCall.title || 'tool');
  } else if (e.dir === 'out' && f.result && f.result.outcome) {
    var oc = f.result.outcome.outcome;
    if (oc === 'selected') chip('ok', 'allow', f.result.outcome.optionId);
    else chip('bad', 'deny', 'cancelled');
  } else if (e.dir === 'in' && f.id === 1 && f.result && f.result.agentInfo) {
    meta.version = f.result.agentInfo.version || '';
  } else if (e.dir === 'in' && f.result && f.result.stopReason) {
    if (f.result.usage) { meta.inTok = f.result.usage.inputTokens || meta.inTok; meta.outTok = f.result.usage.outputTokens || meta.outTok; }
    meta.live = false;
    var reason = f.result.stopReason;
    chip('end', 'done', reason);
    // Session turn ended. The run-level verdict (if it arrived) is authoritative
    // — don't overwrite it with the per-session outcome.
    if (!terminal()) {
      if (reason === 'end_turn') setReview('completed', 'session ended · ' + reason);
      else setReview('incomplete', 'session ended · ' + reason);
    }
  }
  // Coalesced with the text flush: rebuilding the facts row per frame meant
  // clearing and re-appending it 24k times during a replay. The 1s tick keeps
  // elapsed moving regardless.
  metaDirty = true;
  if (!pendingFrame) pendingFrame = requestAnimationFrame(flushPending);
}

function open(runId, sessionId) {
  if (es) es.close();
  // This session's SSE isn't open yet — mark it down so the poll can't show
  // 'connected' until es.onopen confirms live frames are flowing.
  sseDown = true;
  connState('warn', 'connecting');
  if (tick) clearInterval(tick);
  document.querySelectorAll('.session.active').forEach(function (b) { b.classList.remove('active'); });
  var btn = document.querySelector('[data-key="' + runId + '/' + sessionId + '"]');
  if (btn) btn.classList.add('active');
  active = runId + '/' + sessionId;
  meta = { agent: '', model: '', mode: '', version: '', runStatus: '', firstTs: 0, lastTs: 0, lastSeq: 0, inTok: 0, outTok: 0, ctxUsed: 0, ctxSize: 0, live: true, started: false };
  discardPending();
  logEl.textContent = '';
  closeStreams();
  metaEl.hidden = false;
  mRole.textContent = pretty(sessionId);
  mProv.textContent = '';
  setReview('', 'waiting…');
  renderMeta();
  tick = setInterval(function () { if (meta && meta.live) renderMeta(); }, 1000);
  staticView = false;
  sigGen++; sigOk = 0; sigBad = 0; sigGaps = 0; sigUnsignedSeq = 0; sigLastSeq = Object.create(null); sigSeen = {}; sigStarved = false; sigSessionSigned = false; sigPendingUnsigned = 0; renderSig();
  // Keys before frames: the stream replays the journal on open, and a frame
  // arriving first would be judged against an empty key set.
  // Fresh keys at every open: a companion that attached since the last load
  // would otherwise read as unverified until the next poll.
  sigReady = loadSigKeys();
  var gen = sigGen;
  sigReady.then(function () {
    if (gen !== sigGen) return; // the viewer moved on while keys imported
    startStream(runId, sessionId);
  });
}

function startStream(runId, sessionId) {
  var known = runStatusById[runId];
  if (known && known !== 'reviewing') { loadJournal(runId, sessionId); return; }
  startLiveStream(runId, sessionId);
}
// One compressed, cacheable response instead of 24k SSE messages. Falls back to
// the stream on any failure, so a missing endpoint on an older gateway degrades
// to the previous behaviour rather than an empty pane.
function loadJournal(runId, sessionId) {
  staticView = true;
  staticUpdatedAt = runUpdatedById[runId] || 0;
  connState('warn', 'loading');
  fetch(withToken('/api/runs/' + runId + '/sessions/' + sessionId + '/journal')).then(function (r) {
    if (!r.ok) throw new Error('journal ' + r.status);
    return r.text();
  }).then(function (text) {
    if (active !== runId + '/' + sessionId) return;
    var lines = text.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      var d;
      try { d = JSON.parse(lines[i]); } catch (err) { continue; }
      if (d && d.kind === 'run') onRunStatus(d); else ingest(d);
    }
    flushPending();
    connState('ok', 'complete');
  }).catch(function () {
    if (active !== runId + '/' + sessionId) return;
    staticView = false;
    startLiveStream(runId, sessionId);
  });
}
function startLiveStream(runId, sessionId) {
  staticView = false;
  es = new EventSource(withToken('/api/runs/' + runId + '/sessions/' + sessionId + '/stream'));
  // onopen/onerror move ONLY the connection dot — never the review status.
  es.onopen = function () { sseDown = false; connState('ok', 'connected'); };
  es.onerror = function () { sseDown = true; connState('warn', 'reconnecting'); };
  es.onmessage = function (m) {
    try { var d = JSON.parse(m.data); if (d && d.kind === 'run') onRunStatus(d); else ingest(d); } catch (err) {}
  };
}

logEl.addEventListener('scroll', function () { jumpEl.classList.toggle('show', !atBottom()); });
jumpEl.addEventListener('click', function () { logEl.scrollTop = logEl.scrollHeight; jumpEl.classList.remove('show'); });

var lastRuns = '';
function refreshRuns() {
  if (!sigReady) sigReady = loadSigKeys();
  fetch(withToken('/api/runs')).then(function (r) {
    if (!r.ok) throw new Error('runs ' + r.status);
    return r.text();
  }).then(function (text) {
    // The poll proves the gateway is reachable, but if the SSE stream is down
    // the live view is stale — don't paint over 'reconnecting' with 'connected'.
    if (!sseDown && !staticView) connState('ok', 'connected');
    if (text === lastRuns) return; // unchanged: keep the DOM (and clicks) stable
    lastRuns = text;
    var runs = JSON.parse(text);
    runs.forEach(function (r) {
      runStatusById[r.runId] = r.status;
      runUpdatedById[r.runId] = r.updatedAt;
      if (staticView && active && active.indexOf(r.runId + '/') === 0 && r.updatedAt > staticUpdatedAt) {
        staticUpdatedAt = r.updatedAt;
        var parts = active.split('/');
        open(parts[0], parts[1]);
      }
    });
    runsEl.textContent = '';
    runs.forEach(function (run) {
      var box = el('div', 'run');
      var head = el('div', 'run-id' + (run.status ? ' ' + run.status : ''));
      head.appendChild(el('span', 'rdot'));
      head.appendChild(document.createTextNode(run.runId));
      box.appendChild(head);
      run.sessions.forEach(function (session) {
        var key = run.runId + '/' + session;
        var b = el('button', 'session');
        b.dataset.key = key;
        b.appendChild(el('span', 'sdot'));
        b.appendChild(document.createTextNode(pretty(session)));
        if (active === key) b.classList.add('active');
        b.onclick = function () { open(run.runId, session); };
        box.appendChild(b);
      });
      runsEl.appendChild(box);
    });
  }).catch(function () { connState('bad', 'offline'); });
}
refreshRuns();
setInterval(refreshRuns, 4000);
</script>
</body>
</html>
`;
