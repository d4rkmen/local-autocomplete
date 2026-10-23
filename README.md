# Local Autocomplete

Inline, ghost-text code completions designed for **Cursor Private Inference (Cursor PI)**.
Use a compatible model server directly, or pair it with **Cursor Local Models**
(`cursor-local-models`) to share the gateway used by your Agent chats. Cursor Local Models
handles model discovery and API translation; Local Autocomplete supplies inline suggestions.
The extensions complement each other, but neither requires the other.

## Why you need this

Cursor PI does not provide Cursor Tab through its configured Gateway. Local Autocomplete
provides an independent inline completion provider using your chosen model; it does not
re-enable Cursor Tab.

**Local Autocomplete** replaces that missing piece:
- Registers a standalone `InlineCompletionItemProvider` that sends code around your cursor to your own OpenAI-compatible endpoint (or automatically inherits your Cursor Private Inference Gateway URL and API key).
- Gathers **Cursor Tab-style editor context** (open/recently viewed files, recent edits, diagnostics near the cursor, active function signatures, and LSP completions) using standard VS Code APIs so local models produce context-aware suggestions.
- Supports both **Chat mode** (`/v1/chat/completions`, requires a compatible chat endpoint and model) and **FIM Completions mode** (`/v1/completions` for fill-in-the-middle coder models).

## Install and configure

In the **Cursor PI window/profile you use**, run **Extensions: Install from VSIX** and
select `local-autocomplete-0.4.4.vsix`. Reload the window. A plain `cursor` CLI command
may target your regular Cursor installation instead of PI.

Use **Local Autocomplete: Configure** from the Command Palette to set the connection,
choose a model, and enable completions. PI may not show extension-contributed settings
in its Settings panel; you can also use **Preferences: Open User Settings (JSON)** in
the active PI window. Completions are disabled by default.

### Recommended: with Cursor Local Models

1. Install and configure `cursor-local-models` in the same PI profile. Set its upstream
   to your actual provider and store the real provider key using
   **Cursor Local Models: Set API key** (or its API-key environment variable).
2. Set **Cursor PI Settings → Models → Gateway** to `http://127.0.0.1:41100/v1`
   and key `local`. Adjust the port if you changed it in Cursor Local Models.
3. In **Local Autocomplete: Configure**, choose **Clear Base URL and API key** to inherit
   PI's Gateway values. Alternatively, set both explicitly to that loopback URL and
   `local`; this avoids inherited credential lookups.
4. Keep `localAutocomplete.mode` set to `chat`. Run **Local Autocomplete: Select Model**
   and choose a fast, preferably non-reasoning model, then **Local Autocomplete: Enable**.

The real provider key stays with Cursor Local Models, which needs it for `/models`
discovery as well as inference. Local Autocomplete only needs the gateway connection.

**Compatibility:** the gateway lists only provider models with exact IDs in its
`out/models.json`. For autocomplete, choose an entry using `chat_completions` /
`openai_chat`, or `anthropic_messages` through the gateway's text adapter. A model
listed as Responses-only cannot handle Local Autocomplete's chat requests. The model
picker does not filter these incompatible entries. The gateway does **not** expose
`/v1/completions`, so FIM mode requires a separate server that supports that endpoint.

### Alternative: connect directly to a model server

Set `localAutocomplete.baseUrl` to an OpenAI-compatible base URL such as
`http://127.0.0.1:1234/v1` for LM Studio, and configure the matching key through
**Local Autocomplete: Configure → API key**. Select a model and enable completions.
Use `chat` mode for a Chat Completions server, or `completions` mode for a server and
model supporting the configured FIM template. A native Anthropic-only endpoint is not
a direct substitute for an OpenAI-compatible server.

**Important:** an empty API-key setting means *inherit*, not *send no key*. Setting a
different base URL while leaving the key empty can send PI's inherited key to that
other server. Configure both fields together when changing providers. For an unauthenticated
local server, a non-secret placeholder such as `local` avoids inheritance only if the
server accepts that bearer token; there is currently no explicit no-auth option.

### How URL and key inheritance work

Each field resolves independently:

- **Base URL:** non-empty `localAutocomplete.baseUrl`, otherwise stored PI `openAIBaseUrl`,
  then `CURSOR_LOCAL_AGENT_BASE_URL`, then `ANTHROPIC_BASE_URL`.
- **API key:** non-empty `localAutocomplete.apiKey`, otherwise stored PI
  `cursorAuth/openAIKey`, then `CURSOR_LOCAL_AGENT_API_KEY`, then `ANTHROPIC_AUTH_TOKEN`.

