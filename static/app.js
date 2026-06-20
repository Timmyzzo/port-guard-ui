const app = document.getElementById("app");

const REQUIRED_GROUP_ID = "internal";
const themeStorageKey = "portguard.theme.v2";
const navStorageKey = "portguard.nav.v2";
const sidebarStorageKey = "portguard.sidebar.v2";
const columnStorageKey = "portguard.table.columns.v9";

const modeLabels = {
  open: "全网开放",
  whitelist: "策略组放行",
  block_cn: "禁止中国 IP",
  blacklist: "除黑名单外开放",
  closed: "仅本机/隧道",
};

const themeLabels = {
  ocean: "海蓝",
  forest: "松绿",
  sunset: "暖橙",
  dark: "黑暗",
};

let state = {
  authed: false,
  config: null,
  status: null,
  preview: [],
  filterText: "",
  filterManaged: "all",
  nav: localStorage.getItem(navStorageKey) || "ports",
  sidebarCollapsed: localStorage.getItem(sidebarStorageKey) === "1",
  theme: readTheme(),
};

const tableColumns = [
  { key: "ports", label: "端口", width: 76, min: 64 },
  { key: "occupied", label: "是否占用", width: 104, min: 92 },
  { key: "business", label: "占用业务/程序", width: 230, min: 150 },
  { key: "listen", label: "监听位置", width: 210, min: 140 },
  { key: "blacklist", label: "黑名单", width: 116, min: 104 },
  { key: "groups", label: "策略组", width: 340, min: 280 },
  { key: "note", label: "备注", width: 150, min: 110 },
  { key: "advanced", label: "", width: 64, min: 56 },
];

let columnWidths = readColumnWidths();

function uid(prefix = "port") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readTheme() {
  const value = localStorage.getItem(themeStorageKey);
  return Object.prototype.hasOwnProperty.call(themeLabels, value) ? value : "ocean";
}

function setTheme(theme) {
  state.theme = theme;
  localStorage.setItem(themeStorageKey, theme);
  document.documentElement.dataset.theme = theme;
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4300);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `${res.status} ${res.statusText}`);
  }
  return data.data ?? data;
}

function linesToArray(value) {
  return String(value || "")
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function displaySource(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/32$/);
  return match ? match[1] : text;
}

function sourcesToLines(values) {
  return (values || []).map(displaySource).join("\n");
}

function portsToArray(value) {
  return linesToArray(value)
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function formatPorts(ports) {
  return (ports || []).join(",") || "-";
}

function protocolLabel(protocols) {
  return uniq(protocols || []).join("+").toUpperCase() || "TCP";
}

function normalizeGroupId(value, index, seen) {
  let id = String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  if (!id) id = `group-${index + 1}`;
  if (seen.has(id)) id = `${id}-${index + 1}`;
  seen.add(id);
  return id;
}

function defaultGroups(config) {
  return [
    { id: REQUIRED_GROUP_ID, name: "内网 IP", protected: true, sources: config.internal_allow || ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] },
    { id: "personal", name: "个人 IP", protected: false, sources: config.global_allow || [] },
    { id: "car-friends", name: "车友 IP", protected: false, sources: [] },
  ];
}

function ensureConfigShape(config) {
  const cfg = config || {};
  if (!Array.isArray(cfg.rules)) cfg.rules = [];
  cfg.drop_cn_fallback = Boolean(cfg.drop_cn_fallback);
  cfg.block_cn_all_ports = cfg.block_cn_all_ports !== false;

  const incoming = Array.isArray(cfg.source_groups) ? cfg.source_groups : [];
  const merged = new Map(defaultGroups(cfg).map((group) => [group.id, { ...group, sources: [...(group.sources || [])] }]));
  for (const group of incoming) {
    if (!group || typeof group !== "object") continue;
    let id = String(group.id || "").trim();
    const compactName = String(group.name || "").replace(/\s+/g, "").toLowerCase();
    if (id === "former-global" || compactName === "车友ip" || compactName === "车友ip汇集") id = "car-friends";
    if (merged.has(id)) {
      const existing = merged.get(id);
      existing.sources = uniq([...(existing.sources || []), ...((group.sources || []))]);
      if (id !== REQUIRED_GROUP_ID && group.name) existing.name = String(group.name);
      existing.protected = existing.protected || Boolean(group.protected);
    } else {
      merged.set(id || uid("group"), {
        id: id || uid("group"),
        name: String(group.name || "策略组"),
        protected: Boolean(group.protected),
        sources: Array.isArray(group.sources) ? group.sources : [],
      });
    }
  }

  const seen = new Set();
  cfg.source_groups = Array.from(merged.values()).map((group, index) => ({
    id: normalizeGroupId(group.id, index, seen),
    name: group.id === REQUIRED_GROUP_ID ? "内网 IP" : String(group.name || `策略组 ${index + 1}`).trim(),
    protected: Boolean(group.protected) || group.id === REQUIRED_GROUP_ID,
    sources: Array.isArray(group.sources) ? group.sources : [],
  }));

  const groupIds = new Set(cfg.source_groups.map((group) => group.id));
  cfg.rules.forEach((rule) => {
    if (rule.mode === "cf_only") rule.mode = "block_cn";
    if (!Object.prototype.hasOwnProperty.call(modeLabels, rule.mode)) rule.mode = "open";
    if (!Array.isArray(rule.source_groups)) rule.source_groups = [];
    rule.source_groups = rule.source_groups.map((id) => id === "former-global" ? "car-friends" : id);
    rule.source_groups = rule.source_groups.filter((id) => groupIds.has(id));
    if (!rule.source_groups.includes(REQUIRED_GROUP_ID)) rule.source_groups.unshift(REQUIRED_GROUP_ID);
    if (!Array.isArray(rule.blacklist_groups)) rule.blacklist_groups = [];
    rule.blacklist_groups = rule.blacklist_groups.map((id) => id === "former-global" ? "car-friends" : id);
    rule.blacklist_groups = rule.blacklist_groups.filter((id) => groupIds.has(id));
    rule.blacklist_enabled = Boolean(rule.blacklist_enabled);
  });
  delete cfg.global_allow;
  delete cfg.internal_allow;
  delete cfg.global_blacklist;
  return cfg;
}

