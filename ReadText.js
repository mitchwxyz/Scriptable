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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Read Text</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }

body {
  margin: 0;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, system-ui;
  background: #faf8f4;
  color: #252725;
}

header {
  flex: 0 0 auto;
  padding: 20px;
  padding-top: max(20px, env(safe-area-inset-top));
  background: #faf8f4;
  border-bottom: 1px solid #aaa5;
}

h1 { margin: 0 0 14px; font-size: 23px; }
.controls { display: flex; flex-wrap: wrap; align-items: center; gap: 18px; }

button {
  font: inherit;
  font-weight: 600;
  padding: 12px 26px;
  border: 0;
  border-radius: 24px;
  background: #285948;
  color: white;
}

button:disabled { opacity: .55; }
label { font-size: 15px; }

.speed-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 15px;
}

.speed-controls button { min-width: 44px; min-height: 44px; padding: 8px 14px; }
#speed { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
.hint { margin-top: 10px; font-size: 13px; }
#reader span { cursor: pointer; touch-action: manipulation; }
#reader span:focus-visible { outline: 2px solid #285948; outline-offset: 2px; }

#status {
  font-size: 13px;
  margin-top: 12px;
  min-height: 32px;
  white-space: pre-wrap;
}

#reader {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 24px 24px 55vh;
  -webkit-overflow-scrolling: touch;
}

p {
  max-width: 680px;
  margin: 0 auto 28px;
  font: 21px/1.85 Georgia, serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.current { background: #d7eadc; border-radius: 3px; }

@media (prefers-color-scheme: dark) {
  body, header { background: #191d1b; color: #e7e8e3; }
  .current { background: #365847; }
}
</style>
</head>
<body>
<header>
  <h1>Read Text</h1>
  <div class="controls">
    <button id="toggle" type="button">Play</button>
    <label><input id="follow" type="checkbox" checked> Auto-scroll</label>
  </div>
  <div class="speed-controls" role="group" aria-label="Playback speed">
    <span>Speed</span>
    <button id="slower" type="button" aria-label="Decrease speed by 0.1">−</button>
    <output id="speed" aria-live="polite" aria-atomic="true">1.0×</output>
    <button id="faster" type="button" aria-label="Increase speed by 0.1">+</button>
  </div>
  <div class="hint">Tap a word to jump there. Position is approximate.</div>
  <div id="status" role="status">Tap Play or a word to begin.</div>
</header>
<main id="reader">${transcript}</main>
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
  const PREFETCH_CHUNKS = 3;
  const DECODED_CACHE_CHUNKS = 6;
  const MIN_SPEED_STEPS = 5;
  const MAX_SPEED_STEPS = 30;

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
  const loaded = new Set();
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
      button.textContent = wanted ? "Pause" : "Play";
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
    button.textContent = "Stopped";
    status.textContent = String(message);
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
      if (!stopped) button.textContent = wanted ? "Pause" : "Play";
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
      loaded.add(index);
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
      button.textContent = "Replay";
      button.disabled = false;
      status.textContent = "Finished reading.";
      return;
    }

    const progress = wanted
      ? segment
        ? "Reading chunk " + (playing + 1) + " / " + chunks.length
        : "Buffering…"
      : "Paused";
    status.textContent = progress + " · " + loaded.size + " / " + chunks.length + " chunks loaded";
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
