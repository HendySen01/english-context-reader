# 阿里云 ECS 部署

ECS 运行两份镜像。Nginx 提供 Vue 静态文件，并在 Docker 内网把 `/api/llm` 转发给 Node。容器只把 Web 入口发布到 ECS 的 `127.0.0.1:8080`，由宿主机 Nginx 提供 HTTPS。Node 的 3000 端口不发布。Supabase Auth、PostgreSQL 和 RLS 继续使用现有项目。

ECS 的 AI 用服务端 DeepSeek Key，仅向身份验证成功并列入名单的账号开放。普通页面和本地阅读仍可使用。Vite 开发代理与 Vercel 函数仍是各自原有的入口。ECS 的转发防护仅应用于 ECS，勿将旧代理当作 ECS 的公网入口。

## 本地验证及构建

安装 Node 24 LTS 和 Docker Compose v2。运行：

```sh
npm ci
npm test
npm run build
cp .env.example .env.ecs
```

填写 `.env.ecs` 的 Supabase 项目 URL、公开 publishable/anon key，以及拥有 AI 使用权限的用户 UUID。用密码管理器或编辑器把模型 Key 写入 `secrets/deepseek_api_key`，不放入命令历史、Git、镜像、构建参数或 `VITE_*`。Compose 的文件型 secret 在普通 Docker 中是挂载文件：Linux 上用宿主机 ACL 或文件所有权让容器 UID 1000 能读取，其他普通用户不得读取。使用 rootless 或 UID 映射时按实际宿主机 UID 设置权限。建议限制密钥目录及 `.env.ecs` 权限，并为测试使用单独的低额度 Key。

```sh
docker compose --env-file .env.ecs config --quiet
docker compose --env-file .env.ecs --parallel 1 build
docker compose --env-file .env.ecs up -d --wait --no-build
curl --fail http://127.0.0.1:8080/healthz
```

健康检查只验证进程和代理路由。浏览器访问 `http://127.0.0.1:8080` 后，按下列顺序验收。涉及注册、写入和双账号隔离的用例应使用独立测试 Supabase 项目，复制现有结构和 RLS 策略，不复制生产用户数据。

1. 未登录访问页面和已有本地内容。查新词时应提示登录。API 不带凭据返回 401。
2. 测试账号 A 注册、验证邮件、登录，然后解析一个未缓存词条。确认收到结构化释义及例句，保存成功后重复点击命中缓存。
3. 导入多条缺译测试句子，确认翻译按索引写入。模拟不完整结果时，仅失败条目可重试。
4. 未列入名单的账号 B 可以登录和使用自己的语料，但 AI 返回 403。验证 A、B 对对方句子、词条、复习记录的读写都被 RLS 拒绝。
5. 使用低配额配置验证重复请求返回 429、重启后额度保留，并核对容器内存和日志。不能用健康检查代替实际的 AI 请求。

可用 `node --env-file=.env.rls-test deploy/check-rls.mjs` 运行只读的双账号登录和 RLS 检查。使用独立测试项目，为两个账号分别准备每张表至少一行，在被 Git 忽略的 `.env.rls-test` 中配置 `RLS_TEST_SUPABASE_URL`、`RLS_TEST_SUPABASE_KEY`（publishable key）、`RLS_TEST_EMAIL_A/B` 和 `RLS_TEST_PASSWORD_A/B`（A、B 分别使用独立变量）。写入隔离仍需按第 4 步在测试项目验收。

### GitHub Actions 容器验证

`.github/workflows/ecs-container-test.yml` 的验证任务只在 `feat/ecs-deployment` 执行。首次将包含该文件的提交推送到此分支时，由 `push` 触发验证。以后只有修改了该工作流文件的推送才会自动运行，普通业务代码提交不会自动运行。工作流使用 GitHub 托管的 Ubuntu 24.04 runner，权限为 `contents: read`，同一时间最多执行一次。

保留 `workflow_dispatch` 便于手动验证。GitHub 要求手动触发的工作流已存在于默认分支。默认分支尚无该文件时，首次验证使用上述受限的 `push` 事件。若工作流随后经批准进入默认分支，可在 Actions 页面选 `feat/ecs-deployment` 并点击 Run workflow。若要不改默认分支而重跑同一提交，可在 Actions 中对已有运行使用 Re-run jobs。首次推送前请核对 Vercel 的 Production Branch。Vercel 的 Git 集成独立于 GitHub Actions，非生产分支也可能生成 Preview。

经批准后，也可在已有 Docker Compose v2 的临时 Linux AMD64 runner 执行 `npm ci && npm test && bash deploy/ci/verify.sh`。脚本使用独立 Compose 项目、临时卷、占位配置和模拟账户。构建需要访问基础镜像和 npm 依赖来源。测试不调用 Supabase、DeepSeek 或 ECS，不发布镜像。

1. 校验 Compose，分别构建 Web 和 API，检查镜像架构、构建日志、镜像历史和应用镜像层的禁入文件与随机测试标记。
2. 使用生产入口启动两份镜像，验证 `nginx -t`、健康状态、回环发布端口、代理的无凭据 401 响应、API 的默认 UID、只读密钥挂载和配额卷写权限。
3. 使用 CI 覆盖配置启动模拟上游。通过 Nginx 验证解析、部分翻译、配额卷重启持久化、客户端断开传递和 SIGTERM 停机。
4. 用 `docker stats --no-stream` 采样 Web 与 API，清理当前作业的日志、容器和临时卷。样本只代表 CI 负载。测试覆盖把 API 的出口网络设为 internal。ECS 宿主机的防火墙和元数据隔离仍需另行验收。

## 出口隔离

