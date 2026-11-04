import { expect, test } from '@playwright/test';
import { access, baseURL, clipTitle, platformPassword, postTitle, proxyURL } from './fixture-config.mjs';

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

test.beforeEach(async ({ context, request }) => {
  const response = await request.post(`${proxyURL}/__fixture/reset`);
  expect(response.ok()).toBeTruthy();
  // No test may accidentally request a real platform or external image.
  await context.route(/^https?:\/\//, (route) => new URL(route.request().url()).origin === baseURL
    ? route.continue() : route.abort('blockedbyclient'));
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