Current implementation limits: environment fallbacks are evaluated only after a Cursor
user-data directory with `state.vscdb` is found. Custom `--user-data-dir` profiles may not
be detected correctly; set both fields explicitly if inheritance fails or selects the
wrong profile. Resolved connections are cached, so Gateway changes may not appear immediately;
reload the PI window if needed. If no URL resolves, no requests are sent.

If **either** field is empty, the extension reads both inherited values, which may trigger
an OS credential prompt even when the API key is explicitly set. Set **both** fields to
non-empty values to skip this lookup. On macOS, Keychain access uses `/usr/bin/security`;
prompts depend on your Keychain permissions. Where used, the inherited-key cache stores a
copy in this extension's SecretStorage and reuses it while the encrypted source blob is
unchanged. `localAutocomplete.cacheCursorKey: false` disables use of that persistent cache;
**Forget Cached Cursor Key** removes it. Neither changes PI's original key.

**Key storage:** keys entered through Local Autocomplete's Configure menu are saved in
plain-text user settings (`localAutocomplete.apiKey`), not SecretStorage. Do not commit or
share those settings. This differs from **Cursor Local Models: Set API key**, which uses
SecretStorage. Avoid sharing logs without review: provider errors may contain sensitive data.

## Commands

| Command | What it does |
| --- | --- |
| `Local Autocomplete: Toggle` | Turn inline completions on or off (`Ctrl+Alt+A` / `Cmd+Alt+A`). |
| `Local Autocomplete: Enable` | Turn on and check the server. |
| `Local Autocomplete: Disable` | Turn off. |
| `Local Autocomplete: Configure` | One menu for base URL, model, API key, on/off, and settings.json. |
| `Local Autocomplete: Set Base URL` | Enter and validate a new server URL. Saves it and tests `/v1/models`. Press Enter on an empty value to inherit Cursor's gateway. |
| `Local Autocomplete: Select Model` | List `/v1/models` and pick one. |
| `Local Autocomplete: Open Settings` | Open the extension settings page. |
| `Local Autocomplete: Edit settings.json` | Open the settings file directly, bypassing the Settings UI. |
| `Local Autocomplete: Show Last Context` | Open the exact `<tab_context>` block that was sent with the last request. |
| `Local Autocomplete: Show Last Error` | Show the last failure with its details, how to fix it, and one-click fix actions. |
| `Local Autocomplete: Forget Cached Cursor Key` | Drop the cached copy of Cursor's inherited API key; the next request asks for Keychain access again. |

The status bar shows `$(sparkle) Local AC` when on and `$(circle-slash) Local AC` when off. While a request is in progress it shows a spinning `$(loading~spin) Local AC`. Click it to toggle.

### Errors

