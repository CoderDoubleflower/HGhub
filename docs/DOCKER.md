# HGhub Docker 网页版

默认配置无需设置额外的网页登录账号或密码，使用 host 网络，服务端数据写入 `compose.yaml` 同目录的 `data` 文件夹。原平台账号功能继续在「我的」中使用。

## 1. 启动

使用 Linux Docker Engine 和 Docker Compose v2，在项目目录运行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 hghub
```

无需创建 `.env`。手机打开 `http://服务器局域网IP:3000` 即可进入。服务默认监听宿主机所有网卡的 3000 端口，能够连接该端口的设备可以浏览页面和修改代理。

首次构建需要访问 Node / Alpine 镜像仓库和 npm registry；独立远程构建的 Compose 文件还需要访问 GitHub。应用内的代理设置只影响运行后的请求，不负责 Docker 构建阶段联网。

Compose 包含两个服务：

- `data-init`：准备本地 `./data` 的权限，完成后退出；`Exited (0)` 是正常状态。
- `hghub`：等待目录准备完成，再以非 root 的 `node` 用户启动网页服务。

应用根文件系统只读，`/tmp` 为临时目录，持久数据挂载到 `/app/data`。无需安装桌面环境、Rust 或 Android SDK。

## 2. host 网络与端口

`network_mode: host` 直接使用宿主机网络和端口，所以配置中没有 `ports` 和 `extra_hosts`。同一宿主机上的代理可直接使用 `127.0.0.1`，手机访问时仍须使用服务器 IP。

如果 3000 端口被占用，可在 `.env` 中设置 `HGHUB_PORT=3001`，或直接修改独立 Compose 文件中的 `HGHUB_PORT`，然后重新运行 `docker compose up -d --build`。健康检查会跟随端口。仅供宿主机反向代理访问时，可设置 `HGHUB_HOST=127.0.0.1`。

