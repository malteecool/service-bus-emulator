// Editor for the emulator's Config.json. Property forms are generated from the emulator's JSON schema.

const $ = (sel, root = document) => root.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const data = await res.json();
  if (!res.ok && !data.errors) throw new Error(data.error ?? res.statusText);
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const dialog = $("#config-dialog");
const tree = $("#cfg-tree");
const editor = $("#cfg-editor");
const messages = $("#cfg-messages");

let schema;
let saved = ""; // JSON of the config as it is on disk
let draft; // working copy
let selection = { type: "namespace" };
/** Set when a JSON textarea (rules / raw) holds unparseable text; blocks saving. */
let jsonError = "";

// ---------- schema helpers ----------

function schemaParts() {
  const ns = schema.properties.UserConfig.properties.Namespaces.items.properties;
  const topic = ns.Topics.items.properties;
  return {
    queue: ns.Queues.items.properties.Properties.properties,
    topic: topic.Properties.properties,
    subscription: topic.Subscriptions.items.properties.Properties.properties,
    logging: schema.properties.UserConfig.properties.Logging.properties.Type.enum,
  };
}

/** Explicit defaults for a new entity, so the saved file is self-describing like the sample config. */
function defaultProps(defs) {
  const props = {};
  for (const [key, def] of Object.entries(defs)) {
    if (def.default !== undefined) props[key] = def.default;
    else if (key.startsWith("Forward")) props[key] = "";
  }
  return props;
}

const ns = () => draft.UserConfig.Namespaces[0];
const queues = () => (ns().Queues ??= []);
const topics = () => (ns().Topics ??= []);
const entityNames = () => [...queues(), ...topics()].map((e) => e.Name);

function uniqueName(base, existing) {
  let n = 1;
  while (existing.some((x) => x.toLowerCase() === `${base}.${n}`.toLowerCase())) n++;
  return `${base}.${n}`;
}

function selected() {
  const s = selection;
  if (s.type === "queue") return queues()[s.i];
  if (s.type === "topic") return topics()[s.i];
  if (s.type === "sub") return topics()[s.t]?.Subscriptions?.[s.i];
  return undefined;
}

// ---------- tree ----------

function renderTree() {
  const item = (label, sel, extraClass = "") => {
    const active = JSON.stringify(sel) === JSON.stringify(selection) ? " active" : "";
    return `<button class="tree-item ${extraClass}${active}" data-sel='${esc(JSON.stringify(sel))}'>${esc(label)}</button>`;
  };
  let html = item("Namespace & logging", { type: "namespace" });
  html += `<div class="tree-group"><span>Queues (${queues().length})</span><button class="link" data-add="queue">+ add</button></div>`;
  queues().forEach((q, i) => (html += item(q.Name, { type: "queue", i })));
  html += `<div class="tree-group"><span>Topics (${topics().length})</span><button class="link" data-add="topic">+ add</button></div>`;
  topics().forEach((t, ti) => {
    html += item(t.Name, { type: "topic", i: ti });
    (t.Subscriptions ?? []).forEach((s, si) => (html += item(s.Name, { type: "sub", t: ti, i: si }, "sub")));
    html += `<button class="link sub" data-add="sub" data-topic="${ti}">+ subscription</button>`;
  });
  html += `<div class="tree-group"></div>` + item("Raw JSON", { type: "raw" });
  tree.innerHTML = html;
}

tree.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.sel) {
    if (jsonError) return showMessages(); // stay until the JSON is fixed
    selection = JSON.parse(btn.dataset.sel);
  } else if (btn.dataset.add === "queue") {
    queues().push({ Name: uniqueName("queue", entityNames()), Properties: defaultProps(schemaParts().queue) });
    selection = { type: "queue", i: queues().length - 1 };
  } else if (btn.dataset.add === "topic") {
    topics().push({ Name: uniqueName("topic", entityNames()), Properties: defaultProps(schemaParts().topic), Subscriptions: [] });
    selection = { type: "topic", i: topics().length - 1 };
  } else if (btn.dataset.add === "sub") {
    const t = topics()[Number(btn.dataset.topic)];
    const subs = (t.Subscriptions ??= []);
    subs.push({ Name: uniqueName("subscription", subs.map((s) => s.Name)), Properties: defaultProps(schemaParts().subscription) });
    selection = { type: "sub", t: Number(btn.dataset.topic), i: subs.length - 1 };
  }
  render();
  changed();
});

// ---------- editor ----------