function readColumnWidths() {
  const defaults = Object.fromEntries(tableColumns.map((column) => [column.key, column.width]));
  try {
    const stored = JSON.parse(localStorage.getItem(columnStorageKey) || "{}");
    for (const column of tableColumns) {
      const value = Number(stored[column.key]);
      if (Number.isFinite(value)) defaults[column.key] = Math.max(column.min, Math.round(value));
    }
  } catch (err) {
    return defaults;
  }
  return defaults;
}

function saveColumnWidths() {
  try {
    localStorage.setItem(columnStorageKey, JSON.stringify(columnWidths));
  } catch (err) {
    return;
  }
}

function tableWidth() {
  return tableColumns.reduce((total, column) => total + (columnWidths[column.key] || column.width), 0);
}

function renderColGroup() {
  return `<colgroup>${tableColumns.map((column) => `<col data-column-key="${escapeHtml(column.key)}" style="width:${columnWidths[column.key] || column.width}px" />`).join("")}</colgroup>`;
}

function renderTableHead() {
  return tableColumns.map((column, index) => `
    <th data-column-key="${escapeHtml(column.key)}" data-column-index="${index}">
      <span>${escapeHtml(column.label)}</span>
      <button class="column-resizer" type="button" aria-label="调整${escapeHtml(column.label || "高级")}列宽"></button>
    </th>
  `).join("");
}

function checkedValues(container) {
  return Array.from(container?.querySelectorAll("input[type='checkbox']:checked") || []).map((input) => input.value);
}

function sourceGroupName(id) {
  return state.config.source_groups.find((group) => group.id === id)?.name || id;
}

function renderSourceGroupChecks(selected, options = {}) {
  const selectedSet = new Set(selected || []);
  if (options.requireInternal) selectedSet.add(REQUIRED_GROUP_ID);
  const inputClass = options.inputClass || "";
  const disabled = Boolean(options.disabled);
  return `
    <div class="source-checks ${disabled ? "disabled" : ""}">
      ${(state.config.source_groups || [])
    .filter((group) => !options.excludeProtected || !group.protected)
    .map((group) => `
        <label class="source-check">
          <input class="${escapeHtml(inputClass)}" type="checkbox" value="${escapeHtml(group.id)}" ${selectedSet.has(group.id) ? "checked" : ""} ${disabled || (options.requireInternal && group.id === REQUIRED_GROUP_ID) ? "disabled" : ""} />
          <span>${escapeHtml(group.name)}</span>
        </label>
      `)
    .join("")}
    </div>
  `;
}

