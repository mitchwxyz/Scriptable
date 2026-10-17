// Scriptable: Read Text
// Share plain text, or pass text from Shortcuts.
// Run directly without input for a short live test.
// Store your OpenRouter API key in Keychain as OPENROUTER_TTS_KEY.

const SETTINGS = {
  model: "elevenlabs/eleven-v4-turbo",
  voice: "george",
  chunkCharacters: 2000,
  sampleRate: 24000,
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
  let closed = false;

  // The page requests chunks through cancelled navigations; no native polling.
  view.shouldAllowRequest = request => {
    if (!request.url.startsWith("reader://")) return true;

    const match = /^reader:\/\/chunk\/(\d+)$/.exec(request.url);
    const index = match ? Number(match[1]) : -1;

    if (
      !closed && Number.isSafeInteger(index) &&
      index >= 0 && index < chunks.length && !requested.has(index)
    ) {
      requested.add(index);
      deliver(index);
    }

    return false;
  };

  async function deliver(index) {
    try {
      const base64 = await speech(chunks[index], key);
      if (closed) return;

      // Wait for audio decoding before allowing the page to request more.
      const result = await view.evaluateJavaScript(`
        window.player.add(${index}, ${JSON.stringify(base64)}).then(
          () => completion("ok"),
          error => completion("Audio error: " + String(error.message || error))
        );
        null;
      `, true);

      if (result !== "ok") throw new Error(result);
    } catch (error) {
      if (closed) return;
      try {
        const message = JSON.stringify(String(error.message || error));
        await view.evaluateJavaScript(`window.player.fail(${message}); true;`);
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
    sampleRate: SETTINGS.sampleRate,
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
.controls { display: flex; align-items: center; gap: 18px; }

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
  <div id="status" role="status">Tap Play to begin.</div>
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
function browserPlayer({ chunks, sampleRate }) {
  const button = document.getElementById("toggle");
  const status = document.getElementById("status");
  const reader = document.getElementById("reader");
  const follow = document.getElementById("follow");
  const PREFETCH_CHUNKS = 3;

  reader.textContent = "";
  const words = chunks.map(text => {
    const paragraph = document.createElement("p");
    let end = 0;
    const entries = (text.match(/\S+\s*/g) || []).map(word => {
      const span = document.createElement("span");
      span.textContent = word;
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
  let fetched = 0;
  let scheduled = 0;
  let playing = 0;
  let tail = 0;
  let highlighted;
  let inFlight = false;

  const buffers = new Map();
  const timeline = [];

  function fetchNext() {
    if (
      !started || stopped || inFlight || fetched >= chunks.length ||
      fetched >= playing + PREFETCH_CHUNKS
    ) {
      return;
    }
    inFlight = true;
    window.location.href = "reader://chunk/" + fetched;
  }

  function schedule() {
    while (!stopped && context && buffers.has(scheduled)) {
      const buffer = buffers.get(scheduled);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      const start = Math.max(tail, context.currentTime + 0.06);
      tail = start + buffer.duration;
      timeline.push({ i: scheduled, start, end: tail });
      source.onended = () => source.disconnect();
      source.start(start);
      buffers.delete(scheduled++);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    wanted = false;
    clearInterval(timer);
    buffers.clear();
    timeline.length = 0;
    if (context) context.close().catch(() => {});
  }

  function fail(message) {
    stop();
    button.disabled = true;
    button.textContent = "Stopped";
    status.textContent = String(message);
  }

  button.onclick = async () => {
    if (busy || stopped) return;
    busy = true;
    button.disabled = true;

    try {
      if (!context) {
        const Audio = window.AudioContext || window.webkitAudioContext;
        try {
          context = new Audio({ sampleRate });
        } catch (_) {
          context = new Audio();
        }
      }

      if (wanted) {
        wanted = false;
        await context.suspend();
      } else {
        await context.resume();
        if (stopped) return;
        started = wanted = true;
        schedule();
        fetchNext();
      }
      if (!stopped) button.textContent = wanted ? "Pause" : "Play";
    } catch (error) {
      if (!stopped) fail(error.message);
    } finally {
      busy = false;
      button.disabled = stopped;
    }
  };

  window.player = {
    async add(index, base64) {
      if (stopped) return;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const buffer = await context.decodeAudioData(bytes.buffer);
      if (stopped) return;
      if (!buffer.length) throw new Error("The API returned empty audio.");

      buffers.set(index, buffer);
      fetched = index + 1;
      inFlight = false;
      schedule();
    },
    fail,
    stop,
  };

  function update() {
    if (!context || stopped || !started) return;
    const now = context.currentTime;
    // Advance past completed chunks even if a timer tick missed their playback.
    while (timeline.length && now >= timeline[0].end) {
      playing = Math.min(timeline[0].i + 1, chunks.length - 1);
      timeline.shift();
    }
    const segment = timeline.length && now >= timeline[0].start ? timeline[0] : null;

    if (segment) {
      playing = segment.i;
      // Estimated alignment: the API does not provide word timestamps.
      const fraction = (now - segment.start) / (segment.end - segment.start);
      const character = fraction * chunks[playing].length;
      const entries = words[playing];
      const entry =
        entries.find(word => word.end > character) || entries[entries.length - 1];

      if (entry && entry.span !== highlighted) {
        if (highlighted) highlighted.classList.remove("current");
        highlighted = entry.span;
        highlighted.classList.add("current");
      }

      if (follow.checked && wanted && highlighted) {
        const box = highlighted.getBoundingClientRect();
        const viewport = reader.getBoundingClientRect();
        const delta = box.top - viewport.top - viewport.height * 0.35;
        reader.scrollTop += delta * 0.22;
      }
    }

    fetchNext();
    if (scheduled === chunks.length && now >= tail) {
      stop();
      button.textContent = "Done";
      button.disabled = true;
      status.textContent = "Finished reading.";
      return;
    }

    const progress = wanted
      ? segment
        ? "Reading chunk " + (playing + 1) + " / " + chunks.length
        : "Buffering…"
      : "Paused";
    status.textContent = progress + " · " + fetched + " / " + chunks.length + " chunks loaded";
  }

  const timer = setInterval(update, 100);
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
