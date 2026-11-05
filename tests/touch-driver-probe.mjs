// Standalone, neutral HTML only. Run from the repo: node tests/touch-driver-probe.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(process.argv[2] || process.cwd());
const reportPath = resolve(process.argv[3] || join(process.env.RUNNER_TEMP || tmpdir(), 'hghub-touch-driver-report.json'));
const { chromium } = createRequire(join(repo, 'package.json'))('@playwright/test');
const report = { generatedAt: new Date().toISOString(), cases: [] };
const observe = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const frame = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));

const html = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:sans-serif}
#drag{position:absolute;left:14px;top:430px;width:362px;height:44px;background:#8ac;touch-action:none;user-select:none}
#target{position:absolute;left:205px;top:500px;width:120px;height:44px}
</style></head><body><div id="drag">Drag surface</div><button id="target">Tap target</button></body></html>`;

async function setup(page, explicitCapture) {
  await page.setContent(html);
  await page.evaluate((capture) => {
    const drag = document.getElementById('drag');
    const target = document.getElementById('target');
    window.probe = { stage: 'setup', clicks: 0, events: [] };
    target.addEventListener('click', () => { window.probe.clicks += 1; });
    // "No handler" leaves the browser's normal implicit touch capture untouched.
    if (capture) {
      drag.addEventListener('pointerdown', (event) => drag.setPointerCapture(event.pointerId));
      drag.addEventListener('pointerup', (event) => {
        if (drag.hasPointerCapture(event.pointerId)) drag.releasePointerCapture(event.pointerId);
      });
    }
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
      'touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(type, (event) => {
        const entry = {
          stage: window.probe.stage, type, time: Math.round(performance.now()),
          target: event.target.id || event.target.tagName,
          trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
          pointerType: event.pointerType, pointerId: event.pointerId, isPrimary: event.isPrimary,
          button: event.button, buttons: event.buttons,
          x: event.clientX, y: event.clientY,
          capturedByDrag: typeof event.pointerId === 'number' && drag.hasPointerCapture(event.pointerId),
          touchMouse: event.sourceCapabilities?.firesTouchEvents,
          changedTouches: [...(event.changedTouches || [])].map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY })),
        };
        window.probe.events.push(entry);
        setTimeout(() => { entry.defaultPreventedAfterDispatch = event.defaultPrevented; }, 0);
      }, { capture: true, passive: true });
    }
  }, explicitCapture);
}

const finger = (point, id) => ({ ...point, id, radiusX: 1, radiusY: 1, force: 1 });
async function rawTap(page, cdp, point, id) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(point, id)] });
  await frame(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function rawDrag(page, cdp, start, end, id) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(start, id)] });
  for (let step = 1; step <= 8; step += 1) {
    const fraction = step / 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger({
      x: start.x + (end.x - start.x) * fraction,
      y: start.y + (end.y - start.y) * fraction,
    }, id)] });
    await frame(page);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
async function phase(page, name, action, observationMs = 500) {
  const before = await page.evaluate((stage) => { window.probe.stage = stage; return window.probe.clicks; }, name);
  await action();
  // Include delayed browser compatibility clicks without retrying or changing state.
  await observe(observationMs);
  return page.evaluate(({ name, before }) => {
    const events = window.probe.events.filter((event) => event.stage === name);
    return { name, clicksBefore: before, clicksAfter: window.probe.clicks,
      types: events.map((event) => `${event.type}@${event.target}`), events,
      maxTouchPoints: navigator.maxTouchPoints, coarse: matchMedia('(pointer: coarse)').matches };
  }, { name, before });
}

const cases = [
  { name: 'raw-id1-no-handler', id: 1, capture: false },
  { name: 'raw-id1-explicit-capture', id: 1, capture: true },
  { name: 'raw-id1-immediate-no-handler', id: 1, capture: false, immediate: true },
  { name: 'raw-id1-immediate-capture', id: 1, capture: true, immediate: true },
];

for (const engine of [{ name: 'headless-shell', options: {} }, { name: 'chromium-new-headless', options: { channel: 'chromium' } }]) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 8000, ...engine.options });
    for (const variant of cases) {
      const result = { engine: engine.name, version: browser.version(), case: variant.name, phases: [] };
      report.cases.push(result);
      const context = await browser.newContext({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true });
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      try {
        await setup(page, variant.capture);
        const button = { x: 265, y: 522 };
        const start = { x: 68.3, y: 452 };
        result.hitTargets = await page.evaluate(({ button, start }) => ({
          button: document.elementFromPoint(button.x, button.y)?.id,
          drag: document.elementFromPoint(start.x, start.y)?.id,
        }), { button, start });
        result.phases.push(await phase(page, 'baseline', () => rawTap(page, cdp, button, variant.id)));
        result.phases.push(await phase(page, 'drag', () => rawDrag(page, cdp, start, button, variant.id), variant.immediate ? 0 : 500));
        result.phases.push(await phase(page, 'after-drag', () => rawTap(page, cdp, button, variant.id)));
      } catch (error) {
        result.error = String(error.stack || error);
        result.partial = await page.evaluate(() => window.probe).catch(() => null);
        process.exitCode = 1;
      } finally {
        await context.close();
      }
      console.log(JSON.stringify({ ...result, phases: result.phases.map(({ events, ...summary }) => summary) }));
    }
  } catch (error) {
    report.cases.push({ engine: engine.name, error: String(error.stack || error) });
    console.error(`[${engine.name}] ${error.message}`);
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(`Detailed report: ${reportPath}`);
