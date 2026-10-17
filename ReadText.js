// Scriptable: Read Text
// Share plain text, or pass text from Shortcuts.
// Run directly without input for a short live test.
// Store your OpenRouter API key in Keychain as OPENROUTER_TTS_KEY.

const SETTINGS = {
  model: "elevenlabs/eleven-v4-turbo",
  voice: "george",
  chunkCharacters: 2000,
  timeoutSeconds: 30,
  keychainName: "OPENROUTER_TTS_KEY",
};

const TEST_TEXT =
  "This is a live playback test. Tap Pause to stop the audio, " +
  "then Play to continue. The text follows the audio as it plays.";

async function main() {
  if (!Keychain.contains(SETTINGS.keychainName)) {
    throw new Error("Missing Keychain entry: " + SETTINGS.keychainName);
  }

  const key = Keychain.get(SETTINGS.keychainName).trim();
  if (!key) throw new Error("The TTS key is empty.");

  const text = inputText(args) || (config.runsInApp ? TEST_TEXT : "");
  if (!text) throw new Error("Pass the article body as plain text.");

  await readText(text, key);
}

function inputText(input) {
  const shared = (input.plainTexts || []).join("\n\n").trim();
  const shortcut =
    typeof input.shortcutParameter === "string"
      ? input.shortcutParameter.trim()
      : "";

  return shared || shortcut;
}

