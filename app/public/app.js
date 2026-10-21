const $ = (sel, root = document) => root.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function formatBody(body) {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

/** Renders a message as a summary line plus collapsible properties/body. */
function messageHtml(msg) {
  const props = Object.entries(msg)
    .filter(([k, v]) => k !== "body" && v !== undefined && v !== null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`)
    .join("");
  return `<dl class="props">${props}</dl><pre>${esc(formatBody(msg.body))}</pre>`;
}

// ---------- Entities & send form ----------

let entities;
const form = $("#send-form");

async function loadEntities() {
  entities = await api("/api/entities");
  const select = form.elements.target;
  select.innerHTML = entities.targets
    .map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${t.kind})</option>`)
    .join("");
  $("#target-names").innerHTML = entities.targets.map((t) => `<option value="${esc(t.name)}">`).join("");
}

function readSendForm() {
  const f = form.elements;
  const req = { target: f.target.value, body: f.body.value, json: f.json.checked, count: Number(f.count.value) };
  for (const key of ["messageId", "correlationId", "subject", "replyTo", "sessionId", "replyToSessionId", "to", "contentType"]) {
    if (f[key].value) req[key] = f[key].value;
  }
  if (f.applicationProperties.value.trim()) req.applicationProperties = JSON.parse(f.applicationProperties.value);
  return req;
}

function fillSendForm(req) {
  const f = form.elements;
  for (const [key, value] of Object.entries(req)) {
    if (!f[key]) continue;
    if (key === "json") f.json.checked = value;
    else if (key === "applicationProperties") f[key].value = JSON.stringify(value);
    else f[key].value = value;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("#send-status");
  try {
    const req = readSendForm();
    const { sent } = await api("/api/send", { method: "POST", body: JSON.stringify(req) });
    status.className = "status ok";
    status.textContent = `Sent ${sent} message(s) to ${req.target}`;
  } catch (err) {
    status.className = "status err";
    status.textContent = err.message;
  }
});

// Send templates are a per-browser convenience, kept in localStorage.
const TEMPLATE_KEY = "sbmock.templates";
function loadTemplates() {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function renderTemplates() {
  const templates = loadTemplates();
  $("#templates").innerHTML =
    `<option value="">Templates…</option>` +
    Object.keys(templates).map((name) => `<option>${esc(name)}</option>`).join("");
}
$("#templates").addEventListener("change", (e) => {
  const template = loadTemplates()[e.target.value];
  if (template) {
    form.reset();
    fillSendForm(template);
  }
  e.target.value = "";
});
$("#save-template").addEventListener("click", () => {
  const name = prompt("Template name");
  if (!name) return;
  try {
    const templates = loadTemplates();
    templates[name] = readSendForm();
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
    renderTemplates();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- Responders ----------

async function loadResponders() {
  const list = await api("/api/responders");
  const container = $("#responders");
  container.innerHTML = "";
  for (const r of list) container.append(responderEl(r));
}

function responderEl(r) {
  const el = $("#responder-tpl").content.firstElementChild.cloneNode(true);
  const id = r.source.id;
  $(".name", el).textContent = id;

  const setState = (listening, handled) => {
    const state = $(".state", el);
    state.textContent = listening ? "listening" : "off";
    state.classList.toggle("on", listening);
    if (handled !== undefined) $(".count", el).textContent = `${handled} handled`;
  };
  setState(r.listening, r.handled);

  const update = async (patch) => {
    try {
      const config = await api(`/api/responders?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setState(config.mode !== "off");
    } catch (err) {
      alert(err.message);
    }
  };

  const modes = $(".modes", el);
  for (const mode of entities.modes) {
    const label = document.createElement("label");
    label.className = "mode";
    label.innerHTML = `<input type="radio" name="mode-${esc(id)}" value="${mode}"> ${mode}`;
    const input = $("input", label);
    input.checked = r.config.mode === mode;
    input.addEventListener("change", () => update({ mode }));
    modes.append(label);
  }

  for (const input of el.querySelectorAll("input[name], textarea[name]")) {
    const key = input.name;
    if (input.type === "checkbox") input.checked = r.config[key];
    else input.value = r.config[key];
    input.addEventListener("change", () => {
      const value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
      update({ [key]: value });
    });
  }

  for (const btn of el.querySelectorAll("[data-peek]")) {
    btn.addEventListener("click", () => openPeek(id, btn.dataset.peek === "true"));
  }
  return el;
}

$("#save-defaults").addEventListener("click", async () => {
  const { path } = await api("/api/responders/save", { method: "POST" });
  alert(`Saved to ${path}`);
});

// ---------- Peek dialog ----------

const dialog = $("#peek-dialog");
let peekState;

async function openPeek(id, dlq) {
  peekState = { id, dlq };
  $("#peek-title").textContent = `${id}${dlq ? " (dead-letter)" : ""}`;
  dialog.showModal();
  await refreshPeek();
}

async function refreshPeek() {
  const list = $("#peek-list");
  list.innerHTML = "<li>Loading…</li>";
  try {
    const q = `id=${encodeURIComponent(peekState.id)}&dlq=${peekState.dlq}`;
    const messages = await api(`/api/peek?${q}`);
    list.innerHTML = messages.length
      ? messages.map((m) => `<li>${messageHtml(m)}</li>`).join("")
      : "<li class='empty'>No messages</li>";
  } catch (err) {
    list.innerHTML = `<li class="err">${esc(err.message)}</li>`;
  }
}

$("#peek-refresh").addEventListener("click", refreshPeek);
$("#peek-close").addEventListener("click", () => dialog.close());
$("#peek-purge").addEventListener("click", async () => {
  if (!confirm(`Delete all messages in ${$("#peek-title").textContent}?`)) return;
  const q = `id=${encodeURIComponent(peekState.id)}&dlq=${peekState.dlq}`;
  await api(`/api/purge?${q}`, { method: "POST" });
  await refreshPeek();
});

// ---------- Emulator (docker / podman compose) ----------

const emuState = $("#emu-state");
const emuButtons = document.querySelectorAll("#emulator [data-action]");

function describeEmulator(s) {
  if (s.running) return { text: `${s.running}…`, cls: "busy" };
  if (!s.available) return { text: `${s.engine} not running`, cls: "err" };
  const emu = s.containers.find((c) => c.name === "servicebus-emulator");
  if (!emu) return { text: "not created", cls: "" };
  const sql = s.containers.find((c) => c.name === "sqledge");
  if (sql && sql.state !== "running") return { text: "SQL container stopped (check Logs → sqledge)", cls: "err" };
  if (emu.state !== "running") return { text: emu.state, cls: "err" };
  return s.healthy ? { text: "running", cls: "on" } : { text: "starting…", cls: "busy" };
}

async function refreshEmulator() {
  try {
    const s = await api("/api/emulator");
    const { text, cls } = describeEmulator(s);
    emuState.textContent = text;
    emuState.className = `badge ${cls}`;
    emuState.title = [
      s.error,
      `engine: ${s.engine}${s.engineChoice === "auto" ? " (auto)" : ""}`,
      `compose: ${s.compose}`,
      ...s.containers.map((c) => `${c.name}: ${c.status}`),
    ].filter(Boolean).join("\n");
    for (const btn of emuButtons) btn.disabled = !!s.running || !s.available;
    const engineSelect = $("#emu-engine");
    if (document.activeElement !== engineSelect) engineSelect.value = s.engineChoice;
    engineSelect.disabled = !!s.running;
  } catch (err) {
    emuState.textContent = "unknown";
    emuState.title = err.message;
  }
}

for (const btn of emuButtons) {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    if (action === "down" && !confirm("Stop and remove the emulator containers? Messages in the emulator will be lost.")) return;
    try {
      await api(`/api/emulator/${action}`, { method: "POST" });
    } catch (err) {
      alert(err.message);
    }
    refreshEmulator();
  });
}

// Poll faster while a command is running or the emulator is starting.
async function pollEmulator() {
  await refreshEmulator();
  const busy = emuState.classList.contains("busy");
  setTimeout(pollEmulator, busy ? 1500 : 5000);
}

$("#emu-engine").addEventListener("change", async (e) => {
  try {
    await api("/api/emulator/engine", { method: "PUT", body: JSON.stringify({ engine: e.target.value }) });
  } catch (err) {
    alert(err.message);
  }
  refreshEmulator();
});

const logsDialog = $("#logs-dialog");
async function refreshLogs() {
  const out = $("#logs-output");
  out.textContent = "Loading…";
  const res = await fetch(`/api/emulator/logs?service=${$("#logs-service").value}`);
  out.textContent = res.ok ? (await res.text()) || "(no output)" : (await res.json()).error;
  out.scrollTop = out.scrollHeight;
}
$("#emu-logs").addEventListener("click", () => {
  logsDialog.showModal();
  refreshLogs();
});
$("#logs-refresh").addEventListener("click", refreshLogs);
$("#logs-service").addEventListener("change", refreshLogs);
$("#logs-close").addEventListener("click", () => logsDialog.close());

// The config editor saved new queues/topics: refresh send targets and responders.
window.addEventListener("config-saved", async () => {
  await loadEntities();
  await loadResponders();
});

// ---------- Activity feed ----------

const activityList = $("#activity");
const filterInput = $("#filter");

function activityEl(a) {
  const li = document.createElement("li");
  li.className = `activity ${a.kind}`;
  li.dataset.search = JSON.stringify(a).toLowerCase();
  const time = new Date(a.time).toLocaleTimeString();
  const summary = `<span class="time">${time}</span><span class="kind">${a.kind}</span><span class="entity">${esc(a.entity)}</span><span class="text">${esc(a.text)}</span>`;
  li.innerHTML = a.message ? `<details><summary>${summary}</summary>${messageHtml(a.message)}</details>` : `<div class="line">${summary}</div>`;
  applyFilter(li);
  return li;
}

function applyFilter(li) {
  const q = filterInput.value.trim().toLowerCase();
  li.hidden = q !== "" && !li.dataset.search.includes(q);
}

function addActivity(a) {
  activityList.prepend(activityEl(a));
  while (activityList.children.length > 500) activityList.lastElementChild.remove();
}

filterInput.addEventListener("input", () => activityList.querySelectorAll("li").forEach(applyFilter));
$("#clear").addEventListener("click", async () => {
  await api("/api/activity", { method: "DELETE" });
  activityList.innerHTML = "";
});

function connectEvents() {
  const conn = $("#conn");
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    conn.textContent = "live";
    conn.className = "badge on";
  });
  source.addEventListener("error", () => {
    conn.textContent = "disconnected – retrying";
    conn.className = "badge err";
  });
  source.addEventListener("activity", (e) => addActivity(JSON.parse(e.data)));
}

// ---------- Boot ----------

await loadEntities();
renderTemplates();
await loadResponders();
for (const a of await api("/api/activity")) addActivity(a);
connectEvents();
pollEmulator();
