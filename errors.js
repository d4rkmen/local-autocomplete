'use strict';

class AutocompleteError extends Error {
  constructor({ kind, title, detail, hint, actions, key }) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'AutocompleteError';
    this.kind = kind;
    this.title = title;
    this.detail = detail || '';
    this.hint = hint || '';
    this.actions = actions || ['showLog'];
    this.key = key || `${kind}:${title}`;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull a readable error message out of whatever JSON shape the upstream uses
// (OpenAI `{ error: { message } }`, FastAPI/vLLM `{ detail }`, or an HTML proxy page).
function serverMessage(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) {
    return '';
  }
  try {
    const data = JSON.parse(text);
    const error = data && data.error;
    if (typeof error === 'string') {
      return error;
    }
    if (error && typeof error.message === 'string') {
      return error.code ? `${error.message} (${error.code})` : error.message;
    }
    if (typeof data.message === 'string') {
      return data.message;
    }
    if (typeof data.detail === 'string') {
      return data.detail;
    }
    if (Array.isArray(data.detail) && data.detail[0] && typeof data.detail[0].msg === 'string') {
      return data.detail[0].msg;
    }
  } catch {
    // Not JSON; fall through to plain text.
  }
  return stripHtml(text).slice(0, 300);
}

function mentionsModel(message) {
  const text = String(message || '');
  return /model/i.test(text) &&
    /(not found|does not exist|doesn't exist|invalid|unknown|unsupported|not supported|no such|not available|not allowed|not permitted|no access)/i.test(text);
}

function httpError({ status, statusText, url, body, retryAfter, model, apiKeySource }) {
  const message = serverMessage(body);
  const host = hostOf(url);
  const statusLabel = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  const detail = message ? `${statusLabel} from ${host}: ${message}` : `${statusLabel} from ${host}`;
  const keyFrom = apiKeySource === 'cursor'
    ? 'the Cursor Private Inference API key'
    : apiKeySource === 'setting'
      ? 'localAutocomplete.apiKey'
      : 'no API key';

  if (status === 401 || status === 403) {
    return new AutocompleteError({
      kind: 'auth',
      title: `Authentication failed (${status})`,
      detail,
      hint: `The server rejected ${keyFrom}. Set a valid key in localAutocomplete.apiKey, or update the key in Cursor Settings -> Models -> Gateway.`,
      actions: ['setApiKey', 'showLog'],
      key: `auth:${status}`
    });
  }
  if (status === 404) {
    if (mentionsModel(message)) {
      return new AutocompleteError({
        kind: 'model',
        title: `Model not found: ${model || 'unknown'}`,
        detail,
        hint: 'Pick a model the server lists in /v1/models.',
        actions: ['selectModel', 'showLog'],
        key: `model404:${model}`
      });
    }
    return new AutocompleteError({
      kind: 'endpoint',
      title: 'Endpoint not found (404)',
      detail,
      hint: `Check the base URL; it must point at an OpenAI-compatible API and usually ends with /v1 (requested ${url}).`,
      actions: ['setBaseUrl', 'showLog'],
      key: `endpoint404:${host}`
    });
  }
  if (status === 400 || status === 422) {
    return new AutocompleteError({
      kind: mentionsModel(message) ? 'model' : 'request',
      title: `Request rejected (${status})`,
      detail,
      hint: mentionsModel(message)
        ? `The server rejected model "${model}". Pick another model.`
        : 'The server rejected the request. If this model does not support chat completions, switch localAutocomplete.mode or pick another model.',
      actions: mentionsModel(message) ? ['selectModel', 'showLog'] : ['selectModel', 'openSettings', 'showLog'],
      key: `request${status}:${model}`
    });
  }
  if (status === 408 || status === 504) {
    return new AutocompleteError({
      kind: 'timeout',
      title: `Server timed out (${status})`,
      detail,
      hint: 'The model is too slow for inline completion. Pick a faster model or raise localAutocomplete.timeoutMs.',
      actions: ['selectModel', 'openSettings', 'showLog'],
      key: `timeout${status}`
    });
  }
  if (status === 429) {
    return new AutocompleteError({
      kind: 'rateLimit',
      title: 'Rate limited (429)',
      detail: retryAfter ? `${detail} (retry after ${retryAfter}s)` : detail,
      hint: 'The gateway is throttling requests. Raise localAutocomplete.debounceMs to send fewer requests, or wait and retry.',
      actions: ['openSettings', 'showLog'],
      key: 'rateLimit'
    });
  }
  if (status >= 500) {
    return new AutocompleteError({
      kind: 'server',
      title: `Server error (${status})`,
      detail,
      hint: `${host} failed to handle the request. The gateway or model provider may be down; try again later or pick another model.`,
      actions: ['selectModel', 'showLog'],
      key: `server${status}:${model}`
    });
  }
  return new AutocompleteError({
    kind: 'http',
    title: `Unexpected response (${status})`,
    detail,
    hint: 'See the log for the full response.',
    actions: ['showLog'],
    key: `http${status}`
  });
}

function networkError(error, { url, timedOut, timeoutMs }) {
  const host = hostOf(url);
  if (timedOut) {
    return new AutocompleteError({
      kind: 'timeout',
      title: `No response within ${timeoutMs} ms`,
      detail: `Request to ${host} timed out.`,
      hint: 'Pick a faster model or raise localAutocomplete.timeoutMs.',
      actions: ['selectModel', 'openSettings', 'showLog'],
      key: 'timeout:client'
    });
  }
  const cause = error && error.cause ? error.cause : error;
  const code = (cause && (cause.code || cause.errno)) || '';
  const message = (cause && cause.message) || (error && error.message) || String(error);
  let title = `Cannot reach ${host}`;
  let hint = 'Check the base URL and your network connection.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    hint = `The host name ${host} could not be resolved. Check the base URL and DNS/VPN.`;
  } else if (code === 'ECONNREFUSED') {
    hint = `Nothing is listening at ${host}. Start the server or fix the base URL.`;
  } else if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    hint = `The connection to ${host} was dropped. Check proxies/VPN and try again.`;
  } else if (/CERT|SSL|TLS/i.test(String(code)) || /certificate/i.test(message)) {
    title = `TLS error talking to ${host}`;
    hint = 'The server certificate was rejected. Check the URL scheme (http vs https) and certificate.';
  }
  return new AutocompleteError({
    kind: 'network',
    title,
    detail: code ? `${message} (${code})` : message,
    hint,
    actions: ['setBaseUrl', 'showLog'],
    key: `network:${host}:${code}`
  });
}