function splitText(text, limit) {
  if (!Number.isInteger(limit) || limit < 2) {
    throw new Error("chunkCharacters must be an integer of at least 2.");
  }

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > limit) {
    const head = remaining.slice(0, limit);
    const endings = [
      ...remaining.slice(0, limit + 1).matchAll(/[.!?…]["'”’)]*(?=\s)/g),
    ].filter(match => match.index + match[0].length <= limit);
    const lastEnding = endings[endings.length - 1];

    // Prefer sentence boundaries, then whitespace, then a hard character limit.
    let cut = lastEnding
      ? lastEnding.index + lastEnding[0].length
      : Math.max(
          head.lastIndexOf(" "),
          head.lastIndexOf("\n"),
          head.lastIndexOf("\t")
        );

    if (cut <= 0) cut = limit;

    // Avoid splitting an emoji or another surrogate pair.
    const code = remaining.charCodeAt(cut - 1);
    const nextCode = remaining.charCodeAt(cut);
    if (
      code >= 0xd800 && code <= 0xdbff &&
      nextCode >= 0xdc00 && nextCode <= 0xdfff
    ) {
      cut--;
    }

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function speech(text, key) {
  const request = new Request("https://openrouter.ai/api/v1/audio/speech");
  request.method = "POST";
  request.timeoutInterval = SETTINGS.timeoutSeconds;
  request.headers = {
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
  request.body = JSON.stringify({
    model: SETTINGS.model,
    voice: SETTINGS.voice,
    input: text,
    response_format: "mp3",
  });

  const data = await request.load();
  const { statusCode, mimeType } = request.response;

  if (
    statusCode < 200 || statusCode >= 300 ||
    /json|text\//i.test(mimeType || "")
  ) {
    let message = "Speech request failed.";
    try {
      const body = JSON.parse(data.toRawString());
      message = body?.error?.message || body?.message || message;
    } catch (_) {
      // Keep the fallback message for non-JSON error responses.
    }
    throw new Error("HTTP " + statusCode + ": " + message);
  }

  return data.toBase64String();
}

async function readText(text, key) {
  const chunks = splitText(text, SETTINGS.chunkCharacters);
  const view = new WebView();
  const requested = new Set();
  const speechCache = new Map();
  let closed = false;

  // The page requests chunks through cancelled navigations; no native polling.
  view.shouldAllowRequest = request => {
    if (!request.url.startsWith("reader://")) return true;

    const match = /^reader:\/\/chunk\/(\d+)\/(\d+)$/.exec(request.url);
    const index = match ? Number(match[1]) : -1;
    const token = match ? Number(match[2]) : -1;
    const requestID = index + "/" + token;

    if (
      !closed && Number.isSafeInteger(index) &&
      index >= 0 && index < chunks.length &&
      Number.isSafeInteger(token) && token > 0 && !requested.has(requestID)
    ) {
      requested.add(requestID);
      deliver(index, token);
    }

    return false;
  };

  async function deliver(index, token) {
    try {
      // Cache compressed audio so seeking back never repeats a successful API call.
      let pending = speechCache.get(index);
      if (!pending) {
        pending = speech(chunks[index], key);
        speechCache.set(index, pending);
        pending.catch(() => speechCache.delete(index));
      }
      const base64 = await pending;
      if (closed) return;

      // Let the page finish decoding before it requests more. Handle errors there
      // so rapid seeks never share an asynchronous completion callback.
      await view.evaluateJavaScript(`
        window.player.add(${index}, ${JSON.stringify(base64)}, ${token}).catch(
          error => window.player.fail(
            "Audio error: " + String(error.message || error), ${token}
          )
        );
        true;
      `);
    } catch (error) {
      if (closed) return;
      try {
        const message = JSON.stringify(String(error.message || error));
        await view.evaluateJavaScript(`window.player.fail(${message}, ${token}); true;`);
      } catch (_) {
        // The WebView may have been dismissed while the request was in flight.
      }
    }
  }

  await view.loadHTML(playerHTML(chunks));
  try {
    await view.present(false);
  } finally {
    closed = true;
    speechCache.clear();
    requested.clear();
    try {
      await view.evaluateJavaScript("window.player.stop(); true;");
    } catch (_) {
      // A dismissed WebView may no longer accept JavaScript.
    }
  }
}

function escapeHTML(value) {
  const entities = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, character => entities[character]);
}

function playerHTML(chunks) {
  // Keep a readable transcript even if the player JavaScript fails.
  const transcript = chunks.map(text => "<p>" + escapeHTML(text) + "</p>").join("");
  const payload = JSON.stringify({
    chunks,
  }).replace(/</g, "\\u003c");
  const wordCount = (chunks.join(" ").match(/\S+/g) || []).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Read Text</title>
<style>
:root {
  color-scheme: light dark;
  --background: #f6f7f2;
  --surface: #ffffff;
  --text: #1e281e;
  --article: #394337;
  --muted: #66735f;
  --line: #e4e8de;
  --accent: #36552d;
  --on-accent: #f4faed;
  --highlight: #e2edcf;
  --highlight-text: #263e1e;
  --control: #f6f7f2;
  --shadow: 0 8px 32px #26351c0a;
}
* { box-sizing: border-box; }
html { background: var(--background); }

body {
  margin: 0 auto;
  max-width: 860px;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  background: var(--background);
  color: var(--text);
}

.topbar {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 22px 24px;
  padding-top: max(22px, env(safe-area-inset-top));
}

.identity { display: flex; align-items: center; gap: 12px; }
.app-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  background: var(--highlight);
  color: var(--accent);
}
.app-icon svg { width: 23px; height: 23px; }
h1 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -.65px; }
.word-count { margin-top: 4px; font-size: 12px; color: var(--muted); }

button {
  font: inherit;
  font-weight: 600;
  border: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}
button:disabled { opacity: .3; cursor: default; }
button:focus-visible, .follow-control input:focus-visible + .switch {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
button:active:not(:disabled) { opacity: .75; }

.follow-control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  padding: 0 11px;
  border: 1px solid var(--line);
  border-radius: 24px;
  font-size: 12px;
  font-weight: 550;
  color: var(--muted);
  cursor: pointer;
}
.follow-control input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.switch { width: 28px; height: 18px; border-radius: 12px; background: var(--line); }
.switch::after {
  content: "";
  display: block;
  width: 12px;
  height: 12px;
  margin: 3px;
  border-radius: 50%;
  background: var(--surface);
  transition: transform .15s;
}
.follow-control input:checked + .switch { background: var(--accent); }
.follow-control input:checked + .switch::after { transform: translateX(10px); background: var(--on-accent); }

.reading-heading {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 23px 28px 18px;
  color: var(--muted);
  font-size: 11px;
}
.reading-heading strong { font-size: 10px; font-weight: 600; letter-spacing: 1.8px; }
#reader {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 28px;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
#reader::-webkit-scrollbar { display: none; }
#reader::after { content: ""; display: block; height: 35vh; }
#reader p {
  max-width: 680px;
  margin: 0 auto 28px;
  font-size: 21px;
  font-weight: 400;
  line-height: 1.85;
  letter-spacing: -.3px;
  color: var(--article);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
#reader span { cursor: pointer; touch-action: manipulation; border-radius: 3px; }
#reader span:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
#reader .current {
  color: var(--highlight-text);
  background: var(--highlight);
  box-shadow: 0 0 0 3px var(--highlight);
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}

.player-shell {
  flex: 0 0 auto;
  padding: 12px 16px max(16px, env(safe-area-inset-bottom));
}
.player {
  max-width: 680px;
  margin: 0 auto;
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 25px;
  background: var(--surface);
  box-shadow: var(--shadow);
}
.player-meta { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.status-line { display: flex; align-items: center; gap: 7px; min-width: 0; }
.status-dot { flex: 0 0 5px; height: 5px; border-radius: 50%; background: var(--muted); }
.player[data-state="pause"] .status-dot { background: var(--accent); }
.player[data-state="stopped"] .status-dot { background: #e36c63; }
#status { color: var(--muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
#position { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
#progress {
  display: block;
  width: 100%;
  height: 3px;
  margin: 13px 0 18px;
  border: 0;
  border-radius: 4px;
  overflow: hidden;
  appearance: none;
  -webkit-appearance: none;
  background: var(--line);
  color: var(--accent);
}
#progress::-webkit-progress-bar { background: var(--line); border-radius: 4px; }
#progress::-webkit-progress-value { background: var(--accent); border-radius: 4px; }
#progress::-moz-progress-bar { background: var(--accent); border-radius: 4px; }
.playback-controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; }

.speed-controls {
  display: flex;
  align-items: center;
  height: 52px;
  padding: 3px;
  border-radius: 17px;
  background: var(--control);
  border: 1px solid var(--line);
}
.speed-controls button { width: 44px; height: 44px; border-radius: 12px; background: transparent; color: var(--text); font-size: 20px; font-weight: 400; }
#speed { min-width: 48px; text-align: center; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text); }
#toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-width: 126px;
  height: 52px;
  padding: 0 20px;
  border-radius: 17px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 650;
}
#toggle::before { content: ""; width: 14px; height: 16px; background: currentColor; clip-path: polygon(15% 0, 100% 50%, 15% 100%); }
#toggle[data-state="pause"]::before { width: 12px; clip-path: none; background: linear-gradient(to right, currentColor 0 34%, transparent 34% 66%, currentColor 66% 100%); }
#toggle[data-state="replay"]::before { content: "↻"; background: none; clip-path: none; width: 18px; height: 24px; font-size: 24px; line-height: 24px; }
#toggle[data-state="stopped"]::before { width: 12px; height: 12px; clip-path: none; }

