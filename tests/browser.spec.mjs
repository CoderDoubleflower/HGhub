import { expect, test } from '@playwright/test';
import { access, baseURL, clipTitle, noLoginURL, platformPassword, postTitle, proxyURL } from './fixture-config.mjs';

const navigation = (page) => page.getByRole('navigation', { name: '主导航' });
async function tab(page, name) {
  await navigation(page).getByRole('button', { name, exact: true }).click();
  await expect(navigation(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
}
async function login(page) {
  await page.goto('/');
  await page.getByLabel('访问账号', { exact: true }).fill(access.username);
  await page.getByLabel('访问密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '进入 HGhub', exact: true }).click();
  await expect(navigation(page)).toBeVisible();
}
async function platformLogin(page, username) {
  await tab(page, '我的');
  await page.getByRole('textbox', { name: '平台账号', exact: true }).fill(username);
  const password = page.getByLabel('平台密码', { exact: true });
  await password.fill(platformPassword);
  await password.press('Enter');
  await expect(page.getByRole('button', { name: '退出平台账号', exact: true })).toBeVisible();
  await expect(page.getByText(`@${username} · ID ${username === 'alice' ? 11 : 12}`, { exact: true })).toBeVisible();
}
async function noHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1);
}
async function fixtureState(request) {
  const response = await request.get(`${proxyURL}/__fixture/state`);
  expect(response.ok()).toBeTruthy();
  return response.json();
}
async function localTrafficOnly(context) {
  await context.route(/^https?:\/\//, (route) => [baseURL, noLoginURL].includes(new URL(route.request().url()).origin)
    ? route.continue() : route.abort('blockedbyclient'));
}

async function mobileSliderBox(slider) {
  await expect(slider).toHaveAttribute('aria-disabled', 'false');
  await expect(slider).toHaveAttribute('aria-orientation', 'horizontal');
  // Wait for the context page's entrance animation before using viewport coordinates.
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  expect(box).not.toBeNull();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await slider.evaluate((element) => getComputedStyle(element).getPropertyValue('--sab').trim())).toBe('34px');
  const hits = await slider.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].flatMap((fraction) => [2, rect.height / 2, rect.height - 2].map((offset) => {
      const x = rect.left + rect.width * fraction;
      const y = rect.top + offset;
      return { x, y, hit: element.contains(document.elementFromPoint(x, y)) };
    }));
  });
  expect(hits.filter((point) => !point.hit), 'Every sampled point in the seek touch area must hit the slider').toEqual([]);
  return box;
}

async function touchSeek(page, cdp, video, slider, box, release) {
  await expect.poll(() => video.evaluate((element) => element.readyState >= 2
    && element.videoWidth > 0 && Number.isFinite(element.duration) && element.duration > 0), { timeout: 20_000 }).toBeTruthy();
  // A paused synthetic clip makes time changes attributable to the touch gesture.
  await video.evaluate((element) => { element.pause(); element.currentTime = element.duration * 0.1; });
  await expect.poll(() => video.evaluate((element) => element.paused && !element.seeking)).toBeTruthy();
  const before = await video.evaluate((element) => ({ time: element.currentTime, duration: element.duration, source: element.currentSrc }));
  await slider.evaluate((element) => {
    window.__seekTouches = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
      element.addEventListener(type, (event) => {
        window.__seekTouches.push({ type, pointerType: event.pointerType, trusted: event.isTrusted });
      }, { once: true, passive: true });
    }
  });
  const start = { x: box.x + box.width * 0.15, y: box.y + box.height / 2 };
  const finger = (point) => ({ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 });
  // CDP dispatches browser-level touch input, including real pointer capture and touch-action handling.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(start)] });
  for (let step = 1; step <= 8; step += 1) {
    const fraction = step / 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger({
      x: start.x + (release.x - start.x) * fraction,
      y: start.y + (release.y - start.y) * fraction,
    })] });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  expect(await page.evaluate(() => window.__seekTouches)).toEqual(
    ['pointerdown', 'pointermove', 'pointerup'].map((type) => ({ type, pointerType: 'touch', trusted: true })),
  );
  const target = (release.x - box.x) / box.width;
  await expect.poll(() => video.evaluate((element, fraction) => Math.abs(element.currentTime / element.duration - fraction), target)).toBeLessThan(0.04);
  await expect.poll(() => video.evaluate((element) => !element.seeking && element.readyState >= 2)).toBeTruthy();
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveJSProperty('currentSrc', before.source);
  expect(await video.evaluate((element) => element.currentTime)).toBeGreaterThan(before.time + before.duration * 0.25);
}