function invalidJsonError({ url, body }) {
  return new AutocompleteError({
    kind: 'response',
    title: 'Server did not return JSON',
    detail: `${hostOf(url)} replied: ${stripHtml(body).slice(0, 200) || '(empty body)'}`,
    hint: 'The base URL probably points at a web page or proxy instead of an OpenAI-compatible API. It usually ends with /v1.',
    actions: ['setBaseUrl', 'showLog'],
    key: `json:${hostOf(url)}`
  });
}

function responseBodyError({ url, data, model }) {
  const message = serverMessage(JSON.stringify(data));
  return new AutocompleteError({
    kind: mentionsModel(message) ? 'model' : 'server',
    title: 'Server returned an error',
    detail: `${hostOf(url)}: ${message}`,
    hint: mentionsModel(message) ? `The server rejected model "${model}". Pick another model.` : 'See the log for the full response.',
    actions: mentionsModel(message) ? ['selectModel', 'showLog'] : ['showLog'],
    key: `body:${model}:${message.slice(0, 60)}`
  });
}

// Diagnose why a 200 OK completion response produced no insertable code.
// The most common culprit is pointing autocomplete at a thinking/reasoning model with a
// small maxTokens budget: the model spends all 256 tokens inside reasoning_content and
// hits finish_reason="length" before emitting any actual code.
function emptyAnswerError({ model, finishReason, reasoningTokens, reasoningChars, maxTokens, shape }) {
  const usedReasoning = (Number(reasoningTokens) || 0) > 0 || (Number(reasoningChars) || 0) > 0;
  if (finishReason === 'length' && usedReasoning) {
    return new AutocompleteError({
      kind: 'emptyAnswer',
      title: `${model} spent its whole token budget on reasoning`,
      detail: shape,
      hint: `It is a reasoning model and returned no code within maxTokens (${maxTokens}). Pick a non-reasoning model for autocomplete, or raise localAutocomplete.maxTokens.`,
      actions: ['selectModel', 'openSettings', 'showLog'],
      key: `reasoning:${model}`
    });
  }
  if (finishReason === 'length') {
    return new AutocompleteError({
      kind: 'emptyAnswer',
      title: `${model} hit maxTokens before answering`,
      detail: shape,
      hint: `Raise localAutocomplete.maxTokens (currently ${maxTokens}) or pick another model.`,
      actions: ['openSettings', 'selectModel', 'showLog'],
      key: `length:${model}`
    });
  }
  if (usedReasoning) {
    return new AutocompleteError({
      kind: 'emptyAnswer',
      title: `${model} returned reasoning but no code`,
      detail: shape,
      hint: 'Reasoning models are a poor fit for inline completion. Pick a non-reasoning (chat or coder) model.',
      actions: ['selectModel', 'showLog'],
      key: `reasoningOnly:${model}`
    });
  }
  return new AutocompleteError({
    kind: 'emptyAnswer',
    title: `${model} keeps returning empty answers`,
    detail: shape,
    hint: 'The request succeeds but the model returns no text. Try another model, or switch localAutocomplete.mode.',
    actions: ['selectModel', 'openSettings', 'showLog'],
    key: `empty:${model}`
  });
}

function configError(message, actions) {
  return new AutocompleteError({
    kind: 'config',
    title: message,
    hint: '',
    actions: actions || ['setBaseUrl', 'showLog'],
    key: `config:${message}`
  });
}

function toAutocompleteError(error) {
  if (error instanceof AutocompleteError) {
    return error;
  }
  const message = error && error.message ? error.message : String(error);
  return new AutocompleteError({
    kind: 'unknown',
    title: 'Completion failed',
    detail: message,
    hint: 'See the log for details.',
    actions: ['showLog'],
    key: `unknown:${message.slice(0, 80)}`
  });
}

module.exports = {
  AutocompleteError,
  httpError,
  networkError,
  invalidJsonError,
  responseBodyError,
  emptyAnswerError,
  configError,
  toAutocompleteError,
  serverMessage
};
