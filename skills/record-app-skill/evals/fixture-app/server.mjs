#!/usr/bin/env node
/**
 * Deterministic fixture application for record-app-skill tests and evaluations.
 *
 * Zero dependencies, in-memory state, no external network calls. It deliberately
 * contains the situations the skill must handle honestly:
 *
 *   /                       home + navigation
 *   /tasks                  task list, create via modal, client-side validation
 *   /projects               create project (longer multi-step sequence)
 *   /projects/:id           project dashboard (result of a multi-step workflow)
 *   /signin                 synthetic test-only sign-in (sets a cookie)
 *   /private                protected route; 401 without the cookie
 *   /broken                 500 error, for failure-path tests
 *   /slow                   responds after a delay, for wait tests
 *   POST /__reset           clears state between tests
 *
 * Everything here is synthetic test data. There are no real users, emails or
 * payments anywhere in this application.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i !== -1 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return Number(process.env.PORT ?? 4319);
})();

const AUTH_COOKIE = "awd_fixture_auth";
const AUTH_VALUE = "granted";
const TEST_EMAIL = "demo@example.test";
const TEST_PASSWORD = "fixture-password";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function seed() {
  return {
    tasks: [
      { id: randomUUID(), title: "Review the design doc", priority: "normal", done: false, createdAt: Date.now() - 90000 },
      { id: randomUUID(), title: "Draft the release notes", priority: "low", done: true, createdAt: Date.now() - 40000 },
    ],
    projects: [],
  };
}

let state = seed();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function layout({ title, body, nav = true, user = null }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Fixture App</title>
<style>
  :root { --fg:#12151c; --muted:#5b6472; --line:#e3e6ec; --accent:#2f6df6; --ok:#0f8a4a; --err:#c0392b; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--fg); background:#f7f8fb; }
  header { background:#fff; border-bottom:1px solid var(--line); }
  .wrap { max-width:980px; margin:0 auto; padding:18px 24px; }
  header .wrap { display:flex; align-items:center; gap:22px; }
  .brand { font-weight:700; letter-spacing:-.01em; }
  nav a { color:var(--muted); text-decoration:none; margin-right:16px; }
  nav a:hover, nav a[aria-current="page"] { color:var(--fg); }
  main { padding-bottom:60px; }
  h1 { font-size:24px; letter-spacing:-.02em; margin:26px 0 14px; }
  h2 { font-size:17px; margin:22px 0 10px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:10px; padding:20px; margin:14px 0; }
  .muted { color:var(--muted); }
  button, .btn { font:inherit; border-radius:8px; border:1px solid var(--line); background:#fff; padding:8px 14px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  button.danger { color:var(--err); }
  button[disabled] { opacity:.55; cursor:not-allowed; }
  input, select, textarea { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; width:100%; background:#fff; }
  label { display:block; font-weight:600; font-size:13px; margin-bottom:5px; }
  .field { margin-bottom:14px; }
  ul.items { list-style:none; padding:0; margin:0; }
  ul.items li { display:flex; align-items:center; gap:12px; padding:11px 0; border-bottom:1px solid var(--line); }
  ul.items li:last-child { border-bottom:0; }
  .pill { font-size:12px; padding:2px 9px; border-radius:999px; background:#eef1f6; color:var(--muted); }
  .pill.ok { background:#e7f6ee; color:var(--ok); }
  .error { color:var(--err); font-size:13px; margin-top:6px; }
  .banner { padding:11px 14px; border-radius:8px; margin:14px 0; }
  .banner.ok { background:#e7f6ee; color:var(--ok); border:1px solid #bfe6d2; }
  .banner.err { background:#fdecea; color:var(--err); border:1px solid #f5c6c2; }
  dialog { border:0; border-radius:12px; padding:0; width:min(460px,92vw); box-shadow:0 20px 60px rgba(12,20,40,.28); }
  dialog::backdrop { background:rgba(14,20,34,.42); }
  dialog .dialog-body { padding:22px; }
  .row { display:flex; gap:12px; align-items:center; }
  .actions { display:flex; gap:10px; justify-content:flex-end; margin-top:6px; }
  [hidden] { display:none !important; }
</style>
</head>
<body>
<header><div class="wrap">
  <span class="brand">Fixture App</span>
  ${
    nav
      ? `<nav aria-label="Main">
    <a href="/">Home</a>
    <a href="/tasks">Tasks</a>
    <a href="/projects">Projects</a>
    <a href="/private">Private</a>
  </nav>`
      : ""
  }
  <span style="flex:1"></span>
  ${user ? `<span class="muted" data-testid="current-user">${esc(user)}</span>` : ""}
</div></header>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  return parseCookies(req)[AUTH_COOKIE] === AUTH_VALUE;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) {
    try {
      return JSON.parse(text || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function tasksView({ flash = null } = {}) {
  const rows = state.tasks
    .map(
      (t) => `<li data-testid="task-row">
      <span role="status" aria-label="${t.done ? "Completed" : "Open"}" class="pill ${t.done ? "ok" : ""}">${t.done ? "Done" : "Open"}</span>
      <span data-testid="task-title">${esc(t.title)}</span>
    </li>`
    )
    .join("\n");

  return layout({
    title: "Tasks",
    body: `
  <h1>Tasks</h1>
  <p class="muted">A small task list. Create a task to see the workflow end to end.</p>
  ${flash ? `<div class="banner ok" role="status" data-testid="flash">${esc(flash)}</div>` : ""}
  <div class="card">
    <div class="row">
      <h2 style="margin:0;flex:1">Task list</h2>
      <button class="primary" data-testid="open-create" data-action="open-create">Add task</button>
    </div>
    <ul class="items" data-testid="task-list">
${rows}
    </ul>
    <p class="muted" data-testid="empty-state" ${state.tasks.length ? "hidden" : ""}>No tasks yet.</p>
  </div>

  <dialog id="create-dialog" aria-labelledby="create-title">
    <form method="dialog" class="dialog-body" data-testid="create-form" novalidate>
      <h2 id="create-title" style="margin-top:0">New task</h2>
      <div class="field">
        <label for="task-title-input">Task name</label>
        <input id="task-title-input" name="title" placeholder="e.g. Write the recording skill" required maxlength="80" autocomplete="off">
        <p class="error" data-testid="title-error" role="alert" hidden></p>
      </div>
      <div class="field">
        <label for="task-priority">Priority</label>
        <select id="task-priority" name="priority">
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="low">Low</option>
        </select>
      </div>
      <div class="actions">
        <button type="button" data-testid="cancel-create" data-action="cancel">Cancel</button>
        <button type="submit" class="primary" data-testid="submit-create" data-action="submit">Create task</button>
      </div>
    </form>
  </dialog>

  <script>
  (function () {
    const dialog = document.getElementById('create-dialog');
    const form = dialog.querySelector('form');
    const input = document.getElementById('task-title-input');
    const error = dialog.querySelector('[data-testid="title-error"]');
    const list = document.querySelector('[data-testid="task-list"]');
    const empty = document.querySelector('[data-testid="empty-state"]');

    document.querySelectorAll('[data-action="open-create"]').forEach((b) =>
      b.addEventListener('click', () => {
        error.hidden = true;
        dialog.showModal();
        input.focus();
      })
    );
    dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => dialog.close());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) {
        error.textContent = 'A task name is required.';
        error.hidden = false;
        return;
      }
      if (title.length < 3) {
        error.textContent = 'Use at least 3 characters.';
        error.hidden = false;
        return;
      }
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, priority: document.getElementById('task-priority').value }),
      });
      const data = await res.json();
      if (!res.ok) {
        error.textContent = data.error || 'Could not create the task.';
        error.hidden = false;
        return;
      }
      const li = document.createElement('li');
      li.setAttribute('data-testid', 'task-row');
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-label', 'Open');
      pill.textContent = 'Open';
      const name = document.createElement('span');
      name.setAttribute('data-testid', 'task-title');
      name.textContent = data.task.title;
      li.append(pill, name);
      list.appendChild(li);
      if (empty) empty.hidden = true;
      input.value = '';
      dialog.close();
      // Replace any previous banner rather than stacking them: two elements
      // with the same test id would make every later selector ambiguous.
      document.querySelectorAll('[data-testid="flash"]').forEach((el) => el.remove());
      const flash = document.createElement('div');
      flash.className = 'banner ok';
      flash.setAttribute('role', 'status');
      flash.setAttribute('data-testid', 'flash');
      flash.textContent = 'Created "' + data.task.title + '"';
      document.querySelector('h1').after(flash);
    });
  })();
  </script>`,
  });
}

function projectDashboard(project) {
  return layout({
    title: project.name,
    body: `
  <p class="muted"><a href="/projects">← All projects</a></p>
  <h1 data-testid="project-name">${esc(project.name)}</h1>
  <div class="banner ok" role="status" data-testid="project-created">Project created successfully</div>
  <div class="card">
    <h2 style="margin-top:0">Overview</h2>
    <ul class="items">
      <li><span class="muted" style="width:120px">Owner</span><span data-testid="project-owner">${esc(project.owner)}</span></li>
      <li><span class="muted" style="width:120px">Priority</span><span class="pill" data-testid="project-priority">${esc(project.priority)}</span></li>
      <li><span class="muted" style="width:120px">Description</span><span data-testid="project-description">${esc(project.description || "—")}</span></li>
      <li><span class="muted" style="width:120px">Status</span><span class="pill ok" data-testid="project-status">Active</span></li>
    </ul>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Activity</h2>
    <p class="muted" data-testid="project-activity">Project created just now.</p>
  </div>
  <div class="card" data-testid="danger-zone">
    <h2 style="margin-top:0">Danger zone</h2>
    <p class="muted">Deleting a project removes it for everyone. This is the fixture's
      deliberately consequential action, used to test the authorization gate.</p>
    <form action="/projects/${esc(project.id)}/delete" method="post">
      <button type="submit" data-testid="delete-project">Delete project</button>
    </form>
  </div>`,
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const routes = {
  "GET /": (req, res) =>
    send(
      res,
      200,
      layout({
        title: "Home",
        body: `
  <h1>Fixture App</h1>
  <p class="muted">A deterministic application used to test recording and verification.</p>
  <div class="card">
    <h2 style="margin-top:0">What you can do</h2>
    <ul class="items">
      <li><a href="/tasks">Create a task</a> — a short workflow with a modal and validation.</li>
      <li><a href="/projects">Create a project</a> — a longer multi-step workflow ending on a dashboard.</li>
      <li><a href="/private">Private area</a> — requires sign-in.</li>
    </ul>
  </div>`
      })
    ),

  "GET /tasks": (req, res) => {
    const url = new URL(req.url, "http://localhost");
    send(res, 200, tasksView({ flash: url.searchParams.get("created") }));
  },

  "GET /projects": (req, res) => {
    const rows = state.projects
      .map(
        (p) =>
          `<li data-testid="project-row"><a href="/projects/${p.id}" data-testid="project-link">${esc(p.name)}</a><span class="pill">${esc(p.priority)}</span></li>`
      )
      .join("\n");
    send(
      res,
      200,
      layout({
        title: "Projects",
        body: `
  <h1>Projects</h1>
  <div class="card">
    <h2 style="margin-top:0">New project</h2>
    <form action="/projects" method="post" data-testid="project-form">
      <div class="field">
        <label for="project-name">Project name</label>
        <input id="project-name" name="name" required minlength="2" maxlength="60" autocomplete="off">
      </div>
      <div class="field">
        <label for="project-owner">Owner</label>
        <input id="project-owner" name="owner" required autocomplete="off">
      </div>
      <div class="field">
        <label for="project-priority">Priority</label>
        <select id="project-priority" name="priority">
          <option value="Normal">Normal</option>
          <option value="High">High</option>
          <option value="Low">Low</option>
        </select>
      </div>
      <div class="field">
        <label for="project-description">Description</label>
        <textarea id="project-description" name="description" rows="3"></textarea>
      </div>
      <button type="submit" class="primary" data-testid="create-project">Create project</button>
    </form>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Existing projects</h2>
    <ul class="items" data-testid="project-list">
${rows}
    </ul>
    <p class="muted" data-testid="projects-empty" ${state.projects.length ? "hidden" : ""}>No projects yet.</p>
  </div>`
      })
    );
  },

  "POST /projects": async (req, res) => {
    const body = await readBody(req);
    const name = String(body.name ?? "").trim();
    const owner = String(body.owner ?? "").trim();
    if (!name || !owner) {
      send(res, 422, layout({ title: "Invalid project", body: `<div class="banner err" role="alert">Name and owner are required.</div>` }));
      return;
    }
    const project = {
      id: randomUUID().slice(0, 8),
      name,
      owner,
      priority: String(body.priority ?? "Normal"),
      description: String(body.description ?? "").trim(),
      createdAt: Date.now(),
    };
    state.projects.push(project);
    res.writeHead(303, { location: `/projects/${project.id}` });
    res.end();
  },

  "GET /signin": (req, res) =>
    send(
      res,
      200,
      layout({
        title: "Sign in",
        nav: false,
        body: `
  <h1>Sign in</h1>
  <p class="muted">Synthetic test-only sign-in. No real accounts are involved.</p>
  <div class="card">
    <form action="/signin" method="post" data-testid="signin-form">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="off">
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="off">
      </div>
      <button type="submit" class="primary" data-testid="signin-submit">Sign in</button>
    </form>
    <p class="muted" style="font-size:13px;margin-top:14px">Test credentials: ${TEST_EMAIL} / ${TEST_PASSWORD}</p>
  </div>`
      })
    ),

  "POST /signin": async (req, res) => {
    const body = await readBody(req);
    if (body.email === TEST_EMAIL && body.password === TEST_PASSWORD) {
      res.writeHead(303, {
        location: "/private",
        "set-cookie": `${AUTH_COOKIE}=${AUTH_VALUE}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end();
      return;
    }
    send(
      res,
      401,
      layout({ title: "Sign in", nav: false, body: `<div class="banner err" role="alert" data-testid="signin-error">Those credentials were not accepted.</div>` })
    );
  },

  "GET /private": (req, res) => {
    if (!isAuthed(req)) {
      send(
        res,
        401,
        layout({
          title: "Sign in required",
          body: `
  <h1>Sign in required</h1>
  <div class="banner err" role="alert" data-testid="auth-required">You must sign in to view this page.</div>
  <p><a class="btn" href="/signin" data-testid="go-signin">Go to sign in</a></p>`,
        })
      );
      return;
    }
    send(
      res,
      200,
      layout({
        title: "Private",
        user: TEST_EMAIL,
        body: `
  <h1>Private area</h1>
  <div class="banner ok" role="status" data-testid="private-content">This is restricted test-only content.</div>
  <div class="card"><p class="muted" data-testid="private-note">Only reachable with the synthetic test session.</p></div>`,
      })
    );
  },

  "GET /broken": (req, res) =>
    send(
      res,
      500,
      layout({ title: "Server error", body: `<h1>Something went wrong</h1><div class="banner err" role="alert" data-testid="server-error">The server could not complete this request.</div>` })
    ),

  "GET /slow": async (req, res) => {
    await new Promise((r) => setTimeout(r, 1200));
    send(res, 200, layout({ title: "Slow", body: `<h1 data-testid="slow-content">Loaded after a delay</h1>` }));
  },
};

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;

  try {
    // --- API
    if (key === "POST /api/tasks") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim();
      if (!title) return sendJson(res, 422, { error: "A task name is required." });
      if (title.length < 3) return sendJson(res, 422, { error: "Use at least 3 characters." });
      if (title.toUpperCase() === "FAIL") {
        // Deliberate server-side failure for honest-failure tests.
        return sendJson(res, 500, { error: "The server refused to create this task." });
      }
      // `priority` is stored so a workflow can verify that a dropdown choice
      // actually reached the application, not just that the option was clicked.
      const task = {
        id: randomUUID(),
        title,
        priority: String(body.priority ?? "normal"),
        done: false,
        createdAt: Date.now(),
      };
      state.tasks.push(task);
      return sendJson(res, 201, { task });
    }
    if (key === "POST /__reset") {
      state = seed();
      return sendJson(res, 200, { ok: true, tasks: state.tasks.length });
    }
    if (key === "GET /__state") {
      return sendJson(res, 200, { tasks: state.tasks, projects: state.projects });
    }

    // --- project dashboard (dynamic path)
    const dashboard = url.pathname.match(/^\/projects\/([A-Za-z0-9-]+)$/);
    if (req.method === "GET" && dashboard) {
      const project = state.projects.find((p) => p.id === dashboard[1]);
      if (!project) return send(res, 404, layout({ title: "Not found", body: `<h1>Project not found</h1>` }));
      return send(res, 200, projectDashboard(project));
    }

    // --- delete project: the fixture's one genuinely consequential action.
    // It exists so tests can prove the authorization gate works, and that an
    // authorized run really changes application state.
    const remove = url.pathname.match(/^\/projects\/([A-Za-z0-9-]+)\/delete$/);
    if (req.method === "POST" && remove) {
      const before = state.projects.length;
      state.projects = state.projects.filter((p) => p.id !== remove[1]);
      if (state.projects.length === before) {
        return send(res, 404, layout({ title: "Not found", body: `<h1>Project not found</h1>` }));
      }
      res.writeHead(303, { location: "/projects?deleted=1" });
      return res.end();
    }

    const handler = routes[key];
    if (handler) return await handler(req, res);

    send(res, 404, layout({ title: "Not found", body: `<h1>Not found</h1><p class="muted">No route for <code>${esc(key)}</code>.</p>` }));
  } catch (err) {
    send(res, 500, layout({ title: "Server error", body: `<h1>Server error</h1><pre>${esc(err?.stack ?? err)}</pre>` }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  process.stdout.write(`fixture app listening on http://127.0.0.1:${addr.port}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
