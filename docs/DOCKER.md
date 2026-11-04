# HGhub Docker 网页版

网页版复用 React 界面，通过 Node.js 服务提供同源接口、登录、代理和媒体转发。无需在服务器安装桌面环境、Rust、Android SDK 或浏览器。原来的 Tauri 桌面/Android 构建入口继续保留。

## 1. 启动

服务器需要 Docker Engine 与 Docker Compose 插件。构建时需要访问 Node 镜像仓库和 npm registry；运行时需要能访问上游站点，或能连接指定代理。

在项目目录运行：

```bash
cp .env.example .env
```

编辑 `.env`，设置独立的网页登录账号，密码需为 12–256 个字符。例如自行填写：

```dotenv
HGHUB_ADMIN_USERNAME=admin
HGHUB_ADMIN_PASSWORD=在这里填写你自己的长密码
HGHUB_PORT=3000
```

若密码包含 `$`、`#` 等 Compose 特殊字符，使用单引号包住完整值。不要把 `.env` 提交到 Git。

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 hghub
```

手机和服务器在同一网络时，打开 `http://服务器局域网IP:3000`。放行服务器防火墙中对应的 TCP 端口。Docker 默认向所有网卡发布此端口，可用 `HGHUB_BIND=127.0.0.1` 限制为本机访问（例如仅供本机反向代理使用）。手机上的 `localhost` 指手机本身，请使用服务器地址。

镜像使用多阶段构建，最终以非 root 用户运行。Compose 启用只读根文件系统，持久数据单独挂载到 `/app/data`；`/healthz` 为不依赖上游网络的容器健康检查。

## 2. 两种登录

| 登录 | 用途 | 账号来源 |
| --- | --- | --- |
| 网页访问登录 | 进入自己部署的 HGhub，保护接口、媒体和代理设置 | `.env` 的 `HGHUB_ADMIN_USERNAME` / `HGHUB_ADMIN_PASSWORD` |
| 平台账号登录 | 使用原项目的账号功能，例如个人资料、互动 | 「我的」中的平台账号登录/注册 |

当前为**一个部署管理账号**，可以在多个浏览器分别登录。它不是多用户注册系统。平台 token 按浏览器会话独立保存，不使用全局共享登录态；平台自身的 token 撤销和过期规则仍由上游决定。

网页登录 Cookie 使用 HttpOnly、SameSite=Lax，有效期 7 天。平台 token 存于服务器私有数据目录，不存到浏览器 localStorage。网页登录密码由环境配置提供，不写进会话文件；会话文件仅存网页登录 Cookie 的哈希、平台 token 和必要用户资料，权限为 `0600`。

修改网页登录用户名或密码后，重新创建容器：

```bash
docker compose up -d --force-recreate
```

已有网页登录会话会失效，需要重新登录。「退出网页登录」与「退出平台账号」分别作用于两种登录。

收藏、浏览记录等本地数据按平台账号分别保存，游客使用单独记录；主题、音量等偏好在当前浏览器共享。Docker 数据卷不提供这些本地数据的跨设备同步。

## 3. 设置代理

进入 **我的 → 网络与代理**，填写完整地址，保存后点击连接测试。保存会立即影响后续的业务 API、图片、播放列表、密钥和视频分片请求，无需重启容器。已在传输的请求可能继续使用原连接，必要时重新打开播放页。

| 类型 | 示例 |
| --- | --- |
| HTTP | `http://host.docker.internal:7890` |
| HTTPS 代理 | `https://proxy.example.com:8443` |
| SOCKS5 | `socks5://host.docker.internal:1080` |
| SOCKS5，代理端解析目标域名 | `socks5h://host.docker.internal:1080` |
| 需要认证 | `http://用户名:密码@proxy.example.com:7890` |

代理用户名或密码中的 `@`、`:`、`/`、`#` 等字符需要 URL 编码。查看设置时，已保存代理的认证信息会被遮蔽；修改时填写完整的新地址。保存空地址表示直连。

**配置优先级：网页保存的设置 → `HGHUB_PROXY` → 直连。** 网页保存的空地址也会覆盖环境变量。若需要恢复仅由环境变量管理，可停止服务、备份数据卷后删除其中的 `settings.json` 再启动。应用不会自动采用宿主机的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`，避免容器网络行为随宿主环境改变。

Compose 已配置 `host.docker.internal:host-gateway`。容器内的 `127.0.0.1` 指容器自己；若代理运行在宿主机，请使用 `host.docker.internal`，并在代理程序中启用允许局域网连接，或监听容器可访问的网卡地址。代理和 HGhub 在同一个 Docker 网络时，也可用代理服务名，例如 `http://proxy:7890`。

