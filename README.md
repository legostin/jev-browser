# JEV Browser

A Codex plugin for completing browser tasks autonomously. You provide a goal; JEV chooses a sequence of actions, the executor interacts with the browser, and the plugin records progress and findings.

**Code builds the interface structure. No LLM is used for collection.**

## One-command installation

**macOS / Linux.** Requires Node.js 22+, npm, Git, Codex CLI (`codex` in your PATH), and Google Chrome. The installer checks these tools before making changes. Windows is not supported yet.

### Using npx

Install the MCP server and skill with one command:

```sh
npx --yes 'git+https://github.com/legostin/jev-browser.git#main' install
```

Start the shared dashboard after installation:

```sh
npx --yes 'git+https://github.com/legostin/jev-browser.git#main' start
```

With no arguments, the command runs `start`. Other commands include `configure`, `doctor`, `status`, `update`, `service status|stop|restart`, and `mcp`. Repeated launches use the same persistent service. `install` explicitly registers the tools with Codex; a normal launch does not register anything. MCP uses a stable local launcher, so clearing the npm cache does not break the installation. The Chrome extension still requires manual setup; see below.

The repository is **public**. Installing over HTTPS does not require a GitHub account or authentication. npm runs the binary from the Git package according to the [npm exec rules](https://docs.npmjs.com/cli/npm-exec/).

The package has not been published to the npm registry, so the short command `npx jev-browser` is **not available for this project yet**. That requires a separate publication and a decision about access. For now, use the GitHub address. The `install` command installs the latest `main`; the Git address fetches the installer. This installation method does not require publishing to npm.

### Alternative: GitHub CLI

If you already use an authenticated GitHub CLI (`gh auth login`):

```sh
bash -o pipefail -c 'gh api -H "Accept: application/vnd.github.raw+json" repos/legostin/jev-browser/contents/install.sh?ref=main | bash'
```

The command fetches the project, installs dependencies from the lockfile, builds it, checks MCP startup and the core tools, registers the server through `codex mcp add`, and adds the Codex skill. Running it again preserves your settings and key. Updates require network access to GitHub and npm.

This installs **MCP + a skill**, without depending on internal Codex utility skills or changing your personal marketplace. It does not add a plugin card to the catalog. The repository retains a standard plugin manifest for separate distribution through a marketplace.

You can also install with `curl`, without GitHub CLI or authentication:

```sh
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/legostin/jev-browser/main/install.sh | bash'
```

On first use, save your OpenRouter key. **Input is hidden**, and the key does not appear in the command line:

```sh
~/.local/bin/jev configure
```

If the key already exists in the standard configuration file or an older JEV installation, the installer preserves or migrates it. Start a **new Codex task** or restart MCP. Then ask:

> Use JEV Browser to find a 2026 Toyota Camry in Almaty. Collect listings with links and prices. Do not contact sellers.

By default, JEV uses **your Chrome browser**: connect the extension as described below. Without a connection, it returns setup instructions instead of opening a separate window. A separate browser is available only when you explicitly select `isolated` mode.

### Automatic updates

Enabled by default. When MCP starts, it checks for updates **in the background, at most once a day**. The update channel is this repository's `main` branch. Downloading, dependency installation, building, type checking, and MCP validation run in a separate directory. Only a validated release becomes current. If GitHub/npm is unavailable or validation fails, the working release remains active. The next automatic attempt occurs on an MCP launch after another day has elapsed.

A persistent local service owns the browser. It keeps running its existing version after a package update or MCP reconnection. To apply a new engine version, complete or pause your tasks and run `jev service restart`. Restarting the service releases browser connections and clears secrets held in memory; reconnect the extension afterward. A new Codex task picks up the updated skill. Previously installed releases remain available for running processes and rollback.

```sh
~/.local/bin/jev status             # Version, last update result, extension directory
~/.local/bin/jev update             # Check and install now
~/.local/bin/jev auto-update off    # Disable automatic updates
~/.local/bin/jev auto-update on     # Enable automatic updates
~/.local/bin/jev rollback           # Previous release; also disables automatic updates
~/.local/bin/jev doctor             # Check configuration
~/.local/bin/jev serve              # Shared dashboard link; the terminal can be closed
~/.local/bin/jev service status     # Running service PID and release
~/.local/bin/jev service stop       # Stop after completing or pausing tasks
~/.local/bin/jev service restart    # Apply a new engine version or configuration
```

If `~/.local/bin` is in your PATH, you can use commands such as `jev update`. Set `JEV_AUTO_UPDATE=0` to disable automatic checks for a particular launch. Update diagnostics are stored in `~/.local/share/jev-browser/runtime/update.log`; `jev status` shows a brief result. If you move or remove Node.js, run the installer again to update the MCP executable path.

Files:

| Purpose | Location |
|---|---|
| Key and configuration | `~/.config/jev-browser/.env` (0600 permissions) |
| Releases and update log | `~/.local/share/jev-browser/runtime/` |
| Stable current release | `~/.local/share/jev-browser/runtime/current` |
| Codex skill | `~/.agents/skills/jev-browser` — symlink to the current release |
| Command | `~/.local/bin/jev` |
| Tasks and findings | `~/.local/share/jev-browser/` |

Updates do not copy local `.env` files, logs, or tasks into the package. The key is never sent to the extension or written into the Codex configuration; that configuration stores only the path to the private file. Configuration precedence: environment → the running project's `.env` → `JEV_CONFIG_FILE` or `~/.config/jev-browser/.env`.

### Running from source

```sh
npm ci --ignore-scripts
npm run build
npm start
# Install the current COMMIT into Codex (uncommitted changes are excluded):
npm run setup
```

Open the local link printed in the terminal. It contains an access token; do not publish it. The connected Chrome tab is used by default. A separate context is created only when you explicitly select `browser: "isolated"`. For Chromium, run `npx playwright install chromium` and set `JEV_BROWSER_CHANNEL=chromium`. An explicitly configured local `JEV_CDP_URL` is also supported; remote debugging is not enabled automatically.

## Codex tools

| Tool | Purpose |
|---|---|
| `jev_run` | Start or continue the current task; wait up to 25 seconds for an event |
| `jev_wait` | Receive a clarification request or result as soon as it appears, without periodic polling |
| `jev_task` | Read progress, findings, and clarification requests |
| `jev_inspect` | Read interface structure by region and slice |
| `jev_pause` | Pause after the current in-flight interaction settles |
| `jev_resume` | Resume or update the goal, values, or limits |
| `jev_cancel` | Stop and close task-owned tabs |
| `jev_status` | Check configuration and get the dashboard link |

## Direct MCP connection

A new installation registers MCP directly. If the tools do not appear, restart MCP in Codex settings and start a new task. Check `~/.local/bin/jev doctor` and `codex mcp get jev-browser`. Running the installer again restores registration.

To inspect Codex's tool inventory without calling a model:

```sh
node ~/.local/share/jev-browser/runtime/current/scripts/check-codex-mcp.mjs
```

The connection uses an absolute Node.js path and a stable launcher. Configuration options are described in the [MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Missing tools in a session cannot be fixed by silently launching another browser: its tab and connection link would be different.

## Extension for your regular Chrome browser

The `chrome-extension/` directory contains JEV Browser Companion (Manifest V3, Chrome 125+). It connects a user-selected tab, including its existing signed-in session, to the same engine. Code still builds the structure; Playwright handles navigation and frames through a local `chrome.debugger` bridge.

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `~/.local/share/jev-browser/runtime/current/chrome-extension`. When running from source, select the project's `chrome-extension` directory.
2. In a new Codex task, ask for the JEV connection link (`jev_status` → `dashboard`). Alternatively, run `npm start` and copy the connection link from the local dashboard. Use the link for the service that will run your task.
3. Click the JEV icon in Chrome. Paste the full link into the side panel, select a tab, and click **Connect tab**.
4. Ask Codex to perform the task **in the connected Chrome browser**. It will pass `browser: "extension"`, a plan, values, and checks. You can select the same mode in the local dashboard's browser selection field.

Extension mode starts on the selected tab's current page; the `url` field is informational in this mode. Navigation happens as part of the task. Disconnecting revokes access but preserves the user's tab. One connection serves one task at a time. Clarifications and subsequent stages continue in the same task and tab. After completion, an explicitly new task record can reuse the same browser session. Cancellation or disconnection releases the connection; the tab must then be shared again. Only child tabs opened by the selected page are additionally accessible, with up to 8 tabs in the group.

The extension uses the `debugger`, `tabs`, `sidePanel`, `storage`, and `webNavigation` permissions. The last one associates child tabs with their source even for links without an `opener`. Chrome displays a debugging indicator. Opening DevTools or disconnecting debugging may interrupt the connection; the task stops for review, and the action is not replayed automatically. The bridge listens only on loopback and validates the extension origin and private token; ordinary web pages cannot connect. The OpenRouter key is never sent to the extension. The connection token is stored only for the browser session.

Installing the extension in your personal profile requires the Chrome UI. After updating JEV, click **Reload** for the extension at `chrome://extensions` and reconnect the tab. Extension files update with the engine, but the loaded extension is not reloaded in the middle of a task. Until the extension is published in the Chrome Web Store, the project does not provide automatic installation or updates through the store. Distribution restrictions are described in the [Chrome documentation](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).

## Persistent service and continuation without new windows

The first MCP request automatically starts a single local service. All MCP clients and `jev serve` use its shared dashboard and Chrome connection. Closing the terminal or disconnecting MCP does not stop tasks or close the browser. The service runs until `jev service stop`, a computer restart, or a crash; system startup integration is not installed yet. The service endpoint and a separate RPC token are stored with 0600 permissions in `service/` under `JEV_DATA_DIR`.

`jev_status` returns the conversation's `sessionId` and `currentTaskId`. All eight tools accept an optional `sessionId`: keep it and pass it after reconnecting, along with the existing task ID. If the environment provides `JEV_SESSION_ID` or `CODEX_THREAD_ID`, that value is used; otherwise, an ID is generated per connection. The skill explicitly requires continuing with the previous sessionId instead of starting a replacement task. This separates one user's workflows; it is not a security boundary between different users. A conversation cannot accidentally continue another conversation's task. Deliberate shared continuation is possible using its sessionId.

`jev_run` continues the current task by default: calling it again for a running task returns the same ID, while a refined goal continues the existing session. To change a running task, call `jev_pause`, then `jev_resume`. `newTask: true` creates a separate record only when explicitly requested. In extension mode, after the previous task completes, it inherits the connected browser without opening a new window. A competing task cannot be created in an occupied tab.

`jev_run` and `jev_resume` hold the call for up to 25 seconds and immediately return on `needs_input`, `needs_review`, a pause, or a result. If work is still running, the agent calls `jev_wait` with the same ID for up to 45 seconds. The wait subscribes to engine events, so a clarification request is returned as soon as its state is saved. The agent supplies an answer through `jev_resume`, preserving the tab and history. The response includes `attentionRequired`, `pending`, `nextTool`, and a dashboard link.

This is a two-way exchange within an active sequence of tool calls. The plugin cannot wake an ended or idle Codex conversation by itself. The skill therefore requires continuing with `jev_wait` until there is a result or a request for information. Reconnecting MCP preserves live tabs, form values, and pending clarification requests. Restarting the service itself is a separate operation that releases the browser connection.

## Confidence threshold

The default is **0.55**. In the dashboard, set the threshold in task settings when starting, or change it in the clarification section before resuming. Through MCP, use `minConfidence` in `jev_run` or `jev_resume.patch`, with a value from 0 to 1.

```sh
~/.local/bin/jev confidence 0.65
```

This saves `JEV_MIN_CONFIDENCE` in the private configuration file. After `jev service restart`, it becomes the threshold for **new** tasks. Existing tasks keep their own threshold. Below the threshold, JEV stops and returns the selected action and alternatives to the agent; it does not lower the threshold itself. Missing confidence still requires review, even with a threshold of 0.

## How it works

```text
Codex / local dashboard
        ↓ goal, exact values, outcome conditions
TaskManager — state, history, limits, findings
        ↓
BrowserAdapter → Collector → structured interface
        ↑                       ↓
executor ← JEV Decisions ← compact representation
        ↓
fresh observation → outcome verification / next step
```

The collector uses the DOM, standard HTML/ARIA roles, and accessible name computation through `dom-accessibility-api`. It is not a full snapshot of the browser's internal accessibility tree. It preserves hierarchy, label/description/field relationships, values, states, position, scrolling, and the origin of structural groups. Frames are read separately; open shadow roots are traversed recursively. There are no rules for specific websites or business entities.

The executor retains the full observed structure. JEV receives semantic groups: forms, dialogs, cards (`article`), list items, and table rows. Labels, fields, errors, and buttons in a group are sent together; empty intermediate wrappers do not split the group. Dialogs and the current focus take priority. A slice has a soft limit of 24 primary nodes, while a whole group can contain up to 64. Larger groups are split with an explicit `complete: false` flag and coverage counts. Parents and related nodes are added as context. JEV can expand a region, read the next slice, or inspect list options. Between decisions, it receives a deterministic `changes` summary: navigation and added, removed, or changed elements, up to 12 of each type with total counts. Large native selects are read in batches. Collection is limited to 4,000 nodes and 20,000 visited elements per document; exceeding these limits is reported in `limitations`.

Each ID is tied to a live DOM element in a specific document. Before acting, the executor observes the page again and validates the target: document/frame, role, name, link, field type and value, states, related descriptions, and the surrounding form or card. Unrelated page updates do not invalidate the action. A replaced DOM node can be rebound only when there is exactly one semantically equivalent element in equivalent context. The replacement is recorded in history as `executionTarget`/`rebound`. Ambiguity, a changed form, or an overlapping dialog requires a new observation and decision. Playwright also checks actionability. An uncertain action result stops execution for review; mutations are never automatically replayed.

Codex prepares a `plan` of short suggested stages and `values` containing exact text and each field's purpose. JEV sees them when selecting an action and adapts the plan to the observed page. Text is entered only from the exact-value list. If no values are supplied, the original goal wording is available as a possible search query. If no suitable value exists, the task returns `needs_input`. There is no second API for generating text.

The model receives compact node references, without a duplicated action list or coordinates. Filling a field focuses it automatically; clicking the same editable field does not compete with filling in the primary action set. Additional clicks, hovering, and keyboard navigation are exposed through `inspect_controls`. Empty utility groups remain parent context instead of becoming separate candidates for every step.

When confidence is low, `lastDecision` includes the selected action, confidence, threshold, and up to five alternatives with probabilities. Review them and clarify the plan or value labels before continuing; lowering the threshold does not resolve an ambiguous task.

## Passwords and codes

Password fields are recognized as inputs through `type=password` and standard `autocomplete` hints such as `current-password`, `new-password`, `one-time-code`, and payment fields. Toggling “show password” does not remove masking from an already recognized field. JEV sees the type, purpose, and whether the field is filled, but not its value.

If the user has already supplied a password, Codex passes it separately in `secrets` for `jev_run` or in the `jev_resume` patch:

```json
{"secrets":[{"label":"Login password","text":"<explicitly supplied password>","origin":"https://example.com"}]}
```

JEV sees only the label and selects `fill_secret`; the executor inserts the value automatically **without asking again**. The value is held only in process memory until task completion, cancellation, or a service restart; it is retained while paused. `origin` is the exact authorized site, including scheme and port. The secret is not offered for another site or a frame with a different origin. A new `secrets` list replaces the previous one. MCP arguments may remain in the calling Codex conversation's history; the local dashboard lets users avoid passing passwords through the main agent.

If no matching secret is available, JEV offers `request_secret`, and the task pauses with `pending.kind=secret`. A masked **Password or code** input appears in the local dashboard. The **Fill and continue** button sends the value directly to the executor through a token-protected local channel. The value does not pass through MCP or an LLM, is not saved in the task, and is not added to history. Users can also enter the password directly in the browser and click **Continue**.

Do not put passwords in the goal, `values`, plan, or checks: those ordinary fields are included in the model context. An unusual field without appropriate HTML markup may require manual input; recognition does not rely on model guesses.

## Findings and continuation

The plugin maintains `browserContext` between steps and includes it in every JEV request, for both action and text selection. It contains source and destination pages, the clicked element and link, entered text, observed field changes, opened/closed tabs, and navigation between them. Each tab retains its URLs, whether it was visited, and its last action. This is a programmatic observation log with no LLM summarization; the main Codex agent does not reconstruct the history.

Memory is persisted with the task. A new browser session receives new tab identifiers even if the browser's internal IDs repeat. Unexecuted and uncertain actions retain their status. The model receives up to 12 recent steps, 24 tabs, and 8 navigations; older entries are then trimmed to fit a 14 KB budget. `coverage` reports completeness. The full action history remains in the task record, while the navigation log retains the latest 80 events. Background-tab information reflects the last observation. Sensitive fields are excluded from input memory.

`collect` saves an observed fragment with its URL, timestamp, and page version. This is website data, not automatically verified fact. Saved findings remain available to JEV after navigation.

A `done` decision from JEV triggers another observation and independent checks: URL, text, a named field's value, or the number of collected fragments. The `completed` status means the **configured checks** passed. Codex assesses whether those checks cover the goal. A fragment count does not prove the number of distinct products; visible text does not prove that a filter was applied. Without checks, proposed completion is returned to Codex as `needs_review`.

History and snapshots are written atomically to `~/.local/share/jev-browser` with restricted permissions; set `JEV_DATA_DIR` to change the location. They may contain information from visited pages. Reconnecting MCP preserves the live browser session owned by the service. After the service itself stops or crashes, history remains, but the connection must be reopened: `isolated` opens the last URL, while `extension` requires sharing the Chrome tab again. The plugin does not guarantee restoration of previous form state. Pausing preserves tabs and form state. Step, request, and time limits are cumulative; time is checked between iterations, so an in-flight call may finish later.

## Validation

- After adding the persistent service, target validation, and semantic groups, real JEV completed the local sequence “field → filter → search → collect card → verify” in **5 steps, 6 requests, 8.973 seconds, $0.000857304**. Live-page preservation across MCP reconnections and a shared service for two clients were tested separately.
- Real JEV searched for Toyota Camry from the Russian Wikipedia home page, opened the article, and passed URL and text checks: **5 steps, 7 requests, 8.768 seconds, $0.001822254**. Two stale steps were safely rejected before input. This is a single run.
- The real extension in a separate Chromium instance: selected tab → input → navigation → field inside a frame → child tab → outcome verification. Unrelated tabs are not attached, and cancellation preserves the user's tab. This test uses a deterministic decision provider.
- Local automated checks cover a shared service for concurrent MCP clients, live-page preservation after reconnection, conversation separation, whole forms and partial coverage of large groups, safe DOM-node rebinding, forms, checkboxes/selects, frames, open shadow roots, nested scrolling, new tabs, stale decisions, pausing during a request, missing text, completion verification, MCP, dashboard access, and mobile layout.
- Real JEV through OpenRouter: local form → input → filter → search → save card → two independent checks. Recorded run: **5 steps, 6 requests, 6.846 seconds, $0.002379048**, as reported by OpenRouter. This is one local scenario, not a reliability estimate for arbitrary websites.

```sh
npm run check
npm run test:installer
npx playwright install chromium # For the extension test in a separate profile
npm test
# The following commands make paid model requests:
node scripts/probe.mjs
node dist/scripts/live-smoke.js
node dist/scripts/live-wikipedia.js
```

## Initial release limitations

- Browser adapter only; native application control is not implemented yet.
- Canvas and closed shadow roots are not assigned invented structure; their inaccessibility is reported explicitly. OCR and model-based image recognition are not used.
- File uploads, drag-and-drop, and complex custom editors are not supported yet. Native JavaScript dialogs are dismissed and reported in the observation.
- There is no guarantee of compatibility with every website. Interface accessibility, CAPTCHAs, site restrictions, and observation coverage affect results.
- JEV is called through the alpha OpenRouter Decisions API. Provider contract changes may require an adapter update.
- Freshness validation protects against stale targets but does not establish whether the model's intent is correct. For actions with external consequences, the goal must explicitly reflect the scope authorized by the user.

The extension uses the official [chrome.debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger), [sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), and [webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) APIs.

Sources: [JEV / TypeSafe](https://docs.typesafe.ai/concepts/system-one), [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request), and [jev-ultrafast](https://github.com/browser-use/jev-ultrafast). The last project was studied as an architectural reference; this project's core was implemented independently.