async function touchTap(page, cdp, target) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  const point = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return { x, y, hit: element.contains(document.elementFromPoint(x, y)) };
  });
  expect(point.hit, 'The real touch tap must hit the requested control').toBeTruthy();
  await target.evaluate((element) => {
    window.__mobileTapTrace = [];
    const controller = new AbortController();
    window.__stopMobileTapTrace = () => controller.abort();
    const record = (event, phase) => {
      const node = event.target;
      const entry = {
        type: event.type, phase, trusted: event.isTrusted,
        atTarget: node instanceof Node && element.contains(node),
        target: node instanceof Element ? `${node.tagName} ${node.getAttribute('aria-label') || node.textContent?.trim().slice(0, 60) || ''}` : String(node),
        pointerType: event.pointerType, pointerId: event.pointerId, isPrimary: event.isPrimary,
        defaultPrevented: event.defaultPrevented,
        capturedBySlider: typeof event.pointerId === 'number' && [...document.querySelectorAll('[role="slider"]')]
          .some((slider) => slider.hasPointerCapture(event.pointerId)),
        changedTouches: [...(event.changedTouches || [])].map((touch) => ({ id: touch.identifier, x: touch.clientX, y: touch.clientY })),
      };
      window.__mobileTapTrace.push(entry);
      // Record prevention by React even when it stops propagation before the document bubble phase.
      setTimeout(() => { entry.defaultPreventedAfterDispatch = event.defaultPrevented; }, 0);
    };
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture', 'touchstart', 'touchend', 'touchcancel', 'click']) {
      for (const capture of [true, false]) {
        document.addEventListener(type, (event) => record(event, capture ? 'capture' : 'bubble'),
          { capture, passive: true, signal: controller.signal });
      }
    }
  });
  try {
    // Keep taps on the same touch input session as dragging. Playwright's shortcut
    // sends start/end concurrently on its own session; a finger stays down for a frame.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [
      { x: point.x, y: point.y, id: 1, radiusX: 1, radiusY: 1, force: 1 },
    ] });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.evaluate(() => ['pointerdown', 'pointerup', 'click'].every((type) =>
      window.__mobileTapTrace.some((event) => event.type === type && event.trusted && event.atTarget
        && (type === 'click' || event.pointerType === 'touch')),
    )), { message: 'The control must receive trusted touch pointerdown/up and a real click' }).toBeTruthy();
  } finally {
    await page.evaluate(() => window.__stopMobileTapTrace?.()).catch(() => {});
  }
}

test.beforeEach(async ({ context, request }) => {
  const response = await request.post(`${proxyURL}/__fixture/reset`);
  expect(response.ok()).toBeTruthy();
  // No test may accidentally request a real platform or external image.
  await localTrafficOnly(context);
});

test('免网页登录直接进入、隐藏网站退出并隔离不同浏览器的平台账号', async ({ page, browser }, testInfo) => {
  await page.goto(noLoginURL);
  await expect(navigation(page)).toBeVisible();
  await expect(page.getByLabel('访问账号', { exact: true })).toHaveCount(0);
  await platformLogin(page, 'alice');
  await expect(page.getByRole('heading', { name: '网络与代理' })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出网页登录', exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);

  const other = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
    serviceWorkers: 'block',
  });
  try {
    await localTrafficOnly(other);
    const second = await other.newPage();
    await second.goto(noLoginURL);
    await expect(navigation(second)).toBeVisible();
    await tab(second, '我的');
    await expect(second.getByRole('textbox', { name: '平台账号', exact: true })).toBeVisible();
    await platformLogin(second, 'bob');
    await page.reload();
    await tab(page, '我的');
    await expect(page.getByText('@alice · ID 11', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '退出网页登录', exact: true })).toHaveCount(0);
  } finally { await other.close(); }
});