When completions fail, the status bar switches to `$(warning) Local AC` with a warning background, and its tooltip shows the error and how to fix it. Clicking it opens the error details with fix actions (Select Model, Set Base URL, Set API Key, Open Settings, Show Log, Copy error, Turn off). A notification with the same actions is shown once per distinct problem, and again only if it is still failing 10 minutes later. Manual triggers (`Alt+\` / Trigger Inline Suggestion) always show it.

Recognized problems:

| Problem | Typical cause | Suggested fix |
| --- | --- | --- |
| Authentication failed (401/403) | Wrong or expired API key | Set API Key, or update the Cursor gateway key |
| Model not found / rejected | Model id not served by the gateway | Select Model |
| Endpoint not found (404), non-JSON reply | Base URL missing `/v1` or pointing at a web page | Set Base URL |
| Rate limited (429) | Too many requests | Raise `debounceMs` |
| Server error (5xx), timeout | Gateway/provider down or model too slow | Select another model, raise `timeoutMs` |
| Cannot reach host | DNS, refused connection, TLS, VPN/proxy | Set Base URL, check network |
| Reasoning model returned no code | Tokens spent on reasoning (`finish_reason: length`) or reasoning-only answer | Select a non-reasoning model, or raise `maxTokens` |
| Model keeps returning empty answers | 4 empty answers in a row | Select another model or switch `mode` |

The error clears automatically after the next successful answer, or when you change the base URL, API key, model, mode, `maxTokens`, or `timeoutMs`. Full server responses for failed requests are written to the **Local Autocomplete** Output channel.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `localAutocomplete.enabled` | `false` | Master switch. |
| `localAutocomplete.baseUrl` | empty | Include `/v1`. Empty = use the Cursor Private Inference base URL. |
| `localAutocomplete.apiKey` | empty | Bearer token stored in plain-text settings. Empty = inherit PI's key, even with an explicit base URL. |
| `localAutocomplete.cacheCursorKey` | `true` | Cache inherited credentials in SecretStorage to reduce repeated OS credential prompts; prompts depend on permissions. |
| `localAutocomplete.model` | empty | Empty = first model returned by `/v1/models`. |
| `localAutocomplete.mode` | `chat` | `chat` = `/v1/chat/completions`; `completions` = `/v1/completions` with FIM. |
| `localAutocomplete.fimTemplate` | Qwen-style FIM tokens | Only for `completions` mode. Must match the model. |
| `localAutocomplete.debounceMs` | `300` | Raise it if the model is slow. |
| `localAutocomplete.timeoutMs` | `15000` | Abort slow requests. |
| `localAutocomplete.maxPrefixChars` | `6000` | Prompt budget before the cursor. |
| `localAutocomplete.maxSuffixChars` | `2000` | Prompt budget after the cursor. |
| `localAutocomplete.maxTokens` | `256` | Response budget. |
| `localAutocomplete.maxSuggestionChars` | `2000` | Longer suggestions are discarded. |
| `localAutocomplete.extendedContext` | `true` | Send Tab-style editor context with each request. |
| `localAutocomplete.contextMaxChars` | `8000` | Character budget for the context block. `0` disables it. |
| `localAutocomplete.contextMaxFiles` | `6` | Maximum open/recently viewed files in the context. |
| `localAutocomplete.contextFileMaxChars` | `2500` | Excerpt budget per additional file. |
| `localAutocomplete.contextInCompletionsMode` | `false` | Add context to FIM (`completions`) prompts. |
| `localAutocomplete.languages` | `[]` | Empty = all languages. |
| `localAutocomplete.disabledLanguages` | `["plaintext"]` | Never complete these. |
| `localAutocomplete.showStatusBar` | `true` | Status bar indicator. |

## How it works

On each typing pause the extension takes up to `maxPrefixChars` before the cursor and `maxSuffixChars` after it, sends them to the configured server, and inserts the reply as an inline suggestion.

- `chat` mode asks an instruct model to return only the insertion text. This requires a model served through a compatible Chat Completions endpoint.
- `completions` mode sends a raw fill-in-the-middle prompt. This needs FIM tokens the model was trained on, for example `"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"` for Qwen coder models. Change `localAutocomplete.fimTemplate` if your model uses different tokens.

The response is cleaned before insertion: Markdown fences are removed, echoed `<CURSOR>` markers are stripped, and the request is aborted if the editor moved on.

## Context gathering

When `localAutocomplete.extendedContext` is on (the default), the extension gathers a `Cursor Tab`-style context block and adds it to the prompt. It does not use Cursor's `StreamCpp` RPC or file-sync services; everything comes from the public VS Code API.

All of the following sources are always included when Extended Context is on:

- Current file metadata: relative path, language, line count, EOL, cursor, selection.
- Diagnostics: errors/warnings near the cursor, plus recent diagnostics from edited files.
- Signature help: the active signature and parameter at the cursor.
- Recent edits: a bounded, coalesced history of content changes across the workspace (inserted and removed text).
- Open files: visible ranges from other visible editors, with line-numbered excerpts.
- Recently viewed files: visible ranges from files that were focused or scrolled recently.
- LSP completion labels from the language server's completion provider.
- Recently rejected completions, so the model does not repeat an identical suggestion.

The block is wrapped in `<tab_context>` and capped by `contextMaxChars`. `extendedContext: false` or `contextMaxChars: 0` sends only the prefix/suffix. Run `Local Autocomplete: Show Last Context` (or the Configure menu entry) to inspect exactly what was sent; the Output channel also logs whether context is enabled and its budget at startup.

## Privacy

Code and the gathered context are sent only to the resolved endpoint: `localAutocomplete.baseUrl`, or the Cursor Private Inference gateway when that setting is empty. Point it at `127.0.0.1` or your LAN to keep inference off Cursor's servers. Be aware that enabling context sends excerpts of open/recently viewed files and diagnostics, not just the current cursor window; use `contextMaxFiles` and `contextMaxChars` to limit it, or turn off `extendedContext`. URL and key inheritance are independent: an explicit URL can receive an inherited key. Configure both together as described above. A loopback gateway may forward requests to a remote provider, so a local URL alone does not guarantee local inference. `.env` files are excluded from context and completions. Nothing here re-enables Cursor Tab; Tab remains unavailable in Cursor Private Inference.

## Limitations

- Quality and latency depend entirely on the local model. Chat mode is broadly compatible but slower than a purpose-built FIM completion model.
- The endpoint must expose the OpenAI-compatible API (`/v1/models`, `/v1/chat/completions` or `/v1/completions`).
- If another inline provider is active, both may offer suggestions. Cursor Tab is off in Private Inference, so there is no conflict there.
- Context is limited to open, visible, and recently viewed documents. There is no repository-wide retrieval, full-file sync, multi-diff replacement, or "jump to next edit"; this is still single-cursor ghost text.
- Extended Context runs the language server's signature-help and completion providers on every request (each capped at ~100 ms); turn off `extendedContext` if completions feel slow.
