/**
 * KottyApi — shared thin API client (FE-2, docs/plans/04-frontend-best-practices.md).
 *
 * Usage: <script src="/public/js/api.js"></script> then
 *   KottyApi.apiGet('/some/endpoint').then(function (data) { ... });
 *
 * Behaviour:
 *   - always sends session cookies (credentials: 'same-origin')
 *   - sets JSON headers on POST bodies
 *   - redirects to /login on 401
 *   - throws Error with the server-provided message on !res.ok
 *   - parses and returns JSON (or null for empty/non-JSON responses)
 */
(function (global) {
  'use strict';

  function handleResponse(res) {
    if (res.status === 401) {
      global.location.href = '/login';
      return new Promise(function () {}); // never resolves; page is navigating away
    }
    var contentType = res.headers.get('content-type') || '';
    var isJson = contentType.indexOf('application/json') !== -1;
    var bodyPromise = isJson ? res.json().catch(function () { return null; }) : res.text();
    return bodyPromise.then(function (body) {
      if (!res.ok) {
        var message =
          (body && typeof body === 'object' && (body.error || body.message)) ||
          (typeof body === 'string' && body.slice(0, 200)) ||
          (res.status + ' ' + res.statusText);
        var err = new Error(message);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return isJson ? body : (body ? body : null);
    });
  }

  function request(url, options) {
    var opts = options || {};
    opts.credentials = opts.credentials || 'same-origin';
    return fetch(url, opts).then(handleResponse);
  }

  function apiGet(url) {
    return request(url, { method: 'GET', headers: { Accept: 'application/json' } });
  }

  function apiPost(url, body) {
    return request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body === undefined ? {} : body)
    });
  }

  function apiDelete(url) {
    return request(url, { method: 'DELETE', headers: { Accept: 'application/json' } });
  }

  global.KottyApi = { apiGet: apiGet, apiPost: apiPost, apiDelete: apiDelete, request: request };
})(window);
