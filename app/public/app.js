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

// ---------- Environments (tabs) ----------

const ENV_KEY = "sbmock.env";
let environments = [];
let currentEnv = "local";
const envParam = (env = currentEnv) => `env=${encodeURIComponent(env)}`;
const activeEnv = () => environments.find((e) => e.id === currentEnv) ?? environments[0];

function renderTabs() {
  $("#tabs").innerHTML =
    environments
      .map((e) => {
        const tags = (e.readOnly ? '<span class="tab-tag">read-only</span>' : "") + (e.error ? '<span class="tab-tag err">!</span>' : "");
        return `<button class="tab${e.id === currentEnv ? " active" : ""}" data-env="${esc(e.id)}" title="${esc(e.namespace)}">${esc(e.name)}${tags}</button>`;
      })
      .join("") + `<button class="tab add" id="tab-add" title="Add a real Service Bus namespace (read-only)">+ Add environment</button>`;
}

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  if (tab.id === "tab-add") openEnvDialog();
  else switchEnv(tab.dataset.env);
});

async function loadEnvironments() {
  environments = await api("/api/environments");
  if (!environments.some((e) => e.id === currentEnv)) currentEnv = "local";
  renderTabs();
}

async function switchEnv(id) {
  currentEnv = id;
  try {
    localStorage.setItem(ENV_KEY, id);
  } catch {}
  const env = activeEnv();
  renderTabs();
  $("#emulator").hidden = env.kind !== "emulator";
  $("#responders-panel").hidden = env.readOnly;
  $("#env-panel").hidden = !env.readOnly;
  $("#send-status").textContent = "";
  activityList.querySelectorAll("li").forEach(applyFilter);
  await loadEntities();
  if (env.readOnly) renderEnvPanel();
}

function renderEnvPanel() {
  const env = activeEnv();
  const refreshed = env.refreshedAt ? `, listed ${new Date(env.refreshedAt).toLocaleTimeString()}` : "";
  const scopes = env.connections.map((c) => (c.scope === "namespace" ? "namespace key" : `key for ${c.scope}`)).join(", ");
  $("#env-info").textContent = `${env.namespace} · ${scopes}${refreshed}`;
  $("#env-error").textContent = env.error ?? "";
  const counts = entities.counts ?? {};
  $("#env-entities").innerHTML = entities.sources.length
    ? entities.sources
        .map((s) => {
          const c = counts[s.id] ?? {};
          const dlq = c.deadLetter ? ` · <span class="dlq-count">${c.deadLetter} dead-lettered</span>` : "";
          return `<li class="entity-row">
            <div><strong>${esc(s.id)}</strong><div class="muted">${c.active ?? "?"} active${dlq}</div></div>
            <div class="row">
              <button class="secondary" data-peek-id="${esc(s.id)}" data-dlq="false">Peek</button>
              <button class="secondary" data-peek-id="${esc(s.id)}" data-dlq="true">Peek DLQ</button>
            </div>
          </li>`;
        })
        .join("")
    : `<li class="empty">${env.error ? "" : "No queues or subscriptions found."}</li>`;
}

$("#env-entities").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-peek-id]");
  if (btn) openPeek(btn.dataset.peekId, btn.dataset.dlq === "true");
});