@media (max-width: 360px) {
  .topbar { padding-left: 20px; padding-right: 20px; }
  .identity { gap: 9px; }
  .app-icon { width: 36px; height: 36px; border-radius: 12px; }
  h1 { font-size: 19px; }
  .follow-control { gap: 6px; padding: 0 9px; }
  #reader { padding-left: 24px; padding-right: 24px; }
  .reading-heading { padding-left: 24px; padding-right: 24px; }
  .player-shell { padding-left: 12px; padding-right: 12px; }
  .player { padding: 16px; }
  .playback-controls { gap: 10px; }
  .speed-controls button { width: 40px; }
  #speed { min-width: 40px; }
  #toggle { min-width: 104px; padding: 0 12px; }
}
@media (min-width: 600px) {
  .topbar { padding: 28px 40px; }
  .reading-heading { padding: 28px 40px 20px; }
  #reader { padding-left: 40px; padding-right: 40px; }
  #reader p { font-size: 24px; }
}
@media (max-height: 500px) {
  .topbar { padding: 12px 24px; }
  .app-icon { width: 32px; height: 32px; border-radius: 10px; }
  .app-icon svg { width: 20px; height: 20px; }
  h1 { font-size: 18px; }
  .word-count { display: none; }
  .reading-heading { padding: 8px 28px 10px; }
  #reader p { font-size: 18px; line-height: 1.7; }
  .player-shell { padding: 8px 16px max(8px, env(safe-area-inset-bottom)); }
  .player { padding: 12px 16px; border-radius: 20px; }
  #progress { margin: 8px 0 10px; }
  .speed-controls, #toggle { height: 44px; border-radius: 14px; }
  .speed-controls { padding: 0; }
  .speed-controls button { height: 42px; }
}
@media (prefers-reduced-motion: reduce) {
  .switch::after { transition: none; }
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #10130f;
    --surface: #1a1f18;
    --text: #edf2e7;
    --article: #d0d8c9;
    --muted: #8e9a85;
    --line: #2b3327;
    --accent: #d1e7ae;
    --on-accent: #26351b;
    --highlight: #33452a;
    --highlight-text: #e4f4d2;
    --control: #151a13;
    --shadow: 0 8px 32px #00000024;
  }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="identity">
    <div class="app-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 14v-3a8 8 0 0 1 16 0v3"/>
        <rect x="3" y="12" width="4" height="8" rx="2"/>
        <rect x="17" y="12" width="4" height="8" rx="2"/>
      </svg>
    </div>
    <div><h1>Read Text</h1><div class="word-count">${wordCount.toLocaleString()} words</div></div>
  </div>
  <label class="follow-control">
    <span>Follow</span>
    <input id="follow" type="checkbox" aria-label="Automatically follow the spoken text" checked>
    <span class="switch" aria-hidden="true"></span>
  </label>