function groupSummary(ids) {
  const values = (ids || []).map(sourceGroupName);
  if (!values.length) return "未选择";
  if (values.length <= 2) return values.join(", ");
  return `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
}

function modeNotice(rule) {
  const mode = rule?.mode || "whitelist";
  if (mode === "whitelist") return "";
  return `<div class="mode-notice">${escapeHtml(modeLabels[mode] || mode)}</div>`;
}

function processNames(processText) {
  const names = [];
  for (const match of String(processText || "").matchAll(/\("([^"]+)"/g)) {
    names.push(match[1]);
  }
  return names;
}

function isPublicLocal(local) {
  const value = String(local || "");
  return value.includes("0.0.0.0:") || value.includes("[::]:") || value.startsWith("*:");
}

async function load() {
  try {
    const data = await api("/api/status");
    state.status = data;
    state.config = ensureConfigShape(data.config);
    state.authed = true;
    await loadPreview();
    render();
  } catch (err) {
    state.authed = false;
    renderLogin(err.message === "unauthorized" ? "" : err.message);
  }
}

async function loadPreview() {
  if (!state.config) return;
  state.preview = await api("/api/preview", {
    method: "POST",
    body: JSON.stringify({ config: state.config }),
  });
}

async function login(password) {
  await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
  await load();
}

function renderLogin(error = "") {
  app.innerHTML = `
    <main class="login">
      <form class="login-box" id="loginForm">
        <h1>Port Guard</h1>
        <p class="muted">默认密码为 admin，登录后请在设置中修改。</p>
        <label>登录密码</label>
        <input id="loginPassword" type="password" autocomplete="current-password" autofocus />
        ${error ? `<p class="error-text">${escapeHtml(error)}</p>` : ""}
        <div class="actions" style="margin-top:14px">
          <button class="primary" type="submit">进入面板</button>
        </div>
      </form>
    </main>
  `;
  document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await login(document.getElementById("loginPassword").value);
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function detectedPortMap() {
  const map = new Map();
  function get(port) {
    if (!map.has(port)) {
      map.set(port, {
        port,
        occupied: false,
        protocols: [],
        locals: [],
        processes: [],
        dockerNames: [],
        dockerTargets: [],
        public: false,
      });
    }
    return map.get(port);
  }

  for (const item of state.status.ports || []) {
    const row = get(Number(item.port));
    row.occupied = true;
    row.protocols.push(String(item.proto || "").startsWith("udp") ? "udp" : "tcp");
    row.locals.push(item.local);
    row.processes.push(...processNames(item.process));
    row.public = row.public || isPublicLocal(item.local);
  }

  for (const item of state.status.docker_mappings || []) {
    const row = get(Number(item.host_port));
    row.occupied = true;
    row.protocols.push(item.proto);
    row.dockerNames.push(item.name);
    row.dockerTargets.push(`${item.host_port}->${item.container_port}/${item.proto}`);
  }

  for (const row of map.values()) {
    row.protocols = uniq(row.protocols);
    row.locals = uniq(row.locals);
    row.processes = uniq(row.processes);
    row.dockerNames = uniq(row.dockerNames);
    row.dockerTargets = uniq(row.dockerTargets);
  }
  return map;
}

function rowModels() {
  const detected = detectedPortMap();
  const rows = [];
  const coveredPorts = new Set();

  state.config.rules.forEach((rule, index) => {
    const ports = rule.ports || [];
    ports.forEach((port) => coveredPorts.add(Number(port)));
    const detectedItems = ports.map((port) => detected.get(Number(port))).filter(Boolean);
    rows.push({
      key: `rule-${rule.id}-${index}`,
      ruleIndex: index,
      rule,
      ports,
      protocols: rule.protocols || [],
      occupied: detectedItems.some((item) => item.occupied),
      public: detectedItems.some((item) => item.public),
      locals: uniq(detectedItems.flatMap((item) => item.locals)),
      processes: uniq(detectedItems.flatMap((item) => item.processes)),
      dockerNames: uniq(detectedItems.flatMap((item) => item.dockerNames)),
      dockerTargets: uniq(detectedItems.flatMap((item) => item.dockerTargets)),
      managed: rule.enabled !== false,
    });
  });

  for (const item of detected.values()) {
    if (coveredPorts.has(Number(item.port))) continue;
    rows.push({
      key: `detected-${item.port}`,
      ruleIndex: -1,
      rule: null,
      ports: [item.port],
      protocols: item.protocols,
      occupied: item.occupied,
      public: item.public,
      locals: item.locals,
      processes: item.processes,
      dockerNames: item.dockerNames,
      dockerTargets: item.dockerTargets,
      managed: false,
    });
  }

  return rows.sort((a, b) => Math.min(...a.ports) - Math.min(...b.ports));
}

function businessText(row) {
  const parts = [];
  if (row.rule?.name) parts.push(row.rule.name);
  if (row.dockerNames.length) parts.push(`Docker: ${row.dockerNames.join(", ")}`);
  if (row.processes.length) parts.push(`进程: ${row.processes.join(", ")}`);
  return uniq(parts).join(" / ") || "未知";
}

function exposureText(row) {
  if (!row.occupied) return "规则存在，未监听";
  if (row.public) return "公网监听";
  return "本机监听";
}

function render() {
  if (!state.authed) {
    renderLogin();
    return;
  }
  setTheme(state.theme);
  app.innerHTML = `
    <main class="shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""}">
      ${renderSidebar()}
      <section class="workspace">
        ${renderTopbar()}
        ${state.nav === "ports" ? renderPortsView() : ""}
        ${state.nav === "groups" ? renderGroupsView() : ""}
        ${state.nav === "settings" ? renderSettingsView() : ""}
        ${state.nav === "backups" ? renderBackupsView() : ""}
      </section>
    </main>
  `;
  bindEvents();
}

function renderSidebar() {
  const items = [
    ["ports", "端", "端口"],
    ["groups", "组", "策略组"],
    ["settings", "设", "设置"],
    ["backups", "回", "回滚"],
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">PG</div>
        <div class="brand-text"><strong>Port Guard</strong><span>访问策略面板</span></div>
      </div>
      <nav class="nav-list">
        ${items.map(([id, icon, label]) => `
          <button class="nav-item ${state.nav === id ? "active" : ""}" data-nav="${id}" title="${escapeHtml(label)}">
            <span class="nav-icon">${escapeHtml(icon)}</span>
            <span class="nav-label">${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </nav>
      <button class="sidebar-toggle" id="sidebarToggle">${state.sidebarCollapsed ? "展开" : "收起"}</button>
    </aside>
  `;
}

function renderTopbar() {
  const chains = state.status.chains;
  const active = chains.input_active && chains.docker_active;
  const server = state.status.server || {};
  const bind = server.bind || "127.0.0.1";
  const port = server.port || 8787;
  const bindText = bind === "127.0.0.1" || bind === "localhost" || bind === "::1"
    ? `服务只监听服务器本机 ${bind}:${port}。`
    : `服务监听 ${bind}:${port}，公网访问由端口策略控制。`;
  return `
    <header class="topbar">
      <div>
        <h1>${state.nav === "ports" ? "端口策略" : state.nav === "groups" ? "策略组" : state.nav === "settings" ? "设置" : "命令预览与回滚"}</h1>
        <p>${escapeHtml(bindText)}</p>
      </div>
      <div class="actions">
        <span class="status-pill ${active ? "ok" : ""}"><span class="dot"></span>${active ? "托管链已启用" : "托管链未启用"}</span>
        <select id="themeSelect" class="theme-select">
          ${Object.entries(themeLabels).map(([value, label]) => `<option value="${value}" ${state.theme === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
        <button id="refreshBtn">刷新</button>
        <button id="saveBtn">保存配置</button>
        <button class="primary" id="applyBtn">应用到防火墙</button>
      </div>
    </header>
  `;
}

function renderPortsView() {
  const rows = rowModels();
  const managedCount = state.config.rules.filter((rule) => rule.enabled).length;
  return `
    <section class="panel">
      <div class="toolbar">
        <div class="search">
          <label>查询端口或业务</label>
          <input id="filterText" value="${escapeHtml(state.filterText)}" placeholder="例如 8443、ssh、new-api、openresty" />
        </div>
        <div>
          <label>托管状态</label>
          <select id="filterManaged">
            <option value="all" ${state.filterManaged === "all" ? "selected" : ""}>全部</option>
            <option value="managed" ${state.filterManaged === "managed" ? "selected" : ""}>已托管</option>
            <option value="unmanaged" ${state.filterManaged === "unmanaged" ? "selected" : ""}>未托管</option>
          </select>
        </div>
        <div class="toolbar-actions">
          <button id="manageAllBtn">托管全部监听</button>
          <button id="addRuleBtn">新增端口</button>
          <button id="updateCnBtn">更新 CN</button>
        </div>
      </div>
      <div class="stats-row">
        <div><strong id="shownCount">${rows.length}</strong><span>当前显示</span></div>
        <div><strong>${managedCount}</strong><span>启用规则</span></div>
        <div><strong>${state.status.ports.length}</strong><span>监听项</span></div>
        <div><strong>${state.status.docker_mappings?.length || 0}</strong><span>Docker 映射</span></div>
      </div>
      <div class="table-wrap">
        <table class="port-table" style="--port-table-width:${tableWidth()}px">
          ${renderColGroup()}
          <thead><tr>${renderTableHead()}</tr></thead>
          <tbody>${rows.map(renderPortRow).join("")}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderPortRow(row) {
  const managed = Boolean(row.managed && row.rule);
  const rule = row.rule || {
    mode: "open",
    source_groups: [REQUIRED_GROUP_ID],
    blacklist_enabled: false,
    blacklist_groups: [],
    note: "",
    scope: row.dockerTargets.length ? "both" : "input",
    docker_ports: [],
  };
  const restrictionEnabled = rule.mode === "whitelist";
  const dockerTargets = row.dockerTargets.length ? row.dockerTargets.join(", ") : "-";
  const listen = row.locals.length ? row.locals.join(", ") : "-";
  const searchText = [
    formatPorts(row.ports),
    rule.name,
    modeLabels[rule.mode] || "",
    groupSummary(rule.source_groups),
    groupSummary(rule.blacklist_groups),
    row.processes.join(" "),
    row.dockerNames.join(" "),
    row.locals.join(" "),
    row.dockerTargets.join(" "),
  ].join(" ").toLowerCase();
  return `
    <tr class="${managed ? "managed" : "unmanaged"}" data-rule-index="${row.ruleIndex}" data-ports="${escapeHtml(row.ports.join(","))}" data-protocols="${escapeHtml(row.protocols.join(","))}" data-docker-targets="${escapeHtml(row.dockerTargets.join(","))}" data-search="${escapeHtml(searchText)}" data-managed="${managed ? "managed" : "unmanaged"}">
      <td class="port-cell"><strong>${escapeHtml(formatPorts(row.ports))}</strong><span>${escapeHtml(protocolLabel(row.protocols))}</span></td>
      <td><span class="badge ${row.occupied ? "ok" : "warn"}">${escapeHtml(exposureText(row))}</span></td>
      <td class="business-cell">${escapeHtml(businessText(row))}</td>
      <td class="listen-cell"><div>${escapeHtml(listen)}</div><span>Docker: ${escapeHtml(dockerTargets)}</span></td>
      <td class="blacklist-cell">
        ${managed ? `
          <label class="mini-check"><input class="row-blacklist-enabled" type="checkbox" ${rule.blacklist_enabled ? "checked" : ""} /> 启用</label>
          ${rule.blacklist_enabled ? `
            <div class="row-blacklist-groups">
              ${renderSourceGroupChecks(rule.blacklist_groups, { inputClass: "row-blacklist-group" })}
            </div>
          ` : ""}
        ` : `<span class="muted">未托管</span>`}
      </td>
      <td>
        ${managed ? `
          <label class="mini-check restriction-check"><input class="row-restrict-enabled" type="checkbox" ${restrictionEnabled ? "checked" : ""} /> 启用限制</label>
          <div class="row-source-groups">
            ${renderSourceGroupChecks(rule.source_groups, { inputClass: "row-source-group", requireInternal: true })}
          </div>
          <div class="policy-help">${restrictionEnabled ? "当前只允许勾选的策略组访问。" : "当前全网开放；开启限制后只允许勾选组。"}</div>
        ` : `
          <button class="manage-row" type="button">托管此端口</button>
          <div class="policy-help">托管后默认全网开放。</div>
        `}
      </td>
      <td>${managed ? `<input class="row-note" value="${escapeHtml(rule.note || "")}" placeholder="备注" />` : `<span class="muted">未托管</span>`}</td>
      <td>
        ${managed ? `
          <details class="row-advanced">
            <summary>高级</summary>
            <label>保护位置</label>
            <select class="row-scope">
              <option value="both" ${rule.scope === "both" ? "selected" : ""}>自动保护</option>
              <option value="input" ${rule.scope === "input" ? "selected" : ""}>主机服务</option>
              <option value="docker" ${rule.scope === "docker" ? "selected" : ""}>Docker 服务</option>
            </select>
            <label>Docker 目标端口</label>
            <input class="row-docker-ports" value="${escapeHtml((rule.docker_ports || []).join(","))}" placeholder="${escapeHtml(row.dockerTargets.map((x) => x.split("->")[1]?.split("/")[0]).filter(Boolean).join(","))}" />
          </details>
        ` : `<button class="manage-row compact" type="button">托管</button>`}
      </td>
    </tr>
  `;
}

function renderGroupsView() {
  return `
    <section class="panel">
      <div class="section-title">
        <div><strong>策略组</strong><p class="muted">端口只通过策略组选择来源。内网 IP 是系统必需组，不能删除。</p></div>
        <div class="actions group-actions">
          <button id="addSourceGroupBtn" type="button">新增策略组</button>
          <button id="saveGroupsBtn" type="button">保存配置</button>
          <button class="primary" id="applyGroupsBtn" type="button">保存并应用</button>
        </div>
      </div>
      <div class="source-group-list">${state.config.source_groups.map(renderSourceGroup).join("")}</div>
    </section>
  `;
}

function renderSourceGroup(group, index) {
  return `
    <div class="source-group ${group.protected ? "locked" : ""}" data-group-index="${index}">
      <div>
        <label>组名</label>
        <input class="group-name" value="${escapeHtml(group.name)}" ${group.protected ? "disabled" : ""} />
      </div>
      <div>
        <label>IP/CIDR</label>
        <textarea class="group-sources" spellcheck="false">${escapeHtml(sourcesToLines(group.sources))}</textarea>
      </div>
      <button class="danger delete-source-group" type="button" data-group-index="${index}" ${group.protected ? "disabled" : ""}>删除</button>
    </div>
  `;
}

function renderSettingsView() {
  const cfg = state.config;
  return `
    <section class="panel settings-panel">
      <div class="settings-topline">
        <label class="check-row strong-check"><input id="blockCnAllPorts" type="checkbox" ${cfg.block_cn_all_ports ? "checked" : ""} /> 一键禁止 CN 直连所有端口</label>
        <button class="danger" id="clearRestrictionsBtn" type="button">清空所有限制</button>
      </div>
      <p class="muted">启用 CN 总开关后，除 SSH 安全端口外，Port Guard 链会优先丢弃中国大陆来源 IP。</p>
    </section>
    <section class="panel settings-panel">
      <div class="settings-grid compact-settings">
        <div>
          <label>中国 IP 集合</label>
          <input id="cnSet" value="${escapeHtml(cfg.cn_set)}" />
        </div>
        <label class="check-row"><input id="persist" type="checkbox" ${cfg.persist ? "checked" : ""} /> 保存为开机规则</label>
        <label class="check-row"><input id="dropCnFallback" type="checkbox" ${cfg.drop_cn_fallback ? "checked" : ""} /> 未匹配来源兜底禁止 CN</label>
      </div>
    </section>
    <section class="panel settings-panel">
      <div class="section-title">
        <div><strong>登录密码</strong><p class="muted">用于公网访问面板的管理密码。</p></div>
      </div>
      <div class="password-grid">
        <div>
          <label>当前密码</label>
          <input id="currentPassword" type="password" autocomplete="current-password" />
        </div>
        <div>
          <label>新密码</label>
          <input id="newPassword" type="password" autocomplete="new-password" />
        </div>
        <div>
          <label>确认新密码</label>
          <input id="confirmPassword" type="password" autocomplete="new-password" />
        </div>
        <button class="primary" id="changePasswordBtn" type="button">修改密码</button>
      </div>
    </section>
  `;
}

function renderBackupsView() {
  return `
    <section class="panel">
      <div class="split">
        <div>
          <div class="actions panel-actions"><button id="previewBtn">刷新预览</button><button id="backupBtn">创建备份</button></div>
          <pre>${escapeHtml((state.preview || []).join("\n"))}</pre>
        </div>
        <div>
          <h3>回滚点</h3>
          <div class="backup-list">${renderBackups()}</div>
        </div>
      </div>
    </section>
  `;
}

function renderBackups() {
  if (!state.status.backups.length) return `<span class="muted">暂无回滚点</span>`;
  return state.status.backups
    .map((item) => `
      <div class="backup-item">
        <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <small>${Math.max(1, Math.round((item.size || 0) / 1024))} KB</small>
        <button class="restore" data-name="${escapeHtml(item.name)}">回滚</button>
        <button class="danger delete-backup" data-name="${escapeHtml(item.name)}">删除</button>
      </div>
    `)
    .join("");
}

function syncSettingsFromDom() {
  const cnSet = document.getElementById("cnSet");
  if (cnSet) state.config.cn_set = cnSet.value.trim() || "cnblock";
  const persist = document.getElementById("persist");
  if (persist) state.config.persist = Boolean(persist.checked);
  const dropCnFallback = document.getElementById("dropCnFallback");
  if (dropCnFallback) state.config.drop_cn_fallback = Boolean(dropCnFallback.checked);
  const blockCnAllPorts = document.getElementById("blockCnAllPorts");
  if (blockCnAllPorts) state.config.block_cn_all_ports = Boolean(blockCnAllPorts.checked);

  const groupEls = document.querySelectorAll(".source-group");
  if (groupEls.length) {
    state.config.source_groups = Array.from(groupEls).map((groupEl, index) => {
      const existing = state.config.source_groups?.[Number(groupEl.dataset.groupIndex)] || {};
      return {
        id: existing.id || uid("group"),
        name: existing.protected ? existing.name : groupEl.querySelector(".group-name")?.value.trim() || `策略组 ${index + 1}`,
        protected: Boolean(existing.protected),
        sources: linesToArray(groupEl.querySelector(".group-sources")?.value || ""),
      };
    });
  }
}

function createRuleFromRow(row, options = {}) {
  const ports = portsToArray(row.dataset.ports);
  const protocols = linesToArray(row.dataset.protocols);
  const dockerTargets = linesToArray(row.dataset.dockerTargets);
  const dockerPorts = dockerTargets
    .map((item) => Number(item.split("->")[1]?.split("/")[0]))
    .filter(Boolean);
  const name = row.querySelector(".business-cell")?.textContent.trim() || `Port ${ports.join(",")}`;
  const rule = {
    id: uid(),
    name: name.slice(0, 90),
    enabled: true,
    scope: dockerTargets.length ? "both" : "input",
    protocols: protocols.length ? protocols : ["tcp"],
    ports,
    docker_ports: dockerPorts,
    mode: options.mode || "open",
    source_groups: options.source_groups || [REQUIRED_GROUP_ID],
    blacklist_enabled: false,
    blacklist_groups: [],
    note: options.note || "",
  };
  state.config.rules.push(rule);
  row.dataset.ruleIndex = String(state.config.rules.length - 1);
  return rule;
}

function manageAllDetectedRows() {
  syncRowsFromDom();
  const rows = Array.from(document.querySelectorAll(".port-table tbody tr"))
    .filter((row) => row.dataset.managed !== "managed");
  for (const row of rows) {
    row.dataset.managed = "managed";
    createRuleFromRow(row, { mode: "open" });
  }
  toast(rows.length ? `已托管 ${rows.length} 个监听端口，默认全网开放。` : "没有未托管的监听端口。");
  render();
}

function syncRowsFromDom() {
  syncSettingsFromDom();
  document.querySelectorAll(".port-table tbody tr").forEach((row) => {
    let index = Number(row.dataset.ruleIndex);
    let rule = index >= 0 ? state.config.rules[index] : null;
    if (row.dataset.managed !== "managed") return;
    if (!rule) {
      rule = createRuleFromRow(row);
      index = Number(row.dataset.ruleIndex);
    }
    rule.enabled = true;
    if (!Object.prototype.hasOwnProperty.call(modeLabels, rule.mode)) rule.mode = "open";
    rule.blacklist_enabled = Boolean(row.querySelector(".row-blacklist-enabled")?.checked);
    rule.blacklist_groups = checkedValues(row.querySelector(".row-blacklist-groups"));
    const sourceGroupChecks = row.querySelector(".row-source-groups");
    if (sourceGroupChecks) {
      const selectedGroups = checkedValues(sourceGroupChecks);
      if (!selectedGroups.includes(REQUIRED_GROUP_ID)) selectedGroups.unshift(REQUIRED_GROUP_ID);
      rule.source_groups = selectedGroups;
      rule.mode = row.querySelector(".row-restrict-enabled")?.checked ? "whitelist" : "open";
    }
    rule.note = row.querySelector(".row-note")?.value.trim() || "";
    rule.scope = row.querySelector(".row-scope")?.value || "both";
    const dockerPorts = portsToArray(row.querySelector(".row-docker-ports")?.value || "");
    rule.docker_ports = dockerPorts;
  });
}

function applyClientFilters() {
  const text = (document.getElementById("filterText")?.value || "").trim().toLowerCase();
  const managed = document.getElementById("filterManaged")?.value || "all";
  state.filterText = text;
  state.filterManaged = managed;
  let shown = 0;
  document.querySelectorAll(".port-table tbody tr").forEach((row) => {
    const queryOk = !text || row.dataset.search.includes(text);
    const managedOk = managed === "all" || row.dataset.managed === managed;
    const ok = queryOk && managedOk;
    row.hidden = !ok;
    if (ok) shown += 1;
  });
  const shownEl = document.getElementById("shownCount");
  if (shownEl) shownEl.textContent = String(shown);
}

function initColumnResizers() {
  const table = document.querySelector(".port-table");
  if (!table) return;
  table.style.setProperty("--port-table-width", `${tableWidth()}px`);
  const cols = Array.from(table.querySelectorAll("col"));
  cols.forEach((col, index) => {
    const column = tableColumns[index];
    if (column) col.style.width = `${columnWidths[column.key] || column.width}px`;
  });
  table.querySelectorAll(".column-resizer").forEach((handle) => {
    const startResize = (event) => {
      if (event.type === "mousedown" && event.button !== 0) return;
      if (handle.dataset.resizing === "1") return;
      const th = handle.closest("th");
      const index = Number(th?.dataset.columnIndex);
      const column = tableColumns[index];
      const col = cols[index];
      if (!column || !col) return;
      event.preventDefault();
      handle.dataset.resizing = "1";
      const startX = event.clientX;
      const startWidth = Number(columnWidths[column.key]) || col.getBoundingClientRect().width || column.width;
      const moveEventName = event.type === "mousedown" ? "mousemove" : "pointermove";
      const upEventName = event.type === "mousedown" ? "mouseup" : "pointerup";
      const move = (moveEvent) => {
        const width = Math.max(column.min, Math.round(startWidth + moveEvent.clientX - startX));
        columnWidths[column.key] = width;
        col.style.width = `${width}px`;
        table.style.setProperty("--port-table-width", `${tableWidth()}px`);
      };
      const stop = () => {
        delete handle.dataset.resizing;
        document.body.classList.remove("resizing-columns");
        document.removeEventListener(moveEventName, move);
        saveColumnWidths();
      };
      document.body.classList.add("resizing-columns");
      if (event.type !== "mousedown") handle.setPointerCapture?.(event.pointerId);
      document.addEventListener(moveEventName, move);
      document.addEventListener(upEventName, stop, { once: true });
    };
    handle.onpointerdown = startResize;
    handle.onmousedown = startResize;
  });
}

function bindEvents() {
  initColumnResizers();

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.onclick = () => {
      syncRowsFromDom();
      state.nav = button.dataset.nav;
      localStorage.setItem(navStorageKey, state.nav);
      render();
    };
  });
  document.getElementById("sidebarToggle").onclick = () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem(sidebarStorageKey, state.sidebarCollapsed ? "1" : "0");
    render();
  };
  document.getElementById("themeSelect").onchange = (event) => {
    setTheme(event.target.value);
    render();
  };
  document.getElementById("refreshBtn").onclick = () => load();
  document.getElementById("saveBtn").onclick = saveConfig;
  document.getElementById("applyBtn").onclick = applyFirewall;

  document.getElementById("filterText")?.addEventListener("input", applyClientFilters);
  document.getElementById("filterManaged")?.addEventListener("change", applyClientFilters);
  document.getElementById("manageAllBtn")?.addEventListener("click", manageAllDetectedRows);
  document.getElementById("addRuleBtn")?.addEventListener("click", () => {
    syncRowsFromDom();
    const port = prompt("输入端口号，例如 8443");
    if (!port) return;
    state.config.rules.push({
      id: uid(),
      name: `Port ${port}`,
      enabled: true,
      scope: "both",
      protocols: ["tcp"],
      ports: portsToArray(port),
      docker_ports: [],
      mode: "open",
      source_groups: [REQUIRED_GROUP_ID],
      blacklist_enabled: false,
      blacklist_groups: [],
      note: "",
    });
    render();
  });
  document.getElementById("updateCnBtn")?.addEventListener("click", updateCn);
  document.getElementById("clearRestrictionsBtn")?.addEventListener("click", clearRestrictions);
  document.getElementById("changePasswordBtn")?.addEventListener("click", changePassword);
  document.getElementById("saveGroupsBtn")?.addEventListener("click", saveConfig);
  document.getElementById("applyGroupsBtn")?.addEventListener("click", applyFirewall);
  document.getElementById("addSourceGroupBtn")?.addEventListener("click", () => {
    syncRowsFromDom();
    state.config.source_groups.push({ id: uid("group"), name: "新策略组", protected: false, sources: [] });
    render();
  });
  document.querySelectorAll(".delete-source-group").forEach((button) => {
    button.onclick = () => {
      syncRowsFromDom();
      const index = Number(button.dataset.groupIndex);
      const group = state.config.source_groups[index];
      if (!group || group.protected) return;
      state.config.source_groups.splice(index, 1);
      state.config.rules.forEach((rule) => {
        rule.source_groups = (rule.source_groups || []).filter((id) => id !== group.id);
        rule.blacklist_groups = (rule.blacklist_groups || []).filter((id) => id !== group.id);
        if (!rule.source_groups.includes(REQUIRED_GROUP_ID)) rule.source_groups.unshift(REQUIRED_GROUP_ID);
      });
      render();
    };
  });
  document.querySelectorAll(".manage-row").forEach((button) => {
    button.onclick = () => {
      syncRowsFromDom();
      const row = button.closest("tr");
      const index = Number(row.dataset.ruleIndex);
      if (index >= 0 && state.config.rules[index]) {
        state.config.rules[index].enabled = true;
        state.config.rules[index].mode = "open";
      } else {
        createRuleFromRow(row, { mode: "open" });
      }
      render();
    };
  });
  document.querySelectorAll(".row-blacklist-enabled").forEach((checkbox) => {
    checkbox.onchange = () => {
      syncRowsFromDom();
      render();
    };
  });
  document.getElementById("previewBtn")?.addEventListener("click", async () => {
    try {
      syncRowsFromDom();
      await loadPreview();
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  document.getElementById("backupBtn")?.addEventListener("click", createBackup);
  document.querySelectorAll(".restore").forEach((button) => {
    button.onclick = async () => {
      try {
        const name = button.dataset.name;
        if (!confirm(`确认回滚到 ${name}？`)) return;
        await api("/api/restore", { method: "POST", body: JSON.stringify({ name }) });
        toast(`已回滚 ${name}`);
        await load();
      } catch (err) {
        toast(err.message);
      }
    };
  });
  document.querySelectorAll(".delete-backup").forEach((button) => {
    button.onclick = async () => {
      try {
        const name = button.dataset.name;
        if (!confirm(`确认删除备份 ${name}？`)) return;
        const data = await api("/api/delete-backup", { method: "POST", body: JSON.stringify({ name }) });
        state.status.backups = data.backups;
        toast(`已删除 ${name}`);
        render();
      } catch (err) {
        toast(err.message);
      }
    };
  });
  applyClientFilters();
}

async function saveConfig() {
  try {
    syncRowsFromDom();
    state.config = ensureConfigShape(await api("/api/config", { method: "POST", body: JSON.stringify({ config: state.config }) }));
    await loadPreview();
    toast("配置已保存，尚未写入防火墙。");
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function applyFirewall() {
  try {
    syncRowsFromDom();
    if (!confirm("确认保存当前配置并写入 iptables？系统会先自动创建回滚点。")) return;
    const data = await api("/api/apply", { method: "POST", body: JSON.stringify({ config: state.config }) });
    toast(`已应用，回滚点 ${data.backup}`);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

async function clearRestrictions() {
  try {
    syncRowsFromDom();
    const first = confirm("确认清空所有限制？这会关闭策略组限制、黑名单、CN 兜底和 CN 总开关。");
    if (!first) return;
    const second = confirm("再次确认：清空后会立即应用到防火墙，所有托管端口将全网开放。");
    if (!second) return;
    const data = await api("/api/clear-restrictions", { method: "POST", body: JSON.stringify({ config: state.config }) });
    state.config = ensureConfigShape(data.config);
    toast(`已清空所有限制，回滚点 ${data.result.backup}`);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

async function changePassword() {
  try {
    const current = document.getElementById("currentPassword")?.value || "";
    const next = document.getElementById("newPassword")?.value || "";
    const confirm = document.getElementById("confirmPassword")?.value || "";
    if (next !== confirm) {
      toast("两次输入的新密码不一致。");
      return;
    }
    if (next.length < 4) {
      toast("新密码至少需要 4 个字符。");
      return;
    }
    await api("/api/password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    });
    ["currentPassword", "newPassword", "confirmPassword"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    toast("登录密码已修改。");
  } catch (err) {
    toast(err.message);
  }
}

async function createBackup() {
  try {
    const data = await api("/api/backup", { method: "POST", body: "{}" });
    state.status.backups = data.backups;
    toast(`已创建回滚点 ${data.backup}`);
    render();
  } catch (err) {
    toast(err.message);
  }
}

async function updateCn() {
  try {
    if (!confirm("确认更新中国 IP 库？")) return;
    const data = await api("/api/update-cn", { method: "POST", body: "{}" });
    toast(`CN 库已更新：${data.entries} 条`);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

setTheme(state.theme);
load();