$("#env-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api(`/api/environments/${encodeURIComponent(currentEnv)}/refresh`, { method: "POST" });
    await loadEnvironments();
    await loadEntities();
    renderEnvPanel();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

// Add / edit / remove environments
const envDialog = $("#env-dialog");
const envForm = $("#env-form");
let editingEnv;

function openEnvDialog(env) {
  editingEnv = env;
  envForm.reset();
  $("#env-form-error").textContent = "";
  $("#env-dialog-title").textContent = env ? `Edit ${env.name}` : "Add environment";
  $("#env-submit").textContent = env ? "Save" : "Add";
  $("#env-delete").hidden = !env;
  envForm.elements.name.value = env?.name ?? "";
  const cs = envForm.elements.connectionStrings;
  cs.required = !env;
  if (!cs.dataset.placeholder) cs.dataset.placeholder = cs.placeholder;
  cs.placeholder = env ? "Leave empty to keep the current connection strings. Anything entered here replaces all of them." : cs.dataset.placeholder;
  // Keys are never sent to the browser; show what each existing string is scoped to.
  $("#env-current").hidden = !env;
  $("#env-current-list").innerHTML = (env?.connections ?? [])
    .map((c) => `<li>${c.scope === "namespace" ? "whole namespace" : `<code>${esc(c.scope)}</code>`} · key <code>${esc(c.keyName)}</code></li>`)
    .join("");
  envDialog.showModal();
}

$("#env-edit").addEventListener("click", () => openEnvDialog(activeEnv()));
$("#env-cancel").addEventListener("click", () => envDialog.close());

envForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = JSON.stringify({ name: envForm.elements.name.value, connectionStrings: envForm.elements.connectionStrings.value });
  const submit = $("#env-submit");
  submit.disabled = true;
  $("#env-form-error").textContent = editingEnv ? "Saving…" : "Connecting and listing entities…";
  try {
    const env = editingEnv
      ? await api(`/api/environments/${encodeURIComponent(editingEnv.id)}`, { method: "PATCH", body })
      : await api("/api/environments", { method: "POST", body });
    envDialog.close();
    await loadEnvironments();
    await switchEnv(env.id);
  } catch (err) {
    $("#env-form-error").textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

$("#env-delete").addEventListener("click", async () => {
  if (!confirm(`Remove ${editingEnv.name}? Its connection string is deleted from environments.json.`)) return;
  await api(`/api/environments/${encodeURIComponent(editingEnv.id)}`, { method: "DELETE" });
  envDialog.close();
  await loadEnvironments();
  await switchEnv("local");
});

// ---------- Entities & send form ----------

let entities;
const form = $("#send-form");

async function loadEntities() {
  entities = await api(`/api/entities?${envParam()}`);
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
    const { sent } = await api(`/api/send?${envParam()}`, { method: "POST", body: JSON.stringify(req) });
    status.className = "status ok";
    status.textContent = `Sent ${sent} message(s) to ${req.target} (${activeEnv().name})`;
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
  const env = activeEnv();
  peekState = { id, dlq, env: env.id };
  $("#peek-title").textContent = `${id}${dlq ? " (dead-letter)" : ""}${env.readOnly ? ` · ${env.name}` : ""}`;
  // Real namespaces are read-only (the server refuses purge too).
  $("#peek-purge").hidden = env.readOnly;
  dialog.showModal();
  await refreshPeek();
}

async function refreshPeek() {
  const list = $("#peek-list");
  list.innerHTML = "<li>Loading…</li>";
  try {
    const q = `id=${encodeURIComponent(peekState.id)}&dlq=${peekState.dlq}&${envParam(peekState.env)}`;
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
  const q = `id=${encodeURIComponent(peekState.id)}&dlq=${peekState.dlq}&${envParam(peekState.env)}`;
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
  if (currentEnv === "local") await loadEntities();
  await loadResponders();
});

// ---------- Activity feed ----------

const activityList = $("#activity");
const filterInput = $("#filter");

function activityEl(a) {
  const li = document.createElement("li");
  li.className = `activity ${a.kind}`;
  li.dataset.env = a.env ?? "local";
  li.dataset.search = JSON.stringify(a).toLowerCase();
  const time = new Date(a.time).toLocaleTimeString();
  const summary = `<span class="time">${time}</span><span class="kind">${a.kind}</span><span class="entity">${esc(a.entity)}</span><span class="text">${esc(a.text)}</span>`;
  li.innerHTML = a.message ? `<details><summary>${summary}</summary>${messageHtml(a.message)}</details>` : `<div class="line">${summary}</div>`;
  applyFilter(li);
  return li;
}

/** Shows only the active tab's activity, narrowed by the filter box. */
function applyFilter(li) {
  const q = filterInput.value.trim().toLowerCase();
  li.hidden = li.dataset.env !== currentEnv || (q !== "" && !li.dataset.search.includes(q));
}

function addActivity(a) {
  activityList.prepend(activityEl(a));
  while (activityList.children.length > 500) activityList.lastElementChild.remove();
}

filterInput.addEventListener("input", () => activityList.querySelectorAll("li").forEach(applyFilter));
$("#clear").addEventListener("click", async () => {
  await api(`/api/activity?${envParam()}`, { method: "DELETE" });
  activityList.querySelectorAll(`li[data-env="${CSS.escape(currentEnv)}"]`).forEach((li) => li.remove());
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

try {
  currentEnv = localStorage.getItem(ENV_KEY) ?? "local";
} catch {}
await loadEnvironments();
renderTemplates();
await switchEnv(currentEnv); // loads entities, which responders need for the mode list
await loadResponders();
for (const a of await api("/api/activity")) addActivity(a);
connectEvents();
pollEmulator();