代理支持情况与宿主机映射参考：[proxy-agent 项目](https://github.com/TooTallNate/proxy-agents/tree/main/packages/proxy-agent)、[Docker Compose 网络说明](https://docs.docker.com/compose/how-tos/networking/)。

## 4. HTTPS / 反向代理

通过域名和 HTTPS 访问时，设置公开来源为手机实际打开的地址，不带路径：

```dotenv
HGHUB_PUBLIC_ORIGIN=https://hghub.example.com
HGHUB_COOKIE_SECURE=true
```

来源校验使用 `HGHUB_PUBLIC_ORIGIN`。如果未设置，浏览器请求的 Origin 必须与请求 Host 及协议一致。服务不自动信任 `X-Forwarded-*` 请求头；HTTPS 终止在反向代理时需要显式填写公开来源，否则登录或保存设置会提示来源不匹配。

Nginx 示例（证书及 HTTPS server 配置由现有反向代理负责）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_buffering off;
    proxy_read_timeout 120s;
    client_max_body_size 64k;
}
```

如果 Nginx 自身在容器中，应把 `proxy_pass` 改为同一 Docker 网络中的 HGhub 服务地址，例如 `http://hghub:3000`。目前部署在域名根路径，不支持 `/hghub/` 这样的子路径。

仅局域网 HTTP 访问时保持 `HGHUB_COOKIE_SECURE=false` 并留空 `HGHUB_PUBLIC_ORIGIN`。Secure Cookie 用于 HTTPS；在普通 HTTP 地址上开启会导致浏览器无法维持登录。

## 5. 数据持久化、更新与备份

默认命名卷 `hghub-data`（实际名称带 Compose 项目前缀）保存：

- `settings.json`：服务端代理设置，包括代理认证信息。
- `sessions.json`：浏览器会话及各自的平台登录态。

```bash
# 拉取当前所用分支的新代码，然后重建；数据卷保留
git pull --ff-only
docker compose up -d --build

# 停止并移除容器；数据卷保留
docker compose down
```

不要在需要保留数据时使用 `docker compose down -v`。备份时停止服务，并备份该命名卷与自己的 `.env`；两者均含敏感信息，应按私密配置保管。

默认使用命名卷避免宿主机目录权限问题。若改成绑定目录 `./data:/app/data`，需要让容器中的 `node` 用户（UID 1000）拥有写入权限。

## 6. 本地开发与验证

使用 Node.js 22.14+，推荐 Node.js 24；项目固定 pnpm 版本，可用 Corepack 或安装 `pnpm@10.11.0`。

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# 在 .env 填写网页登录密码
pnpm web:dev
```

另一个终端运行：

```bash
pnpm dev --host 0.0.0.0
```

默认 Vite 为 1420 端口，通过开发代理把 `/api`、`/media` 转到本机 3000 端口。`HGHUB_DEV_SERVER` 可指定开发后端地址。开发代理保留 Host，避免来源校验被端口变化破坏。若 `.env` 配置了生产的 `HGHUB_PUBLIC_ORIGIN`，本地开发时需要清空或改为开发地址。

```bash
pnpm test         # 合成上游/代理测试，无需真实账号和内容
pnpm build        # TypeScript 检查与 Vite 生产构建
pnpm start        # 加载 .env 并提供生产静态文件和接口
```

浏览器回归测试另外使用 Playwright 和项目自带的合成媒体：`pnpm exec playwright install chromium` 后运行 `pnpm test:browser`（先完成 `pnpm build`）。Linux 上可用 `pnpm exec playwright install --with-deps chromium` 安装浏览器系统依赖。

GitHub Actions 的 `Web and Docker` 工作流运行服务端测试、构建前端、检查手机和桌面浏览器流程、校验 Compose，并构建及启动容器检查健康接口、鉴权和设置接口。Fork 的 Actions 如被 GitHub 默认暂停，需要在仓库 Actions 页面启用后才能运行。

## 7. 故障排查

| 现象 | 检查 |
| --- | --- |
| Compose 提示密码未设置 | 编辑 `.env`，设置 12–256 位 `HGHUB_ADMIN_PASSWORD` |
| 手机连接失败 | 使用服务器局域网 IP；确认端口、防火墙和 `HGHUB_BIND` |
| 登录提示来源不匹配 | 检查 `HGHUB_PUBLIC_ORIGIN` 是否等于实际打开的地址，含协议和非默认端口 |
| 登录成功又回到登录页 | HTTP 下关闭 Secure Cookie；确认 Cookie 未被浏览器屏蔽 |
| 上游连接被拒绝 | 确认代理端口、宿主机地址、代理程序允许容器连接 |
| 改了环境代理但未生效 | 网页保存值优先；在网页修改并保存代理 |
| 网页正常但某些媒体域名被阻止 | 从可信上游核对新 CDN 域名，添加至 `HGHUB_MEDIA_HOSTS` 后重建容器 |
| 平台账号失效 | 网页访问账号仍有效，在「我的」重新登录平台账号 |
| 播放器有画面但无声音 | 手机浏览器的自动播放通常从静音开始，点击声音按钮或播放器启用声音 |
| 容器报数据目录写入失败 | 检查数据卷/绑定目录权限和磁盘剩余空间 |

媒体请求只允许上游站点和受信任 CDN 域名，直连时会拒绝内网、链路本地和保留 IP。额外域名通过 `HGHUB_MEDIA_HOSTS` 配置，支持 `cdn.example.com,*.example.net`。使用代理时，目标域名仍受白名单限制，DNS 和最终路由由配置的代理负责；仅添加你信任的媒体域名。

播放器兼容 HLS 主/子播放列表和原生 HLS，MP4 支持 Range/HEAD 请求；具体编解码器仍取决于手机浏览器自身支持。自动化测试使用合成媒体，真实平台登录、网络可达性及具体片源需要在你的部署环境中确认。