host 网络原生支持 Linux Docker Engine；Docker Desktop 4.34 及以后需要在设置中开启 host networking。参考：[Docker host 网络说明](https://docs.docker.com/engine/network/drivers/host/)。

## 3. 本地文件夹与数据

配置使用 `./data:/app/data` 绑定挂载，文件位于 Compose 文件所在目录：

| 文件 | 内容 |
| --- | --- |
| `data/settings.json` | 代理设置，包括已填写的代理认证信息 |
| `data/sessions.json` | 各浏览器会话及各自的平台登录态 |

启动时自动创建文件夹，将目录及内部文件的所有权设为 UID/GID 1000，目录权限为 `0700`。服务写入的配置和会话文件权限为 `0600`。容器重建后，文件仍保留在宿主机。

```bash
# 更新当前分支并重建，保留 ./data
git pull --ff-only
docker compose up -d --build

# 停止服务，保留 ./data
docker compose down
```

备份时先停止服务，再备份整个 `data` 文件夹；其中包含平台登录凭据和可能存在的代理认证信息。

浏览器收藏、浏览记录等仍按平台账号保存在浏览器中，主题和音量等偏好在当前浏览器共享。挂载 `./data` 不会把这些浏览器本地数据自动同步到服务器或其他设备。

### 从旧命名卷迁移

旧 Docker 命名卷中的数据不会自动移入 `./data`。如果之前使用本项目的独立 Compose 文件，先停止旧容器，并核对卷名：

```bash
docker compose down
docker volume inspect hghub_hghub-data
```

确认这是要迁移的旧卷后执行以下复制命令，再用新配置启动。实际项目名不同的部署需替换为核对后的卷名。

```bash
mkdir -p data
docker run --rm --network none \
  -v hghub_hghub-data:/old:ro \
  -v "$PWD/data:/new" \
  alpine:3.22 sh -ec 'cp -a /old/. /new/'
docker compose up -d --build
```

复制会保留旧卷。免网页登录与密码模式的会话互不通用，切换后平台账号需重新登录；代理设置可继续使用。

## 4. 免网页登录与平台账号

默认 Compose 显式设置 `HGHUB_AUTH_DISABLED=true`，不配置部署用户名或密码。页面自动创建独立浏览器会话，界面不显示额外网页登录表单或退出网页登录按钮。

「我的」中的原平台账号登录和退出继续可用。平台 token 按浏览器会话分别保存在服务器，不使用全局共享账号，也不返回给浏览器。Cookie 使用 HttpOnly、SameSite=Lax，有效期 7 天；同一部署模式下重启后可恢复，切换是否需要网页登录会使旧会话失效。平台自身的 token 过期和撤销仍由上游决定。

直接运行 Node 服务时，只有显式设置 `HGHUB_AUTH_DISABLED=true` 才会关闭网页登录。没有该开关时，服务仍要求 `HGHUB_ADMIN_PASSWORD` 为 12–256 个字符，并支持 `HGHUB_ADMIN_USERNAME`。

## 5. 代理设置

进入 **我的 → 网络与代理**，填写完整地址，保存后点击连接测试，无需先登录平台账号。

| 类型 | host 网络下的示例 |
| --- | --- |
| HTTP | `http://127.0.0.1:7890` |
| HTTPS 代理 | `https://proxy.example.com:8443` |
| SOCKS5 | `socks5://127.0.0.1:1080` |
| SOCKS5，代理端解析域名 | `socks5h://127.0.0.1:1080` |
| 需要认证 | `http://用户名:密码@proxy.example.com:7890` |

保存后立即用于后续 API、图片、HLS 播放列表、密钥和视频分片请求。正在传输的请求可能继续使用原连接，必要时重新打开播放页。代理用户名或密码中的 `@`、`:`、`/`、`#` 等字符需要 URL 编码；读取设置时认证信息会被遮蔽。

**优先级：网页保存的设置 → `HGHUB_PROXY` → 直连。** 保存空地址表示直连，也会覆盖环境变量。应用不会自动读取宿主机的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`。

host 网络下的 `127.0.0.1` 就是宿主机回环地址，不再需要 `host.docker.internal`；只监听宿主机回环地址的代理也可访问。支持协议参考：[proxy-agent 项目](https://github.com/TooTallNate/proxy-agents/tree/main/packages/proxy-agent)。

## 6. HTTPS 反向代理

通过 HTTPS 域名访问时，在 Compose 环境配置中填写手机实际打开的来源，不带路径：

```yaml
HGHUB_PUBLIC_ORIGIN: "https://hghub.example.com"
HGHUB_COOKIE_SECURE: "true"
```

修改接口仍会校验来源和请求头，免网页登录不会取消这项校验。服务不自动信任 `X-Forwarded-*`；HTTPS 在反向代理终止时需要显式填写公开来源。

宿主机 Nginx 转发示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_buffering off;
    proxy_read_timeout 120s;
    client_max_body_size 64k;
}
```

当前支持域名根路径，不支持 `/hghub/` 子路径。局域网 HTTP 保留 `HGHUB_COOKIE_SECURE=false`，并留空 `HGHUB_PUBLIC_ORIGIN`，以便浏览器保持平台登录会话。

## 7. 开发与验证

使用 Node.js 22.14+，推荐 24；项目固定 pnpm 10.11.0：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm web:dev
```

另一个终端运行 `pnpm dev --host 0.0.0.0`。Vite 默认端口 1420，将 `/api`、`/media` 代理到本机 3000；可用 `HGHUB_DEV_SERVER` 指定后端地址。

```bash
pnpm test
pnpm build
pnpm start
```

浏览器回归：先构建，再运行 `pnpm exec playwright install --with-deps chromium` 和 `pnpm test:browser`。测试使用合成媒体和本地上游，无需真实平台账号。

`Web and Docker` 工作流验证服务端、手机和桌面浏览器、镜像构建、带密码模式，以及免网页登录、host 网络、本地目录挂载和重建持久化。真实设备、平台账号及具体网络条件仍需在部署环境中确认。

## 8. 故障排查

| 现象 | 检查 |
| --- | --- |
| 3000 端口被占用 | 修改 `HGHUB_PORT`，host 网络没有端口映射 |
| 手机连接失败 | 使用服务器 IP，核对防火墙、监听地址和端口 |
| data-init 显示 Exited (0) | 正常，目录初始化已完成 |
| data-init 权限错误 | 确认文件系统支持 chown，挂载目录可写 |
| 保存代理提示来源不匹配 | 核对 `HGHUB_PUBLIC_ORIGIN` 与访问地址，含协议和端口 |
| 平台登录后变成游客 | HTTP 下关闭 Secure Cookie，确认浏览器允许 Cookie |
| 宿主机代理连不上 | 确认 host 网络、代理地址及监听端口 |
| 修改环境代理未生效 | 网页保存值优先，在网页重新设置 |
| 旧配置不见了 | 旧命名卷不会自动迁入 `./data`，按迁移说明复制 |
| 部分媒体域名被阻止 | 核对可信 CDN 后加入 `HGHUB_MEDIA_HOSTS` 并重建 |

媒体只允许上游和受信任 CDN 域名；`HGHUB_MEDIA_HOSTS` 支持 `cdn.example.com,*.example.net`。直连拒绝内网、链路本地和保留 IP；使用代理时，目标域名仍受白名单限制，远端 DNS 和路由由代理负责。

播放器支持 HLS 主/子播放列表、原生 HLS 和 MP4 Range/HEAD。具体编解码器和自动播放行为仍取决于手机浏览器。
