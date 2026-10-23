'use strict';

const path = require('path');
const vscode = require('vscode');

const TRACKED_SCHEMES = new Set(['file', 'vscode-remote', 'untitled']);
const MAX_TRACKED_FILES = 50;
const MAX_SNAPSHOTS = 50;
const MAX_RECENT_EDITS = 100;
const MAX_EDITS_PER_ENTRY = 10;
const MAX_EDIT_TEXT = 400;
const MAX_LINE_CHARS = 512;
const MAX_SNIPPET_LINES = 60;
const MAX_SNAPSHOT_CHARS = 256 * 1024;
const MAX_TRACKED_LINE_COUNT = 20000;
const COALESCE_MS = 750;
const DEFAULT_VIEW_AGE_MS = 30 * 60 * 1000;

function truncate(text, max) {
  const value = String(text || '');
  if (max <= 0 || value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeLineEndings(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function isTrackableScheme(uri) {
  return !!uri && TRACKED_SCHEMES.has(uri.scheme);
}

function isSensitivePath(fsPath) {
  const base = path.basename(String(fsPath || '')).toLowerCase();
  return base === '.env' || base.startsWith('.env.');
}

function relativePath(uri) {
  if (!uri) {
    return '';
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && uri.fsPath && folder.uri.fsPath) {
    const relative = path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
    if (relative && !relative.startsWith('..')) {
      return relative;
    }
  }
  return vscode.workspace.asRelativePath(uri, false);
}

function isTrackableDocument(document) {
  if (!document || !isTrackableScheme(document.uri)) {
    return false;
  }
  if (isSensitivePath(document.uri.fsPath)) {
    return false;
  }
  if (document.lineCount > MAX_TRACKED_LINE_COUNT) {
    return false;
  }
  if (document.uri.scheme !== 'untitled' && !vscode.workspace.getWorkspaceFolder(document.uri)) {
    return false;
  }
  return true;
}

function inclusiveVisibleRanges(editor) {
  if (!editor || !editor.visibleRanges) {
    return [];
  }
  return editor.visibleRanges
    .map((range) => {
      // VS Code often reports the bottom of the viewport at column 0 of the first
      // non-visible line; don't include that extra trailing line in our 1-based range.
      const endLine = range.end.character === 0 && range.end.line > range.start.line
        ? range.end.line
        : range.end.line + 1;
      return { startLine: range.start.line + 1, endLine };
    })
    .filter((range) => range.endLine >= range.startLine)
    .slice(0, 4);
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timeout])
    .finally(() => clearTimeout(timer));
}

// Replay a batch of VS Code content changes against our cached pre-edit snapshot.
// Sorting in descending offset order lets us splice each change in place without
// invalidating the offsets of earlier ranges in the same event.
function applyContentChanges(previous, changes) {
  let text = previous;
  const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  for (const change of ordered) {
    if (typeof change.rangeOffset !== 'number' || change.rangeOffset < 0 || change.rangeOffset > text.length) {
      return undefined;
    }
    const end = change.rangeOffset + (change.rangeLength || 0);
    if (end > text.length) {
      return undefined;
    }
    text = text.slice(0, change.rangeOffset) + change.text + text.slice(end);
  }
  return text;
}

function snippetFromDocument(document, ranges, options = {}) {
  if (!document || document.isClosed || document.lineCount === 0) {
    return '';
  }
  const lineMax = options.lineMaxChars ?? MAX_LINE_CHARS;
  const maxLines = options.maxLines ?? MAX_SNIPPET_LINES;
  const maxChars = options.maxChars ?? 2500;
  const selected = ranges && ranges.length > 0
    ? ranges
    : [{ startLine: 1, endLine: Math.min(document.lineCount, 40) }];
  const lines = [];
  let used = 0;
  let usedLines = 0;
  for (const range of selected) {
    const start = Math.max(1, Math.min(range.startLine, document.lineCount));
    const end = Math.max(start, Math.min(range.endLine, document.lineCount));
    for (let line = start; line <= end && usedLines < maxLines; line += 1) {
      const text = truncate(document.lineAt(line - 1).text, lineMax);
      const addition = `${line}: ${text}`;
      if (used + addition.length + 1 > maxChars) {
        return lines.join('\n');
      }
      lines.push(addition);
      used += addition.length + 1;
      usedLines += 1;
    }
  }
  return lines.join('\n');
}

function nearbyDiagnostics(document, cursorLine, limit) {
  return vscode.languages.getDiagnostics(document.uri)
    .filter((diagnostic) => (
      diagnostic.severity === vscode.DiagnosticSeverity.Error ||
      diagnostic.severity === vscode.DiagnosticSeverity.Warning
    ))
    .map((diagnostic) => ({
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING',
      message: truncate(diagnostic.message, 200)
    }))
    .sort((a, b) => Math.abs(a.line - cursorLine) - Math.abs(b.line - cursorLine) || a.line - b.line)
    .slice(0, limit);
}

function labelToString(label) {
  if (typeof label === 'string') {
    return label;
  }
  if (Array.isArray(label) && label.length === 2) {
    return '';
  }
  return '';
}

function documentationToString(documentation) {
  if (typeof documentation === 'string') {
    return documentation;
  }
  if (documentation && typeof documentation.value === 'string') {
    return documentation.value;
  }
  return '';
}

async function signatureHelpFor(document, position, timeoutMs) {
  try {
    const result = await withTimeout(
      vscode.commands.executeCommand(
        'vscode.executeSignatureHelpProvider',
        document.uri,
        position
      ),
      timeoutMs,
      undefined
    );
    if (!result || !Array.isArray(result.signatures) || result.signatures.length === 0) {
      return undefined;
    }
    const signature = result.signatures[0];
    const active = result.activeParameter ?? signature.activeParameter ?? 0;
    const parameter = Array.isArray(signature.parameters) ? signature.parameters[active] : undefined;
    return {
      label: truncate(labelToString(signature.label), 300),
      activeParameter: parameter ? truncate(labelToString(parameter.label), 120) : undefined,
      documentation: truncate(documentationToString(signature.documentation), 200)
    };
  } catch {
    return undefined;
  }
}

async function completionItemsFor(document, position, timeoutMs, limit) {
  try {
    const result = await withTimeout(
      vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
        undefined,
        0
      ),
      timeoutMs,
      undefined
    );
    const items = result && Array.isArray(result.items) ? result.items : [];
    const output = [];
    for (const item of items) {
      const label = typeof item.label === 'string'
        ? item.label
        : item.label && typeof item.label.label === 'string'
          ? item.label.label
          : '';
      if (!label) {
        continue;
      }
      output.push({
        label: truncate(label, 120),
        detail: item.detail ? truncate(String(item.detail), 120) : undefined
      });
      if (output.length >= limit) {
        break;
      }
    }
    return output;
  } catch {
    return [];
  }
}