</header>
<div class="reading-heading"><strong>TRANSCRIPT</strong><span>Tap a word to jump</span></div>
<main id="reader" aria-label="Transcript. Tap a word to jump to its approximate audio position.">${transcript}</main>
<footer class="player-shell">
  <section id="player" class="player" data-state="play" aria-label="Audio player">
    <div class="player-meta">
      <div class="status-line"><span class="status-dot" aria-hidden="true"></span><span id="status" role="status">Ready when you are</span></div>
      <span id="position" aria-hidden="true">0%</span>
    </div>
    <progress id="progress" max="1" value="0" aria-label="Estimated reading progress"></progress>
    <div class="playback-controls">
      <div class="speed-controls" role="group" aria-label="Playback speed">
        <button id="slower" type="button" aria-label="Decrease speed by 0.1">−</button>
        <output id="speed" aria-live="polite" aria-atomic="true">1.0×</output>
        <button id="faster" type="button" aria-label="Increase speed by 0.1">+</button>
      </div>
      <button id="toggle" type="button" data-state="play" aria-label="Play">Play</button>
    </div>
  </section>
</footer>
<script>
function reportPlayerError(message) {
  const text = "Player error: " + String(message);
  if (window.player) window.player.fail(text);
  else document.getElementById("status").textContent = text;
}
window.onerror = function(message) { reportPlayerError(message); };
window.addEventListener("unhandledrejection", function(event) {
  reportPlayerError(event.reason);
});
try {
  (${browserPlayer.toString()})(${payload});
} catch (error) {
  reportPlayerError(error.message);
}
</script>
</body>
</html>`;
}

// Runs inside the WebView. Keep this function independent of Scriptable globals.
function browserPlayer({ chunks }) {
  const button = document.getElementById("toggle");
  const status = document.getElementById("status");
  const reader = document.getElementById("reader");
  const follow = document.getElementById("follow");
  const slower = document.getElementById("slower");
  const faster = document.getElementById("faster");
  const speed = document.getElementById("speed");
  const player = document.getElementById("player");
  const progress = document.getElementById("progress");
  const position = document.getElementById("position");
  const PREFETCH_CHUNKS = 3;
  const DECODED_CACHE_CHUNKS = 6;
  const MIN_SPEED_STEPS = 5;
  const MAX_SPEED_STEPS = 30;
  let totalCharacters = 0;
  const chunkStarts = chunks.map(text => {
    const start = totalCharacters;
    totalCharacters += text.length;
    return start;
  });

  function setProgress(index, character) {
    const fraction = totalCharacters
      ? Math.min(1, Math.max(0, (chunkStarts[index] + character) / totalCharacters))
      : 0;
    progress.value = fraction;
    position.textContent = Math.floor(fraction * 100) + "%";
  }

  function setPlayLabel(label) {
    button.textContent = label;
    button.setAttribute("data-state", label.toLowerCase());
    button.setAttribute("aria-label", label === "Replay" ? "Replay from beginning" : label);
    player.setAttribute("data-state", label.toLowerCase());
  }

  function setStatus(message) {
    if (status.textContent !== message) status.textContent = message;
  }

  reader.textContent = "";
  const words = chunks.map((text, index) => {
    const paragraph = document.createElement("p");
    let end = 0;
    const entries = (text.match(/\S+\s*/g) || []).map(word => {
      const span = document.createElement("span");
      const start = end;
      span.textContent = word;
      span.tabIndex = 0;
      span.setAttribute("role", "button");
      span.setAttribute("aria-label", "Jump to " + word.trim());
      span.onclick = () => seek(index, start);
      span.onkeydown = event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          seek(index, start);
        }
      };
      paragraph.appendChild(span);
      end += word.length;
      return { span, end };
    });
    reader.appendChild(paragraph);
    return entries;
  });

  let context;
  let wanted = false;
  let started = false;
  let busy = false;
  let stopped = false;
  let finished = false;
  let scheduled = 0;
  let playing = 0;
  let tail = 0;
  let highlighted;
  let inFlight = false;
  let requestToken = 0;
  let seekVersion = 0;
  let pendingSeek;
  let timer;
  // Store tenths as integers so repeated taps always change speed by exactly 0.1.
  let speedSteps = 10;

  const buffers = new Map();
  const timeline = [];

  function fetchNext() {
    if (!started || stopped || finished || inFlight) return;
    const limit = Math.min(chunks.length, playing + PREFETCH_CHUNKS);
    for (let index = scheduled; index < limit; index++) {
      if (buffers.has(index)) continue;
      inFlight = true;
      window.location.href = "reader://chunk/" + index + "/" + (++requestToken);
      return;
    }
  }

  function scheduleBuffer(index, buffer, start, offset = 0) {
    const source = context.createBufferSource();
    const rate = speedSteps / 10;
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(context.destination);

    const segment = {
      i: index, buffer, source, start, rate, offset,
      end: start + (buffer.duration - offset) / rate,
    };
    timeline.push(segment);
    source.onended = () => source.disconnect();
    source.start(start, offset);
    tail = segment.end;
  }

  function schedule() {
    while (
      !stopped && !finished && context && buffers.has(scheduled) &&
      scheduled < Math.min(chunks.length, playing + PREFETCH_CHUNKS)
    ) {
      const buffer = buffers.get(scheduled);
      // Refresh the decoded cache's insertion order for recent passages.
      buffers.delete(scheduled);
      buffers.set(scheduled, buffer);
      const start = Math.max(tail, context.currentTime + 0.06);
      const offset = pendingSeek && pendingSeek.index === scheduled
        ? pendingSeek.fraction * buffer.duration : 0;
      scheduleBuffer(scheduled++, buffer, start, offset);
      pendingSeek = null;
    }
  }

  function advanceTimeline(now) {
    // Advance even if a timer tick missed entire chunks of playback.
    while (timeline.length && now >= timeline[0].end) {
      playing = Math.min(timeline[0].i + 1, chunks.length - 1);
      timeline.shift();
      setProgress(playing, 0);
    }
  }

  function updateSpeedControls() {
    speed.textContent = (speedSteps / 10).toFixed(1) + "×";
    slower.disabled = stopped || speedSteps === MIN_SPEED_STEPS;
    faster.disabled = stopped || speedSteps === MAX_SPEED_STEPS;
  }

  function changeSpeed(delta) {
    if (stopped) return;
    const nextSteps = Math.max(
      MIN_SPEED_STEPS, Math.min(MAX_SPEED_STEPS, speedSteps + delta)
    );
    if (nextSteps === speedSteps) return;

    try {
      speedSteps = nextSteps;
      if (context) {
        const now = context.currentTime;
        const rate = speedSteps / 10;
        advanceTimeline(now);
        const current = timeline[0];
        const active = current && now >= current.start;
        const pending = timeline.splice(active ? 1 : 0);

        if (active) {
          // Keep the current source playing from its exact position.
          current.offset += (now - current.start) * current.rate;
          current.start = now;
          current.rate = rate;
          current.end = now + (current.buffer.duration - current.offset) / rate;
          current.source.playbackRate.setValueAtTime(rate, now);
          tail = current.end;
        } else {
          tail = Math.max(now, pending.length ? pending[0].start : now);
        }

        // Future sources have fixed start times: replace them at the new boundaries.
        for (const segment of pending) segment.source.stop();
        for (const segment of pending) {
          scheduleBuffer(segment.i, segment.buffer, tail, segment.offset);
        }
      }
      updateSpeedControls();
      update();
    } catch (error) {
      fail(error.message);
    }
  }

  slower.onclick = () => changeSpeed(-1);
  faster.onclick = () => changeSpeed(1);
  updateSpeedControls();

  function ensureContext() {
    if (context) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    context = new Audio();
  }

  function startTimer() {
    if (!timer) timer = setInterval(update, 100);
  }

  function clearTimeline() {
    for (const segment of timeline) {
      segment.source.onended = null;
      segment.source.stop();
      segment.source.disconnect();
    }
    timeline.length = 0;
  }

  function highlight(entry) {
    if (!entry || entry.span === highlighted) return;
    if (highlighted) highlighted.classList.remove("current");
    highlighted = entry.span;
    highlighted.classList.add("current");
  }

  function resetPosition(index, character) {
    clearTimeline();
    // Invalidate responses from the previous position, including pending decoding.
    requestToken++;
    inFlight = false;
    finished = false;
    scheduled = playing = index;
    tail = context.currentTime;
    pendingSeek = { index, fraction: character / chunks[index].length };
    highlight(words[index].find(word => word.end > character));
    setProgress(index, character);
  }

  async function seek(index, character) {
    if (stopped) return;
    const version = ++seekVersion;
    try {
      ensureContext();
      const shouldPlay = wanted || !started || finished;
      resetPosition(index, character);
      started = true;
      wanted = shouldPlay;
      setPlayLabel(wanted ? "Pause" : "Play");
      button.disabled = false;
      // Resume within the tap handler to satisfy iOS's user gesture requirement.
      await (wanted ? context.resume() : context.suspend());
      if (stopped || version !== seekVersion) return;
      startTimer();
      schedule();
      fetchNext();
      update();
    } catch (error) {
      if (!stopped && version === seekVersion) fail(error.message);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    wanted = false;
    clearInterval(timer);
    timer = null;
    clearTimeline();
    buffers.clear();
    updateSpeedControls();
    if (context) context.close().catch(() => {});
  }

  function fail(message, token) {
    if (token !== undefined && token !== requestToken) return;
    stop();
    button.disabled = true;
    setPlayLabel("Stopped");
    setStatus(String(message));
  }

  button.onclick = async () => {
    if (busy || stopped) return;
    const version = seekVersion;
    busy = true;
    button.disabled = true;

    try {
      ensureContext();
      if (finished) resetPosition(0, 0);

      if (wanted) {
        wanted = false;
        await context.suspend();
      } else {
        await context.resume();
        if (stopped || version !== seekVersion) return;
        started = wanted = true;
        startTimer();
        schedule();
        fetchNext();
      }
      if (!stopped) setPlayLabel(wanted ? "Pause" : "Play");
    } catch (error) {
      if (!stopped && version === seekVersion) fail(error.message);
    } finally {
      busy = false;
      button.disabled = stopped;
    }
  };

  window.player = {
    async add(index, base64, token = requestToken) {
      if (stopped || token !== requestToken) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const buffer = await context.decodeAudioData(bytes.buffer);
      if (stopped || token !== requestToken) return;
      if (!buffer.length) throw new Error("The API returned empty audio.");

      buffers.set(index, buffer);
      while (buffers.size > DECODED_CACHE_CHUNKS) {
        buffers.delete(buffers.keys().next().value);
      }
      inFlight = false;
      schedule();
    },
    fail,
    stop,
  };

  function update() {
    if (!context || stopped || finished || !started) return;
    const now = context.currentTime;
    advanceTimeline(now);
    const segment = timeline.length && now >= timeline[0].start ? timeline[0] : null;

    if (segment) {
      playing = segment.i;
      // Estimated alignment: the API does not provide word timestamps.
      const position = segment.offset + (now - segment.start) * segment.rate;
      const fraction = position / segment.buffer.duration;
      const character = fraction * chunks[playing].length;
      setProgress(playing, character);
      const entries = words[playing];
      const entry =
        entries.find(word => word.end > character) || entries[entries.length - 1];

      highlight(entry);

      if (follow.checked && wanted && highlighted) {
        const box = highlighted.getBoundingClientRect();
        const viewport = reader.getBoundingClientRect();
        const delta = box.top - viewport.top - viewport.height * 0.35;
        reader.scrollTop += delta * 0.22;
      }
    }

    schedule();
    fetchNext();
    if (scheduled === chunks.length && now >= tail) {
      finished = true;
      wanted = false;
      clearInterval(timer);
      timer = null;
      context.suspend().catch(() => {});
      setPlayLabel("Replay");
      button.disabled = false;
      setProgress(chunks.length - 1, chunks[chunks.length - 1].length);
      setStatus("Finished reading.");
      return;
    }

    setStatus(wanted ? segment ? "Reading" : "Loading audio…" : "Paused");
  }
}

try {
  await main();
} catch (error) {
  const alert = new Alert();
  alert.title = "Read Text";
  alert.message = String(error.message || error);
  alert.addAction("OK");
  await alert.presentAlert();
} finally {
  Script.complete();
}
