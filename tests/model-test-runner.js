/* Runs tests/model-test.cjs in a browser, for computers without Node.js.
 * Only node:assert/strict, node:fs and node:vm are imitated, as far as that test file uses them.
 * serve.py's CSP forbids eval, so open this page from a plain static server (see model-test.html). */
(async () => {
  'use strict';
  const out = document.getElementById('out');
  const print = line => { out.textContent += line + '\n'; };
  const files = {};
  for (const path of ['tests/model-test.cjs', 'model.js', 'engine-worker.js']) {
    const response = await fetch('../' + path, { cache: 'no-store' });
    if (!response.ok) { print(`✗ ${path}을(를) 읽지 못했습니다 (${response.status}).`); return; }
    files[path] = await response.text();
  }
  const same = (a, b) => {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || !a || !b || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && same(a[k], b[k]));
  };
  const assert = {
    equal(a, b, message) { if (!Object.is(a, b)) throw new Error(message || `${a} !== ${b}`); },
    ok(value, message) { if (!value) throw new Error(message || 'ok 실패'); },
    deepEqual(a, b, message) { if (!same(a, b)) throw new Error(message || `deepEqual 실패: ${JSON.stringify(a)} / ${JSON.stringify(b)}`); },
    throws(fn, pattern) {
      try { fn(); } catch (error) { if (pattern && !pattern.test(error.message)) throw new Error(`다른 오류: ${error.message}`); return; }
      throw new Error(`오류가 나지 않음: ${pattern}`);
    }
  };
  // vm: each context is a hidden iframe. The first script runs as a <script> so its let/const stay
  // global (as in Node); later snippets use the iframe's indirect eval to read them and return values.
  const vm = {
    createContext(globals) {
      const frame = document.createElement('iframe'); frame.hidden = true; document.body.append(frame);
      const win = frame.contentWindow; Object.assign(win, globals); let runs = 0;
      return new Proxy({}, { get: (_, key) => key === '__win' ? win : key === '__runs' ? runs++ : win[key], set: (_, key, value) => { win[key] = value; return true; } });
    },
    runInContext(code, context) {
      const win = context.__win;
      if (context.__runs === 0) { const script = win.document.createElement('script'); script.textContent = code; win.document.head.append(script); return undefined; }
      return win.eval(code);
    }
  };
  const require = name => {
    if (name === 'node:assert/strict') return assert;
    if (name === 'node:fs') return { readFileSync: path => files[path] };
    if (name === 'node:vm') return vm;
    if (name === '../model.js') { new Function(files['model.js'])(); return {}; }
    throw new Error(`지원하지 않는 require: ${name}`);
  };
  require.resolve = path => ({ '../engine-worker.js': 'engine-worker.js' })[path];
  const source = files['tests/model-test.cjs'].replace(
    'function test(name, fn) { fn(); count++; console.log(`✓ ${name}`); }',
    'function test(name, fn) { try { fn(); count++; console.log(`✓ ${name}`); } catch (e) { failed++; console.log(`✗ ${name}\\n    ${e.message}`); } }\nlet failed = 0;'
  ).replace('console.log(`\\n${count} model tests passed.`);', 'console.log(`\\n${count} passed, ${failed} failed.`); document.title = failed ? "FAIL" : "PASS";');
  try { new Function('require', 'console', source)(require, { log: (...parts) => print(parts.join(' ')) }); }
  catch (error) { print(`✗ 실행 중단: ${error.message}`); document.title = 'FAIL'; }
})();