function workspaceLabel() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return '';
  }
  return folders.map((folder) => folder.name).join(', ');
}

class ContextTracker {
  constructor() {
    this.recentlyViewed = new Map();
    this.snapshots = new Map();
    this.skipSnapshots = new Set();
    this.recentEdits = [];
    this.diagnosticsByFile = new Map();
    this.pendingSuggestion = undefined;
    this.rejectedSuggestions = [];
    this.disposables = [
      vscode.window.onDidChangeActiveTextEditor((editor) => this.trackEditor(editor)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => this.trackEditor(editor))),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => this.trackEditor(event.textEditor)),
      vscode.window.onDidChangeTextEditorSelection((event) => this.trackEditor(event.textEditor)),
      vscode.workspace.onDidChangeTextDocument((event) => this.recordEdits(event)),
      vscode.workspace.onDidOpenTextDocument((document) => this.trackDocument(document)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const key = document.uri.toString();
        this.snapshots.delete(key);
        this.skipSnapshots.delete(key);
        this.recentlyViewed.delete(key);
      }),
      vscode.languages.onDidChangeDiagnostics((event) => this.recordDiagnostics(event))
    ];
    for (const editor of vscode.window.visibleTextEditors) {
      this.trackEditor(editor);
    }
    if (vscode.window.activeTextEditor) {
      this.trackEditor(vscode.window.activeTextEditor);
    }
  }

  dispose() {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        // The listener may already be disposed with the extension host.
      }
    }
    this.disposables = [];
    this.recentlyViewed.clear();
    this.snapshots.clear();
    this.skipSnapshots.clear();
    this.recentEdits = [];
    this.diagnosticsByFile.clear();
    this.pendingSuggestion = undefined;
    this.rejectedSuggestions = [];
  }

  rememberSnapshot(key, text) {
    if (text.length > MAX_SNAPSHOT_CHARS) {
      this.snapshots.delete(key);
      this.skipSnapshots.add(key);
      return;
    }
    this.skipSnapshots.delete(key);
    this.snapshots.delete(key);
    this.snapshots.set(key, text);
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const first = this.snapshots.keys().next().value;
      this.snapshots.delete(first);
    }
  }

  trackDocument(document) {
    if (!document || !isTrackableDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    if (!this.snapshots.has(key) && !this.skipSnapshots.has(key)) {
      this.rememberSnapshot(key, document.getText());
    }
  }

  trackEditor(editor) {
    if (!editor || !editor.document) {
      return;
    }
    const document = editor.document;
    if (!isTrackableDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    const now = Date.now();
    if (!this.snapshots.has(key) && !this.skipSnapshots.has(key)) {
      this.rememberSnapshot(key, document.getText());
    }
    const existing = this.recentlyViewed.get(key);
    if (existing && now - existing.lastTrackedAt < 250) {
      existing.lastViewedAt = now;
      existing.visibleRanges = inclusiveVisibleRanges(editor);
      existing.isVisible = true;
      return;
    }
    this.recentlyViewed.delete(key);
    this.recentlyViewed.set(key, {
      uri: document.uri,
      document,
      relativePath: relativePath(document.uri),
      languageId: document.languageId,
      visibleRanges: inclusiveVisibleRanges(editor),
      lastViewedAt: now,
      lastTrackedAt: now,
      isVisible: true
    });
    if (this.recentlyViewed.size > MAX_TRACKED_FILES) {
      const oldest = this.recentlyViewed.keys().next().value;
      this.recentlyViewed.delete(oldest);
    }
  }

  recordEdits(event) {
    const document = event.document;
    if (!isTrackableDocument(document)) {
      return;
    }
    const key = document.uri.toString();
    const now = Date.now();
    let previous = this.snapshots.get(key);
    if (previous === undefined && !this.skipSnapshots.has(key)) {
      previous = document.getText();
      this.rememberSnapshot(key, previous);
    }

    const rawChanges = event.contentChanges.slice(0, MAX_EDITS_PER_ENTRY);
    const changes = rawChanges.map((change) => {
      let removed = '';
      // VS Code's change event only carries the replacement text; slice the deleted
      // range out of our pre-edit snapshot so the prompt can show both "-" and "+".
      if (
        previous !== undefined &&
        typeof change.rangeOffset === 'number' &&
        change.rangeOffset >= 0 &&
        change.rangeOffset + (change.rangeLength || 0) <= previous.length
      ) {
        removed = previous.slice(change.rangeOffset, change.rangeOffset + (change.rangeLength || 0));
      }
      return {
        line: change.range.start.line + 1,
        column: change.range.start.character + 1,
        removed: truncate(normalizeLineEndings(removed), MAX_EDIT_TEXT),
        inserted: truncate(normalizeLineEndings(change.text), MAX_EDIT_TEXT)
      };
    });

    if (previous !== undefined) {
      const next = applyContentChanges(previous, event.contentChanges);
      if (next !== undefined) {
        this.rememberSnapshot(key, next);
      } else {
        this.snapshots.delete(key);
      }
    }

    if (changes.length === 0) {
      return;
    }
    // Coalesce rapid keystrokes in the same file into a single edit entry so a burst
    // of typing doesn't push older cross-file edits out of the history window.
    const last = this.recentEdits[0];
    if (last && last.key === key && now - last.timestamp < COALESCE_MS) {
      last.changes.push(...changes);
      if (last.changes.length > MAX_EDITS_PER_ENTRY) {
        last.changes = last.changes.slice(-MAX_EDITS_PER_ENTRY);
      }
      last.timestamp = now;
    } else {
      this.recentEdits.unshift({
        key,
        relativePath: relativePath(document.uri),
        languageId: document.languageId,
        timestamp: now,
        changes
      });
      if (this.recentEdits.length > MAX_RECENT_EDITS) {
        this.recentEdits.length = MAX_RECENT_EDITS;
      }
    }
    if (this.pendingSuggestion && this.pendingSuggestion.uri === key) {
      this.pendingSuggestion.changed = true;
    }
  }

  recordDiagnostics(event) {
    const now = Date.now();
    for (const uri of event.uris) {
      if (!isTrackableScheme(uri)) {
        continue;
      }
      if (uri.scheme !== 'untitled' && !vscode.workspace.getWorkspaceFolder(uri)) {
        continue;
      }
      const diagnostics = vscode.languages.getDiagnostics(uri)
        .filter((diagnostic) => (
          diagnostic.severity === vscode.DiagnosticSeverity.Error ||
          diagnostic.severity === vscode.DiagnosticSeverity.Warning
        ))
        .slice(0, 20)
        .map((diagnostic) => ({
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity: diagnostic.severity === vscode.DiagnosticSeverity.Error ? 'ERROR' : 'WARNING',
          message: truncate(diagnostic.message, 200)
        }));
      if (diagnostics.length === 0) {
        this.diagnosticsByFile.delete(uri.toString());
      } else {
        this.diagnosticsByFile.set(uri.toString(), {
          uri,
          relativePath: relativePath(uri),
          at: now,
          diagnostics
        });
      }
    }
    if (this.diagnosticsByFile.size > 30) {
      const entries = [...this.diagnosticsByFile.entries()].sort((a, b) => b[1].at - a[1].at);
      for (const [key] of entries.slice(30)) {
        this.diagnosticsByFile.delete(key);
      }
    }
  }

  getRecentlyViewed(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_VIEW_AGE_MS;
    const limit = options.limit ?? 10;
    const exclude = options.excludeUri ? options.excludeUri.toString() : undefined;
    const cutoff = Date.now() - maxAgeMs;
    return [...this.recentlyViewed.values()]
      .filter((entry) => entry.lastViewedAt >= cutoff && entry.uri.toString() !== exclude)
      .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
      .slice(0, limit);
  }

  getRecentEdits(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_VIEW_AGE_MS;
    const limit = options.limit ?? 20;
    const exclude = options.excludeUri ? options.excludeUri.toString() : undefined;
    const cutoff = Date.now() - maxAgeMs;
    return this.recentEdits
      .filter((entry) => entry.timestamp >= cutoff && entry.key !== exclude)
      .slice(0, limit);
  }

  getRecentDiagnostics(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_VIEW_AGE_MS;
    const limit = options.limit ?? 6;
    const exclude = options.excludeUri ? options.excludeUri.toString() : undefined;
    const cutoff = Date.now() - maxAgeMs;
    return [...this.diagnosticsByFile.values()]
      .filter((entry) => entry.at >= cutoff && entry.uri.toString() !== exclude)
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  beginRequest() {
    const pending = this.pendingSuggestion;
    this.pendingSuggestion = undefined;
    // VS Code doesn't fire an explicit "inline suggestion rejected" event. If a suggestion
    // stayed on screen long enough to be seen (>= 400ms) and the user kept typing without
    // triggering our acceptance command, treat it as rejected so we don't offer it again.
    if (!pending || pending.accepted || !pending.changed || Date.now() - pending.shownAt < 400) {
      return;
    }
    this.rejectedSuggestions.unshift({
      text: truncate(pending.text, 160),
      at: Date.now()
    });
    this.rejectedSuggestions = this.rejectedSuggestions.slice(0, 5);
  }

  recordSuggestion(requestId, document, position, text) {
    const pending = this.pendingSuggestion;
    if (pending && !pending.accepted && pending.changed && Date.now() - pending.shownAt >= 400) {
      this.rejectedSuggestions.unshift({
        text: truncate(pending.text, 160),
        at: Date.now()
      });
      this.rejectedSuggestions = this.rejectedSuggestions.slice(0, 5);
    }
    this.pendingSuggestion = {
      requestId,
      uri: document.uri.toString(),
      position: { line: position.line + 1, column: position.character + 1 },
      text,
      accepted: false,
      changed: false,
      shownAt: Date.now()
    };
  }

  recordAcceptance(requestId) {
    const pending = this.pendingSuggestion;
    if (pending && pending.requestId === requestId) {
      pending.accepted = true;
      this.pendingSuggestion = undefined;
    }
  }

  getRejectedSuggestions(limit = 3) {
    return this.rejectedSuggestions.slice(0, limit);
  }
}

async function gatherTabContext(document, position, tracker, options = {}) {
  if (!document || !tracker) {
    return undefined;
  }
  const signal = options.signal;
  const cursorLine = position.line + 1;
  const cursorColumn = position.character + 1;
  const currentFile = {
    relativePath: relativePath(document.uri),
    languageId: document.languageId,
    lineCount: document.lineCount,
    eol: document.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
    cursor: { line: cursorLine, column: cursorColumn }
  };
  const activeEditor = vscode.window.activeTextEditor;
  if (
    activeEditor &&
    activeEditor.document.uri.toString() === document.uri.toString() &&
    activeEditor.selection &&
    !activeEditor.selection.isEmpty
  ) {
    currentFile.selection = {
      startLine: activeEditor.selection.start.line + 1,
      startColumn: activeEditor.selection.start.character + 1,
      endLine: activeEditor.selection.end.line + 1,
      endColumn: activeEditor.selection.end.character + 1
    };
  }

  const diagnostics = options.includeDiagnostics === false
    ? []
    : nearbyDiagnostics(document, cursorLine, 10);
  const recentEdits = options.includeEditHistory === false
    ? []
    : tracker.getRecentEdits({ limit: 20 });
  const otherDiagnostics = options.includeDiagnostics === false
    ? []
    : tracker.getRecentDiagnostics({ limit: 5, excludeUri: document.uri });

  const visibleFiles = vscode.window.visibleTextEditors
    .filter((editor) => editor.document.uri.toString() !== document.uri.toString())
    .filter((editor) => isTrackableDocument(editor.document))
    .map((editor) => ({
      uri: editor.document.uri,
      document: editor.document,
      relativePath: relativePath(editor.document.uri),
      languageId: editor.document.languageId,
      isOpen: true,
      lastViewedAt: Date.now(),
      visibleRanges: inclusiveVisibleRanges(editor)
    }));
  const visibleKeys = new Set(visibleFiles.map((entry) => entry.uri.toString()));
  const recentlyViewed = options.includeRecentlyViewed === false
    ? []
    : tracker.getRecentlyViewed({
      limit: options.maxFiles ?? 6,
      excludeUri: document.uri
    }).filter((entry) => !visibleKeys.has(entry.uri.toString()));

  const selectedFiles = [...visibleFiles, ...recentlyViewed].slice(0, options.maxFiles ?? 6);
  const fileSnippets = await Promise.all(selectedFiles.map(async (entry) => {
    if (signal && signal.aborted) {
      return undefined;
    }
    let fileDocument = entry.document;
    if (!fileDocument || fileDocument.isClosed) {
      fileDocument = await withTimeout(vscode.workspace.openTextDocument(entry.uri), 150, undefined);
    }
    if (!fileDocument || fileDocument.isClosed) {
      return undefined;
    }
    const snippet = snippetFromDocument(fileDocument, entry.visibleRanges, {
      maxChars: options.fileMaxChars ?? 2500,
      lineMaxChars: options.lineMaxChars ?? MAX_LINE_CHARS,
      maxLines: options.maxLines ?? MAX_SNIPPET_LINES
    });
    if (!snippet) {
      return undefined;
    }
    return {
      relativePath: entry.relativePath,
      languageId: entry.languageId,
      isOpen: entry.isOpen === true,
      lastViewedAt: entry.lastViewedAt,
      visibleRanges: entry.visibleRanges,
      snippet
    };
  }));

  const [signatureHelp, completionItems] = await Promise.all([
    options.includeSignatureHelp === false
      ? undefined
      : signatureHelpFor(document, position, options.signatureTimeoutMs ?? 100),
    options.includeCompletions === false
      ? []
      : completionItemsFor(
        document,
        position,
        options.completionTimeoutMs ?? 100,
        options.maxCompletionItems ?? 20
      )
  ]);

  if (signal && signal.aborted) {
    return undefined;
  }

  return {
    workspace: workspaceLabel(),
    currentFile,
    diagnostics,
    otherDiagnostics,
    recentEdits,
    signatureHelp,
    completionItems,
    otherFiles: fileSnippets.filter(Boolean),
    rejectedSuggestions: tracker.getRejectedSuggestions(3),
    trigger: options.trigger || 'automatic'
  };
}

function formatTabContext(context, options = {}) {
  if (!context) {
    return '';
  }
  const maxChars = options.maxChars ?? 8000;
  if (maxChars <= 0) {
    return '';
  }

  const sections = [];
  const header = [];
  if (context.workspace) {
    header.push(`Workspace: ${context.workspace}`);
  }
  if (context.currentFile) {
    header.push(
      `Current file: ${context.currentFile.relativePath} ` +
      `(${context.currentFile.languageId}, ${context.currentFile.lineCount} lines, ${context.currentFile.eol})`
    );
    header.push(`Cursor: line ${context.currentFile.cursor.line}, column ${context.currentFile.cursor.column}`);
    if (context.currentFile.selection) {
      const selection = context.currentFile.selection;
      header.push(
        `Selection: ${selection.startLine}:${selection.startColumn}-` +
        `${selection.endLine}:${selection.endColumn}`
      );
    }
  }
  if (context.trigger) {
    header.push(`Trigger: ${context.trigger}`);
  }
  sections.push({ text: header.join('\n'), priority: 0 });

  if (context.diagnostics && context.diagnostics.length > 0) {
    sections.push({
      text: `Diagnostics near cursor:\n${context.diagnostics
        .map((diagnostic) => `- ${diagnostic.severity} line ${diagnostic.line}: ${diagnostic.message}`)
        .join('\n')}`,
      priority: 1
    });
  }

  if (context.otherDiagnostics && context.otherDiagnostics.length > 0) {
    const lines = [];
    for (const entry of context.otherDiagnostics) {
      for (const diagnostic of entry.diagnostics) {
        lines.push(`- ${entry.relativePath}:${diagnostic.line} ${diagnostic.severity}: ${diagnostic.message}`);
      }
    }
    if (lines.length > 0) {
      sections.push({ text: `Other diagnostics:\n${lines.slice(0, 20).join('\n')}`, priority: 2 });
    }
  }

  if (context.signatureHelp) {
    const signature = context.signatureHelp;
    const active = signature.activeParameter ? ` (parameter: ${signature.activeParameter})` : '';
    const documentation = signature.documentation ? `\n  ${signature.documentation}` : '';
    sections.push({
      text: `Signature help:\n- ${signature.label}${active}${documentation}`,
      priority: 3
    });
  }

  if (context.recentEdits && context.recentEdits.length > 0) {
    const lines = [];
    for (const entry of context.recentEdits) {
      for (const change of entry.changes) {
        const removed = change.removed ? `- ${change.removed}` : '';
        const inserted = change.inserted ? `+ ${change.inserted}` : '';
        lines.push(`- ${entry.relativePath}:${change.line}:${change.column} ${removed} ${inserted}`.trim());
      }
    }
    if (lines.length > 0) {
      sections.push({ text: `Recent edits:\n${lines.slice(0, 30).join('\n')}`, priority: 4 });
    }
  }

  if (context.otherFiles && context.otherFiles.length > 0) {
    const open = context.otherFiles.filter((file) => file.isOpen);
    const recent = context.otherFiles.filter((file) => !file.isOpen);
    const formatFile = (file) => {
      const ranges = file.visibleRanges && file.visibleRanges.length > 0
        ? file.visibleRanges.map((range) => `${range.startLine}-${range.endLine}`).join(', ')
        : 'visible range';
      return `- ${file.relativePath} (${file.languageId}) lines ${ranges}:\n${file.snippet}`;
    };
    let text = '';
    if (open.length > 0) {
      text += `Open files:\n${open.map(formatFile).join('\n')}`;
    }
    if (recent.length > 0) {
      if (text) {
        text += '\n';
      }
      text += `Recently viewed files:\n${recent.map(formatFile).join('\n')}`;
    }
    if (text) {
      sections.push({ text, priority: 5 });
    }
  }

  if (context.completionItems && context.completionItems.length > 0) {
    sections.push({
      text: `Local completion candidates:\n${context.completionItems
        .slice(0, 20)
        .map((item) => `- ${item.label}${item.detail ? ` (${item.detail})` : ''}`)
        .join('\n')}`,
      priority: 6
    });
  }

  if (context.rejectedSuggestions && context.rejectedSuggestions.length > 0) {
    sections.push({
      text: `Recently rejected completions (do not repeat exactly):\n${context.rejectedSuggestions
        .map((suggestion) => `- ${suggestion.text}`)
        .join('\n')}`,
      priority: 7
    });
  }

  // Pack sections in priority order (current file metadata and local diagnostics first,
  // peripheral files and completion candidates later) until maxChars is reached.
  const parts = [];
  let total = 0;
  for (const section of sections.sort((a, b) => a.priority - b.priority)) {
    if (!section.text) {
      continue;
    }
    const separator = parts.length > 0 ? 2 : 0;
    const remaining = maxChars - total - separator;
    if (remaining <= 0) {
      break;
    }
    const text = section.text.length <= remaining
      ? section.text
      : `${section.text.slice(0, Math.max(0, remaining - 3))}...`;
    parts.push(text);
    total += text.length + separator;
    if (text.length < section.text.length) {
      break;
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return `<tab_context>\n${parts.join('\n\n')}\n</tab_context>`;
}

module.exports = {
  ContextTracker,
  gatherTabContext,
  formatTabContext,
  _truncate: truncate,
  _nearbyDiagnostics: nearbyDiagnostics
};