function propertyField(key, def, value, entityName) {
  const hint = def.description ? `<small>${esc(def.description)}</small>` : "";
  const placeholder = def.default !== undefined ? `default ${def.default}` : "";
  if (def.type === "boolean") {
    const checked = value ?? def.default ?? false;
    return `<label class="check field" title="${esc(def.description)}"><input type="checkbox" data-prop="${key}" ${checked ? "checked" : ""}> ${key}</label>`;
  }
  if (def.type === "integer") {
    return `<label class="field">${key}<input type="number" data-prop="${key}" min="${def.minimum ?? ""}" max="${def.maximum ?? ""}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}">${hint}</label>`;
  }
  if (key.startsWith("Forward")) {
    const options = entityNames()
      .filter((n) => n !== entityName)
      .map((n) => `<option ${n === value ? "selected" : ""}>${esc(n)}</option>`)
      .join("");
    return `<label class="field">${key}<select data-prop="${key}"><option value="">(none)</option>${options}</select>${hint}</label>`;
  }
  const list = def.examples ? `list="dl-${key}"` : "";
  const datalist = def.examples ? `<datalist id="dl-${key}">${def.examples.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>` : "";
  return `<label class="field">${key}<input data-prop="${key}" ${list} value="${esc(value ?? "")}" placeholder="${esc(placeholder)}">${datalist}${hint}</label>`;
}

const RULES_EXAMPLE = `[
  {
    "Name": "only-orders",
    "Properties": {
      "FilterType": "Correlation",
      "CorrelationFilter": { "Label": "order", "Properties": { "region": "eu" } }
    }
  },
  {
    "Name": "high-priority",
    "Properties": { "FilterType": "Sql", "SqlFilter": { "SqlExpression": "priority > 5" } }
  }
]`;

