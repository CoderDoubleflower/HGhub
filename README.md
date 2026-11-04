<div align="center">

# HGhub

**黄果短剧第三方客户端 · Rust + Tauri 2**

Web / Windows / Android · Docker 部署 · 手机浏览器访问 · Fluent 设计
![alt text](docs/image.png)

</div>

## Docker 网页版

网页版保留现有界面和原生客户端，增加独立 Node.js 服务。iPhone、Android、电脑浏览器均可访问；网页访问账号与原有平台账号分开，平台登录态按浏览器会话隔离。所有接口、图片和视频使用同一套服务端代理配置。

```bash
cp .env.example .env
# 编辑 .env，设置 HGHUB_ADMIN_PASSWORD（至少 12 位），可同时修改用户名和端口
docker compose up -d --build
```

手机连接同一网络后，打开 `http://服务器局域网IP:3000`，用 `.env` 中的账号登录。在「我的」中可登录平台账号；「网络与代理」支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H，保存后立即生效，并提供连接测试。

容器访问宿主机代理时，可使用 `http://host.docker.internal:7890`；代理程序需允许来自容器的连接。配置和会话保存在 Docker 数据卷，重建容器后保留。

**完整说明：[Docker 部署、登录、代理与故障排查](docs/DOCKER.md)。**

本地开发网页版：Node.js 22.14+（推荐 24），`pnpm install` 后配置 `.env`。分别运行 `pnpm web:dev` 和 `pnpm dev`，打开 Vite 提示的地址；生产方式为 `pnpm build && pnpm start`。`pnpm test` 运行不依赖真实平台账号或内容的服务端测试。

> ⚠️ 本项目仅供 **学习与技术交流**，不提供、不存储、不分发任何音视频内容。
> 所有内容均来自第三方站点，请自行判断合规性，并在 24 小时内删除相关资源。


## 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | Tauri 2（Rust 1.9x） |
| 前端 | React 19 + TypeScript + Vite 7 + Tailwind CSS 4 |
| 播放 | hls.js（HLS / AES-128） |
| Web 服务 | Node.js HTTP 服务、服务端会话、HTTP / HTTPS / SOCKS 代理 |
| 网络 | reqwest + rustls |
| 图标 | 内联 SVG |

## 目录

```
.
├─ src/                      前端
│  ├─ api.ts                 接口封装 + 本地媒体协议 URL
│  ├─ store.tsx              全局状态（导航栈 / 用户 / 本地收藏 / 主题）
│  ├─ html.ts                吃瓜正文清洗与图片代理
│  ├─ components/            Feed（播放页）/ VideoSurface / PlayerControls / Panels / UI
│  └─ pages/                 Home / Search / Category / Profile / Posts
├─ src-tauri/                Rust 后端
│  └─ src/
│     ├─ net.rs              请求层（边缘信封 + 重试）
│     ├─ api.rs              业务命令
│     ├─ media.rs            封面解密 + HLS 代理 + 缓存
│     └─ session.rs          token 持久化
├─ server/                   网页后端（登录、RPC、代理与流式媒体）
├─ Dockerfile / compose.yaml Docker 构建与部署
└─ docs/API.md               接口文档
```

## 开发 / 构建

```bash
pnpm install          # 首次安装
pnpm app:dev          # 桌面端热重载
pnpm app:build        # 打包 Windows 安装程序（NSIS）
```

Android（需 Android SDK + NDK，并配置 `ANDROID_HOME` / `NDK_HOME`）：

```bash
pnpm android:init     # 首次生成 android 工程
pnpm android:dev      # 真机 / 模拟器调试
pnpm android:build    # 产出 APK
```

### 环境注意

- 工程若放在 **exFAT** 盘（不支持符号链接），需保留 `.npmrc` 中的 `node-linker=hoisted`。
- `esbuild` 需在 `package.json` 的 `pnpm.onlyBuiltDependencies` 中放行，否则 `vite build` 缺少二进制。

## 实现要点

1. **统一边缘信封**：站点把 `/api/**` 收敛为 `POST /api/edge/request`（`method/path/body(base64)/content_type` + `Authorization: Bearer`），本项目只对接这一个入口，无需处理 Cookie。
2. **封面解密**：封面为 AES-128-CBC 密文，Rust 侧解密后经自定义协议输出，前端 `<img>` 直接使用。
3. **HLS 代理**：m3u8 与分片经自定义协议转发并改写 `#EXT-X-KEY` / 分片地址，绕开 WebView 的 CORS 与防盗链。
4. **自定义协议**：Windows 为 `http://hg.localhost/*`，Android 为 `https://hg.localhost/*`（由 Rust 侧按平台生成，避免 WebView 无法解析）。
5. **不做签名逆向**：只复用浏览器同源行为，接口字段均有文档与实测样本。

接口细节见 [docs/API.md](docs/API.md)。

## 免责声明

- 本项目与内容提供方无任何关联，作者不参与内容的制作、上传与分发。
- 使用者应自行遵守所在地法律法规；因使用本项目产生的任何后果由使用者自行承担。
- 若相关权利方认为本项目存在侵权，请通过 Issue 联系，我们会及时处理。

## License

[MIT](LICENSE)
## 常见问题

**1. `pnpm install` 报 `ERR_PNPM_EISDIR ... symlink`**

工程放在 exFAT / FAT32 盘时无法创建符号链接，保留 `.npmrc` 里的 `node-linker=hoisted` 即可。

**2. `tauri android build` 报 `Failed to create a symbolic link ... jniLibs`**

同样是 exFAT 不支持符号链接。可手动把 Rust 产物拷进 jniLibs，再直接跑 Gradle：

```bash
cp src-tauri/target/aarch64-linux-android/debug/libhuangguo_client_lib.so \
   src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/

cd src-tauri/gen/android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

产物在 `src-tauri/gen/android/app/build/outputs/apk/`。

**3. Android 构建提示找不到 SDK / NDK**

需要设置 `ANDROID_HOME`（Android SDK 根目录）、`NDK_HOME`（`$ANDROID_HOME/ndk/<版本>`）与 `JAVA_HOME`（JDK 17）。

## LinuxDO
https://linux.do/
