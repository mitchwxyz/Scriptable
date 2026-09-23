// Scriptable tee-time finder. Keep course.json next to this script.
const localFiles = FileManager.local();
const files = module.filename.startsWith(localFiles.documentsDirectory() + "/")
  ? localFiles : FileManager.iCloud();
const coursePath = files.joinPath(module.filename.replace(/\/[^/]+$/, ""), "course.json");
if (!files.fileExists(coursePath)) throw new Error("Put course.json next to this script.");
await files.downloadFileFromiCloud(coursePath);
const course = JSON.parse(files.readString(coursePath));
for (const name of ["CLUB_ID", "COURSE_ID", "AFFILIATION_TYPE_ID", "BOOKING_AFFILIATION_TYPE_ID", "NB_HOLES"]) {
  if (!course || !["string", "number"].includes(typeof course[name]) || course[name] === "") {
    throw new Error("Set " + name + " in course.json before running.");
  }
}
const { CLUB_ID, COURSE_ID, AFFILIATION_TYPE_ID, BOOKING_AFFILIATION_TYPE_ID,
  NB_HOLES } = course;

const BASE_URL = "https://www.chronogolf.com";
const API_BASE_URL = BASE_URL + "/marketplace/clubs/" + CLUB_ID + "/teetimes";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS = {
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
  "User-Agent": USER_AGENT,
  "Referer": BASE_URL,
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

const organizationRequest = new Request(BASE_URL + "/marketplace/organizations/" + CLUB_ID + "/");
organizationRequest.headers = HEADERS;
organizationRequest.timeoutInterval = 30;
const organization = await organizationRequest.loadJSON();
const organizationStatus = organizationRequest.response && organizationRequest.response.statusCode;
if (organizationStatus !== 200) {
  throw new Error("Organization lookup failed: " + organizationStatus);
}
if (!organization || typeof organization.name !== "string" || !organization.name.trim() ||
    typeof organization.timezone !== "string" || !organization.timezone.trim()) {
  throw new Error("Organization response is missing a course name or timezone.");
}
const COURSE_NAME = organization.name.trim();
const COURSE_TIME_ZONE = organization.timezone.trim();

// Build the tee-time API URL.
function buildUpstreamUrl(date, players) {
  const affiliations = [];
  for (let i = 0; i < players; i++) {
    // The API expects URL-encoded brackets in this query key.
    affiliations.push("affiliation_type_ids%5B%5D=" + AFFILIATION_TYPE_ID);
  }
  return API_BASE_URL +
    "?date=" + encodeURIComponent(date) +
    "&course_id=" + COURSE_ID +
    "&" + affiliations.join("&") +
    "&nb_holes=" + NB_HOLES;
}

function fetchForPartySize(date, players) {
  return (async () => {
    const req = new Request(buildUpstreamUrl(date, players));
    req.headers = HEADERS;
    req.timeoutInterval = 30;
    const json = await req.loadJSON();
    const status = req.response && req.response.statusCode;
    if (status !== 200) {
      throw new Error("Upstream error (" + players + "p): " + status);
    }
    return json; // [{ id, start_time, out_of_capacity }]
  })();
}

async function getTeetimes(date) {
  // Request each party size in parallel.
  const results = await Promise.all([
    fetchForPartySize(date, 1),
    fetchForPartySize(date, 2),
    fetchForPartySize(date, 3),
    fetchForPartySize(date, 4),
  ]);

  // Spots for a tee time = the largest party size it can still take,
  // counting up from 1 (available for 1 & 2 but not 3 -> 2 spots).
  const byId = new Map();

  for (const t of results[0]) {
    byId.set(t.id, { id: t.id, start_time: t.start_time, spots: 0 });
  }

  for (const entry of byId.values()) {
    const id = entry.id;
    for (let p = 0; p < 4; p++) {
      const t = results[p].find((x) => x.id === id);
      if (t && !t.out_of_capacity && entry.spots === p) {
        entry.spots = p + 1;
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) =>
    a.start_time.localeCompare(b.start_time)
  );
}

// WebView page; its JavaScript uses the teetimes:// bridge for API requests.
const PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tee Time Finder</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f3f5f7;
    color: #1f2933;
    min-height: 100vh;
    padding: 24px 16px;
  }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 16px; }
  form.controls {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: flex-end;
    background: #fff;
    padding: 16px;
    border-radius: 10px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    margin-bottom: 20px;
  }
  .field { display: flex; flex-direction: column; gap: 4px; }
  label { font-size: 0.8rem; font-weight: 600; color: #52606d; }
  input, button {
    font: inherit;
    padding: 8px 10px;
    border: 1px solid #cbd2d9;
    border-radius: 6px;
  }
  button {
    background: #1b7a43;
    color: #fff;
    border: none;
    cursor: pointer;
    font-weight: 600;
  }
  button:hover { background: #146234; }
  .clock-wrap {
    position: absolute;
    top: 10px;
    right: 14px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
  }
  .clock {
    font-size: 0.95rem;
    font-weight: 600;
    color: #52606d;
    font-variant-numeric: tabular-nums;
  }
  .status { color: #7b8794; margin-bottom: 12px; font-size: 0.9rem; }
  .status.error { color: #c0392b; }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
  }
  .card {
    position: relative;
    background: #fff;
    border-radius: 10px;
    padding: 14px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-left: 4px solid #1b7a43;
  }
  .card.unavailable { border-left-color: #cbd2d9; opacity: 0.65; }
  .card .time { font-size: 1.1rem; font-weight: 700; }
  .card .spots { font-size: 0.85rem; font-weight: 600; }
  .card .spots.open { color: #1b7a43; }
  .card .spots.full { color: #9aa5b1; }
  a.card { text-decoration: none; color: inherit; display: flex; }
  a.card:hover { box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
  .card .dot {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.25);
  }
</style>
</head>
<body>
<div class="container">
  <h1>Tee Time Finder</h1>

  <form class="controls" id="search-form">
    <div class="clock-wrap">
      <div class="clock" id="clock"></div>
    </div>
    <div class="field">
      <label for="date">Date</label>
      <input type="date" id="date" required>
    </div>
    <button type="submit">Show Tee Times</button>
  </form>

  <div class="status" id="status">Pick a date to see tee times.</div>
  <div class="cards" id="cards"></div>
</div>

<script>
  // Scriptable intercepts teetimes:// URLs and calls the handlers below.
  var form = document.getElementById("search-form");
  var dateInput = document.getElementById("date");
  var statusEl = document.getElementById("status");
  var cardsEl = document.getElementById("cards");
  var baseUrl = ${jsString(BASE_URL)};
  var clubId = ${jsString(CLUB_ID)};
  var courseId = ${jsString(COURSE_ID)};
  var bookingAffiliationTypeId = ${jsString(BOOKING_AFFILIATION_TYPE_ID)};
  var nbHoles = ${jsString(NB_HOLES)};
  var courseTimeZone = ${jsString(COURSE_TIME_ZONE)};

  document.querySelector("h1").textContent = ${jsString(COURSE_NAME)};
  document.title = ${jsString(COURSE_NAME)};

  var dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: courseTimeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  dateInput.value = ["year", "month", "day"].map(function (type) {
    return dateParts.find(function (part) { return part.type === type; }).value;
  }).join("-");

  var clockEl = document.getElementById("clock");
  function tick() {
    clockEl.textContent = new Date().toLocaleTimeString("en-US", {
      hour12: true, timeZone: courseTimeZone
    });
  }
  tick();
  setInterval(tick, 1000);

  function formatTime(t) {
    var parts = t.split(":");
    var h = Number(parts[0]);
    var m = Number(parts[1]);
    var ampm = h >= 12 ? "PM" : "AM";
    var hour = h % 12 || 12;
    var mm = (m < 10 ? "0" : "") + m;
    return hour + ":" + mm + " " + ampm;
  }

  // Book through day 7; day 8 opens at 9pm in the course time zone.
  function isBookable(dateStr) {
    var nowAtCourse = new Date(new Date().toLocaleString("en-US", { timeZone: courseTimeZone }));
    var today = new Date(nowAtCourse.getFullYear(), nowAtCourse.getMonth(), nowAtCourse.getDate());
    var p = dateStr.split("-");
    var y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
    var diffDays = Math.round((new Date(y, m - 1, d) - today) / 86400000);
    if (diffDays < 0 || diffDays > 8) return false;
    if (diffDays <= 7) return true;
    return nowAtCourse.getHours() >= 21;
  }

  function bookingUrl(date, teetimeId, spots) {
    var affiliationIds = Array(Math.max(1, spots)).fill(bookingAffiliationTypeId).join(",");
    return baseUrl + clubId + "/widget" +
      "?medium=widget&source=club" +
      "#?date=" + date + "&course_id=" + courseId + "&nb_holes=" + nbHoles +
      "&affiliation_type_ids=" + affiliationIds +
      "&teetime_id=" + teetimeId;
  }

  function render(teetimes, date) {
    cardsEl.innerHTML = "";
    if (!teetimes.length) {
      statusEl.textContent = "No tee times found for that date.";
      return;
    }
    var available = teetimes.filter(function (t) { return t.spots > 0; }).length;
    var p = date.split("-");
    var dateLabel = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
      .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    statusEl.textContent = dateLabel + " | " + teetimes.length +
      " tee times — " + available + " available.";

    var bookable = isBookable(date);

    teetimes.forEach(function (t) {
      var open = t.spots > 0;
      var clickable = bookable && open;
      var card = document.createElement(clickable ? "a" : "div");
      card.className = "card" + (open ? "" : " unavailable");
      if (clickable) {
        var url = bookingUrl(date, t.id, t.spots);
        card.href = "#";
        card.addEventListener("click", function (ev) {
          ev.preventDefault();
          window.location.href = "teetimes://open?url=" + encodeURIComponent(url);
        });
      }
      card.innerHTML =
        (clickable ? '<div class="dot" title="Bookable"></div>' : "") +
        '<div class="time">' + formatTime(t.start_time) + "</div>" +
        '<div class="spots ' + (open ? "open" : "full") + '">' +
        (open ? t.spots + " spot" + (t.spots > 1 ? "s" : "") + " available" : "Full") +
        "</div>";
      cardsEl.appendChild(card);
    });
  }

  // Scriptable calls these with tee-time results or errors.
  window.__teetimes_onData = function (data, date) {
    statusEl.className = "status";
    render(data, date);
  };
  window.__teetimes_onError = function (message) {
    statusEl.className = "status error";
    statusEl.textContent = "Error: " + message;
  };

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    statusEl.className = "status";
    statusEl.textContent = "Loading…";
    cardsEl.innerHTML = "";
    window.location.href = "teetimes://api?date=" + encodeURIComponent(dateInput.value);
  });
</scr` + `ipt>
</body>
</html>
`;

// Parse URL-encoded bridge parameters.
function getQueryParam(query, name) {
  const pairs = query.split("&");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeURIComponent(key) === name) {
      return decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1));
    }
  }
  return null;
}

function jsString(value) {
  // Safe to embed inside an evaluateJavaScript call.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Handle teetimes:// requests from the WebView.
async function handleBridge(wv, url) {
  const rest = url.slice("teetimes://".length);
  const q = rest.indexOf("?");
  const action = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  if (action === "api") {
    const date = getQueryParam(query, "date");
    try {
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error("Missing or invalid date (expected YYYY-MM-DD).");
      }
      const data = await getTeetimes(date);
      await wv.evaluateJavaScript(
        "window.__teetimes_onData(" + jsString(data) + "," + jsString(date) + ");"
      );
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      await wv.evaluateJavaScript("window.__teetimes_onError(" + jsString(msg) + ");");
    }
  } else if (action === "open") {
    const target = getQueryParam(query, "url");
    if (target) Safari.open(target);
  }
}

// Present the tee-time page in Scriptable.
async function runApp() {
  const wv = new WebView();
  wv.shouldAllowRequest = (req) => {
    const url = req.url || "";
    if (url.indexOf("teetimes://") === 0) {
      handleBridge(wv, url); // async, fire-and-forget
      return false; // never let the WebView navigate to the bridge URL
    }
    return true;
  };

  await wv.loadHTML(PAGE_HTML, null);
  await wv.present(true); // fullscreen in the app; resolves when dismissed
}

await runApp();
Script.complete();