function renderEditor() {
  const parts = schemaParts();
  const s = selection;

  if (s.type === "namespace") {
    const type = draft.UserConfig.Logging?.Type ?? "File";
    editor.innerHTML = `
      <h3>Namespace</h3>
      <p class="muted">The emulator supports a single namespace, <code>${esc(ns().Name)}</code>. Queues + topics are limited to 50.</p>
      <label class="field">Logging<select id="cfg-logging">${parts.logging.map((t) => `<option ${t === type ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
    $("#cfg-logging").addEventListener("change", (e) => {
      draft.UserConfig.Logging = { Type: e.target.value };
      changed();
    });
    return;
  }

  if (s.type === "raw") {
    editor.innerHTML = `<h3>Raw JSON</h3><textarea id="cfg-raw" class="code" spellcheck="false"></textarea>`;
    const ta = $("#cfg-raw");
    ta.value = JSON.stringify(draft, null, 2);
    ta.addEventListener("input", () => {
      try {
        draft = JSON.parse(ta.value);
        jsonError = "";
        renderTree();
      } catch (err) {
        jsonError = `Raw JSON: ${err.message}`;
      }
      changed();
    });
    return;
  }

  const entity = selected();
  if (!entity) {
    selection = { type: "namespace" };
    return renderEditor();
  }
  const kind = s.type === "sub" ? "subscription" : s.type;
  const defs = parts[kind];
  const title = s.type === "sub" ? `Subscription of ${topics()[s.t].Name}` : kind[0].toUpperCase() + kind.slice(1);
  const props = (entity.Properties ??= {});
  const nameForForward = s.type === "sub" ? topics()[s.t].Name : entity.Name;

  editor.innerHTML = `
    <div class="panel-head"><h3>${esc(title)}</h3><button id="cfg-delete" class="danger">Delete</button></div>
    <label class="field">Name<input id="cfg-name" value="${esc(entity.Name)}" spellcheck="false"></label>
    <div class="cfg-props">${Object.entries(defs).map(([k, d]) => propertyField(k, d, props[k], nameForForward)).join("")}</div>
    ${s.type === "sub" ? `
      <label class="field">Rules (filters) as JSON. No rules means the subscription gets every message.
        <textarea id="cfg-rules" class="code" rows="10" spellcheck="false" placeholder="${esc(RULES_EXAMPLE)}"></textarea>
      </label>` : ""}
    ${s.type === "topic" ? `<p class="muted">${(entity.Subscriptions ?? []).length} subscription(s). Messages sent to a topic without subscriptions are dropped.</p>` : ""}`;

  const nameInput = $("#cfg-name");
  let nameBefore = entity.Name;
  nameInput.addEventListener("input", () => {
    entity.Name = nameInput.value.trim();
    renderTree();
    changed();
  });
  // Once the rename is committed, keep forwards pointing at the renamed queue/topic.
  nameInput.addEventListener("change", () => {
    if (s.type !== "sub") renameForwards(nameBefore, entity.Name);
    nameBefore = entity.Name;
    changed();
  });

  for (const input of editor.querySelectorAll("[data-prop]")) {
    const key = input.dataset.prop;
    const def = defs[key];
    input.addEventListener(input.type === "checkbox" || input.tagName === "SELECT" ? "change" : "input", () => {
      if (input.type === "checkbox") props[key] = input.checked;
      else if (key.startsWith("Forward")) props[key] = input.value;
      else if (input.value === "") delete props[key];
      else props[key] = def.type === "integer" ? Number(input.value) : input.value;
      changed();
    });
  }

  $("#cfg-delete").addEventListener("click", () => {
    if (!confirm(`Delete ${kind} "${entity.Name}"?`)) return;
    if (s.type === "queue") queues().splice(s.i, 1);
    else if (s.type === "topic") topics().splice(s.i, 1);
    else topics()[s.t].Subscriptions.splice(s.i, 1);
    selection = { type: "namespace" };
    render();
    changed();
  });

  const rules = $("#cfg-rules");
  if (rules) {
    rules.value = entity.Rules?.length ? JSON.stringify(entity.Rules, null, 2) : "";
    rules.addEventListener("input", () => {
      const text = rules.value.trim();
      try {
        const parsed = text ? JSON.parse(text) : [];
        if (!Array.isArray(parsed)) throw new Error("must be an array of rules");
        if (parsed.length) entity.Rules = parsed;
        else delete entity.Rules;
        jsonError = "";
      } catch (err) {
        jsonError = `Rules: ${err.message}`;
      }
      changed();
    });
  }
}

function renameForwards(oldName, newName) {
  if (!oldName) return;
  const all = [...queues(), ...topics(), ...topics().flatMap((t) => t.Subscriptions ?? [])];
  for (const e of all) {
    for (const key of ["ForwardTo", "ForwardDeadLetteredMessagesTo"]) {
      if (e.Properties?.[key] === oldName) e.Properties[key] = newName;
    }
  }
}

function render() {
  renderTree();
  renderEditor();
}

// ---------- validation & saving ----------

let validation = { errors: [], warnings: [] };
let validateTimer;

function showMessages(extra = "") {
  const errors = [...(jsonError ? [jsonError] : []), ...validation.errors];
  messages.innerHTML =
    errors.map((m) => `<div class="err">✕ ${esc(m)}</div>`).join("") +
    validation.warnings.map((m) => `<div class="warn">! ${esc(m)}</div>`).join("") +
    extra;
  const dirty = JSON.stringify(draft) !== saved;
  $("#cfg-dirty").hidden = !dirty;
  $("#cfg-save").disabled = !dirty || errors.length > 0;
  $("#cfg-apply").disabled = errors.length > 0;
}

function changed() {
  showMessages();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(async () => {
    if (jsonError) return;
    validation = await api("/api/config/validate", { method: "POST", body: JSON.stringify(draft) });
    showMessages();
  }, 300);
}

async function save(apply) {
  if (apply && !confirm("Recreate the emulator containers with the new config? All messages currently in the emulator will be lost.")) return;
  try {
    const result = await api(`/api/config${apply ? "?apply=true" : ""}`, { method: "PUT", body: JSON.stringify(draft) });
    validation = result;
    if (result.errors.length) return showMessages();
    saved = JSON.stringify(draft);
    showMessages(
      `<div class="ok">✓ Saved. ${apply ? "Recreating the emulator; follow progress in the activity feed." : "The emulator still runs the previous config until you apply it."}</div>`,
    );
    window.dispatchEvent(new CustomEvent("config-saved"));
  } catch (err) {
    showMessages(`<div class="err">✕ ${esc(err.message)}</div>`);
  }
}

async function open() {
  [schema, draft] = await Promise.all([
    schema ? Promise.resolve(schema) : api("/api/config/schema"),
    api("/api/config"),
  ]);
  saved = JSON.stringify(draft);
  jsonError = "";
  validation = { errors: [], warnings: [] };
  if (selection.type !== "raw" && !selected() && selection.type !== "namespace") selection = { type: "namespace" };
  render();
  dialog.showModal();
  changed();
}

function close() {
  if (JSON.stringify(draft) !== saved && !confirm("Discard unsaved config changes?")) return;
  dialog.close();
}

$("#edit-config").addEventListener("click", () => open().catch((err) => alert(err.message)));
$("#cfg-close").addEventListener("click", close);
dialog.addEventListener("cancel", (e) => {
  e.preventDefault();
  close();
});
$("#cfg-discard").addEventListener("click", () => {
  draft = JSON.parse(saved);
  jsonError = "";
  render();
  changed();
});
$("#cfg-save").addEventListener("click", () => save(false));
$("#cfg-apply").addEventListener("click", () => save(true));