test('免登录会话自动恢复一次，持续失效时停止并允许手动重连', async ({ page }) => {
  let attempts = 0;
  let alwaysFail = false;
  let allowRequests = false;
  await page.route('**/api/rpc/app_boot', (route) => {
    attempts += 1;
    if (!allowRequests && (alwaysFail || attempts === 1)) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: '会话已过期', code: 'AUTH_REQUIRED' }) });
    }
    return route.continue();
  });
  await page.goto(noLoginURL);
  await expect.poll(() => attempts).toBe(2);
  await expect(navigation(page)).toBeVisible();
  await expect(page.getByLabel('访问密码', { exact: true })).toHaveCount(0);

  alwaysFail = true;
  attempts = 0;
  await page.reload();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('无法保持浏览器会话');
  await expect(page.getByLabel('访问密码', { exact: true })).toHaveCount(0);
  allowRequests = true;
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect.poll(() => attempts).toBe(3);
  await expect(navigation(page)).toBeVisible();
});

test('网站登录校验、会话恢复、布局和退出', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的网页服务' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByLabel('访问账号', { exact: true }).fill(access.username);
  await page.getByLabel('访问密码', { exact: true }).fill('incorrect-password');
  await page.getByRole('button', { name: '进入 HGhub', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
  await page.getByLabel('访问密码', { exact: true }).fill(access.password);
  await page.getByRole('button', { name: '进入 HGhub', exact: true }).click();
  await expect(navigation(page)).toBeVisible();
  await page.reload();
  await expect(navigation(page)).toBeVisible();
  await tab(page, '我的');
  await expect(page.getByRole('heading', { name: '网络与代理' })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('button', { name: '退出网页登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录你的网页服务' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录你的网页服务' })).toBeVisible();
});

test('无需平台登录即可设置代理，并通过代理真正播放加密 HLS', async ({ page, request }) => {
  await login(page);
  await tab(page, '我的');
  await expect(page.getByRole('textbox', { name: '平台账号', exact: true })).toBeVisible();
  await page.getByLabel('代理地址', { exact: true }).fill(proxyURL);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('使用代理', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '测试当前连接', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '连接成功' })).toContainText('HTTP 200');
  await expect.poll(async () => (await fixtureState(request)).proxyRequests.some((entry) => entry.path === '/')).toBeTruthy();

  // Reload so API, cover, master/child playlists, AES key and segments all use the new proxy.
  await page.reload();
  await expect(navigation(page)).toBeVisible();
  const video = page.locator('video:visible').first();
  await expect(video).toBeAttached();
  await expect.poll(() => video.evaluate((element) => element.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((element) => element.videoWidth)).toBeGreaterThan(0);
  if (await video.evaluate((element) => element.paused && !element.ended)) await video.click();
  await expect.poll(() => video.evaluate((element) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.25);
  expect(await video.evaluate((element) => element.error?.message ?? null)).toBeNull();
  await expect.poll(async () => {
    const paths = (await fixtureState(request)).proxyRequests.map((entry) => entry.path);
    return ['/api/edge/request', '/cover.aes', '/master.m3u8', '/stream.m3u8', '/key.bin', '/stream0.ts'].every((path) => paths.includes(path));
  }).toBeTruthy();
  await noHorizontalOverflow(page);
});

test('手机安全区内进度条避开导航，真实触摸可拖动并支持无底栏播放页', async ({ page, context }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'This regression requires the mobile touch browser project');
  test.setTimeout(75_000);
  const cdp = await context.newCDPSession(page);
  try {
    await page.goto(noLoginURL);
    await expect(navigation(page)).toBeVisible();
    // Chromium has no physical home indicator; exercise the same inherited CSS safe-area value.
    await page.addStyleTag({ content: '.plat-web-mobile { --sab: 34px !important; }' });
    const slider = page.getByRole('slider', { name: '播放进度', exact: true });
    const video = page.locator('.player-root:visible video').first();

    for (const height of [844, 600]) {
      await page.setViewportSize({ width: 390, height });
      const box = await mobileSliderBox(slider);
      const navBox = await navigation(page).boundingBox();
      expect(navBox).not.toBeNull();
      expect(await navigation(page).evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('34px');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, 'The full seek touch area must be above the navigation').toBeLessThanOrEqual(navBox.y);
      expect(navBox.y + navBox.height).toBeLessThanOrEqual(height);
      await noHorizontalOverflow(page);

      const categoryBox = await navigation(page).getByRole('button', { name: '分类', exact: true }).boundingBox();
      expect(categoryBox).not.toBeNull();
      // Let the finger drift onto a navigation button before release: capture must retain the seek.
      await touchSeek(page, cdp, video, slider, box, {
        x: categoryBox.x + categoryBox.width / 2,
        y: categoryBox.y + categoryBox.height / 2,
      });
      await expect(navigation(page).getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page');
      await page.screenshot({ path: testInfo.outputPath(`mobile-seek-home-390x${height}.png`) });
    }

    await touchTap(page, cdp, navigation(page).getByRole('button', { name: '分类', exact: true }));
    await expect(navigation(page).getByRole('button', { name: '分类', exact: true })).toHaveAttribute('aria-current', 'page');
    await touchTap(page, cdp, page.getByRole('button', { name: new RegExp(clipTitle) }).first());
    await expect(navigation(page)).toHaveCount(0);
    const contextBox = await mobileSliderBox(slider);
    expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(600 - 34);
    await touchSeek(page, cdp, video, slider, contextBox, {
      x: contextBox.x + contextBox.width * 0.75,
      y: contextBox.y + contextBox.height / 2,
    });
    await expect(navigation(page)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('mobile-seek-context-390x600.png') });
    await touchTap(page, cdp, page.getByRole('button', { name: '返回', exact: true }).first());
    await expect(navigation(page).getByRole('button', { name: '分类', exact: true })).toHaveAttribute('aria-current', 'page');
    await touchTap(page, cdp, navigation(page).getByRole('button', { name: '首页', exact: true }));
    await expect(navigation(page).getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page');
  } catch (error) {
    const events = await page.evaluate(() => window.__mobileTapTrace ?? []).catch(() => []);
    console.error('[mobile-seek] Last tap events:', JSON.stringify(events));
    throw error;
  } finally {
    await cdp.detach();
  }
});

test('平台登录退出和账号收藏隔离在同一浏览器中有效', async ({ page, request }) => {
  await login(page);
  await platformLogin(page, 'alice');
  await tab(page, '首页');
  // Desktop controls reveal themselves on pointer movement after their idle timeout.
  await page.locator('.player-root:visible').hover();
  // These are the two existing accessible toggles in the active player: like, favorite.
  const favorite = page.locator('.player-root:visible button[aria-pressed]').nth(1);
  await expect(favorite).toHaveAttribute('aria-pressed', 'false');
  await favorite.click();
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await fixtureState(request)).requests.some((entry) =>
    entry.rpc === '/api/videos/1/collect' && entry.method === 'POST' && entry.account === 'alice')).toBeTruthy();
  await tab(page, '我的');
  await expect(page.getByRole('button', { name: clipTitle, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出平台账号', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '平台账号', exact: true })).toBeVisible();

  await platformLogin(page, 'bob');
  await expect(page.getByText('还没有收藏', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: clipTitle, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出平台账号', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '平台账号', exact: true })).toBeVisible();
  await platformLogin(page, 'alice');
  await expect(page.getByRole('button', { name: clipTitle, exact: true })).toBeVisible();
  await page.reload();
  await tab(page, '我的');
  await expect(page.getByRole('button', { name: clipTitle, exact: true })).toBeVisible();
});

test('图文页面清洗主动内容并支持浏览器返回', async ({ page }) => {
  await login(page);
  await tab(page, '分类');
  await page.getByRole('button', { name: new RegExp(postTitle) }).click();
  const heading = page.getByRole('heading', { name: postTitle, exact: true });
  await expect(heading).toBeVisible();
  const article = page.locator('.article-body:visible');
  await expect(article.getByText('正常图文内容', { exact: true })).toBeVisible();
  await expect(article.locator('svg, math, script, iframe, [onerror], [onload], [style], [srcdoc], [srcset]')).toHaveCount(0);
  expect(await article.locator('a').getAttribute('href')).toBeNull();
  expect(await page.evaluate(() => window.fixtureXss ?? null)).toBeNull();
  await expect(article.locator('img')).toHaveAttribute('src', /^\/media\/img\?u=/);
  await expect.poll(() => article.locator('img').evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);

  await page.goBack();
  await expect(heading).not.toBeVisible();
  await expect(navigation(page).getByRole('button', { name: '分类', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(navigation(page).getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page');
});