应用仅从 `api.deepseek.com` 解析 IPv4，拒绝非公网结果，把 TLS 连接固定在已验证 IP 上，且禁止重定向。Supabase SDK 访问服务器配置的项目域名。应用外还应限制容器能到达的网络。

- 在宿主机对 `br-ecr-egress` 实施出口策略。Docker 使用 iptables 后端时放在 `DOCKER-USER` 链，使用 nftables 后端时在独立的 forward hook 上处理。进入自定义策略后，先放行必要的已建立连接，再丢弃访问 VPC、本机相关网段、回环、链路本地、共享地址段及特殊用途网段的流量。明确拒绝 `100.100.100.200/32`。在 host INPUT 上也禁止该桥主动发起的宿主机连接，防止绕过转发链访问宿主机服务。
- 默认拒绝新建出口。生产优先使用支持域名策略的透明出口防火墙，只允许到 DeepSeek 和指定 Supabase 项目域名的 TCP/443，以及受控的 DNS。若用系统防火墙，使用动态维护的 IPv4 地址集合做同样的 TCP/443 白名单，由可信解析器刷新两个域名的 A 记录，过滤禁止网段，原子更新集合。先验收 DNS 和合法 HTTPS 再切换为默认拒绝。DNS 走 Docker 内置解析器时，控制宿主机使用的上游解析器。遇到地址变化导致失败，应更新集合或恢复上一次有效集合。保留已有 Docker 网络规则。
- API 容器的出口网段禁用 IPv6。部署时应同时确认宿主机防火墙、Docker 后端、VPC CIDR 和 DNS 路径。将 ECS 实例元数据访问设为安全加固模式，按需移除未使用的实例 RAM 角色。
- 宿主机 Nginx 必须覆盖 `X-Reader-Client-IP`。该头仅在 8080 保持回环绑定、且主机访问受信时有效。公网只开放 80/443，SSH 仅开放给管理地址。升级到 Docker Engine 28 或更新受支持版本，仍须从另一台机器验证 8080、3000 和 5432 不可达。

参考 [Docker 防火墙文档](https://docs.docker.com/engine/network/packet-filtering-firewalls/) 和 [ECS 元数据说明](https://www.alibabacloud.com/help/en/ecs/user-guide/view-instance-metadata/)。

## 首次部署及更新

1. 在开发机或 CI 使用与 ECS 相符的镜像架构构建两份镜像。在构建环境把 `IMAGE_PREFIX` 设为私有镜像仓库路径前缀，把 `RELEASE` 设为 commit SHA，并注入当前 Supabase 项目的公开构建变量。运行上面的 Compose build，再运行 `docker compose --env-file .env.ecs push`。CI 构建阶段不提供模型 Key。生产应记录实际推送的镜像摘要，定期审核和更新 Dockerfile 基础镜像。
2. 在 ECS 的 `/opt/english-context-reader` 放置 `compose.yaml`、`.env.ecs` 和挂载密钥。使用已有 HTTPS 证书部署 `deploy/nginx-host.conf.example` 的宿主机站点配置。替换域名、证书路径和 Web 端口。签发或续签使用独立的证书流程。激活前运行 `nginx -t`。将 ECS HTTPS 根地址加入 Supabase Auth Redirect URLs，保留 Vercel 的设置。ECS 注册显式传递站点来源用于邮件确认。
3. 从私有仓库拉取镜像，启动并等待健康。保留前一版本对应的两份镜像、Compose 文件与版本化部署配置。首次部署和更新用同一组命令：

```sh
cd /opt/english-context-reader
docker compose --env-file .env.ecs config --quiet
docker compose --env-file .env.ecs pull
docker compose --env-file .env.ecs up -d --wait --no-build
curl --fail http://127.0.0.1:8080/healthz
```

4. 检查 HTTPS 登录、账号隔离和获准的 AI 请求。用 `docker stats --no-stream` 查看资源占用。更新建议选低峰时间，单实例切换期间可能短暂中断。日志默认轮转。

API 收到 SIGTERM 或 SIGINT 后停止接收新连接，给已接收请求最多 180 秒完成，每个请求仍受自身 180 秒限制。正常请求超时返回 504。若停机截止时仍有在途请求，API 会在连接可写时返回 503 和 `Retry-After: 5`，同时取消 DNS、鉴权或模型请求。再保留最多 5 秒写出响应。Compose 给 API 190 秒停止宽限期。单实例切换期间，代理也可能因后端暂不可达而返回网关错误。

## 回滚与费用

两份镜像按同一 `RELEASE` 回滚。把版本和 Compose 配置恢复到上一组，执行相同的 pull、up 和健康检查。不要删除 `quota` 卷，避免重置当天额度。本版本没有 SQL 迁移、没有数据库管理员 Key，也不修改生产数据结构。以后如果引入数据库变更，应先保证两版可同时读写，再安排独立迁移。数据库恢复不能作为应用镜像回滚的常规步骤。

API 使用单进程和持久化 UTC 日配额。默认每账号每天 30 次、全局 100 次、全局 500,000 预算单位。预算以输入字节和输出上限估算，在上游调用前扣减，超时和重试也可能占用额度。它是应用保护措施，供应商实际账单按供应商规则结算。应使用专用低额度项目或账户，设置可用的余额/预算告警和硬限额。实例重建需保留配额卷。文件配额只支持单 API 副本，多副本需要共享且原子的计数器。

Vercel 和 ECS 是不同的浏览器来源。云端账号数据来自同一个 Supabase 项目，原有浏览器会话及纯本地语料不会自动跨域迁移。可使用已有 JSON 备份功能迁移本地语料。
