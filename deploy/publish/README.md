# Phase 4B-3：私有镜像发布（执行前须审核）

本目录只准备发布，不连接 ECS，不部署应用。源码固定为
`73bb384ee031452cd2a7a2f1a16cbee74aa0ec97`，工作流及工具来自经审核后的部署分支提交。
两种提交分开记录：Actions run 对应发布工具提交；release.json 的 source_sha 对应固定应用源码。

## 发布前准备与触发

在仓库 Settings → Secrets and variables → Actions → Variables 中核对并设置：

- `ECS_PUBLIC_SUPABASE_URL`：现有项目的公开 HTTPS Project URL。
- `ECS_PUBLIC_SUPABASE_KEY`：该项目 publishable / legacy anon Key，绝不能是管理密钥。
- `ECS_PUBLIC_CONFIG_APPROVED_SHA`：审核 URL/Key 对应正确项目后，设为上述完整源码 SHA。不要填发布工作流提交。

这些值是浏览器公开配置，Web 构建会公开它们。不要使用测试占位值，也不要提供 DeepSeek Key、
service_role、sb_secret、数据库密码。这里只检查配置格式和审核标记，不连接 Supabase 验证项目，
须由维护者确认两个值来自同一正确项目且 RLS 已启用；本轮未读取或更改仓库变量。

首次发布按以下顺序执行：

1. 核对 Vercel 项目 Production → Branch Tracking 及生产域名的分支绑定。若指向部署分支或无法确认，先停止。
2. 由管理员预建 `ecs-ghcr-release` Environment，限定 `feat/ecs-deployment` 分支。可用时开启 Required reviewers，禁止自审和管理员绕过。若套餐不支持 Required reviewers，单独确认是否接受由管理员写入精确提交 SHA 的人工门槛。不能把自动创建的空 Environment 当作审批。
3. 获得提交授权后，提交已审核的工作流及脚本。在该 Environment 的 Variables 内设置 `ECS_APPROVED_PUBLISHER_SHA` 为此**发布工具提交**的完整 SHA，不在组织或仓库级定义同名变量。先不要推送。
4. 获得推送及发布授权后，只推送 `feat/ecs-deployment`。首次 push 必须包含 `.github/workflows/ecs-image-publish.yml` 的变化。开启 Required reviewers 时，在 Actions 核对运行的发布工具 SHA 和固定源码 SHA，再由指定 reviewer 批准。Environment 没有审批变量或值不匹配时，首步失败。
5. 等两包核验成功，下载并保存同一次运行的 `release.lock.yaml` 和 `release.json`。核对包权限与两个 Digest 后可清除 Environment 的发布工具批准变量，避免后续新运行沿用。

发布工具 SHA 与源码 SHA 是独立门槛。同一批准值可以授权同一提交的新运行，Environment reviewers 若已开启仍须按 GitHub 的规则审查。管理员与可编辑工作流或分支的人仍属于信任边界，应限制部署分支写权限。

同时保留 workflow_dispatch；GitHub 通常要求工作流已存在于默认分支才提供手动触发入口，
因此首次使用分支限定 push，不为手动入口修改 main。
手动触发没有版本输入，仍受同一仓库、分支、Environment 和两个 SHA 条件约束。

Runner 为 GitHub 托管 ubuntu-24.04；30 分钟上限、同组串行、不取消正在发布的任务。
工作流顶层 contents:read，只有独立发布 job 使用 contents:read + packages:write。
GITHUB_TOKEN 仅在发布步骤显式传入 GHCR 脚本，但权限属于整个 job，Action 仍可通过 github.token 访问。
不使用 PAT、生产 Secrets 或高权限 PR 触发器。
现有只读验证工作流和 main 的 Gitee 同步不修改；本分支 push 不触发 main 同步。
仓库的 Actions/Packages 策略须允许 GITHUB_TOKEN 写这两个包；既有包须授予该仓库 Actions 访问权。

## 验证与发布保障

先执行 Node 自动化测试、离线发布保护测试，再在 linux/amd64 下构建两份镜像。
复用已有 verify.sh 的镜像层/历史/日志 canary 审计、Nginx、健康检查、代理、模拟 AI、
UID/密钥挂载/配额持久化、取消及优雅关闭验证；测试网络隔离，不调用真实 AI 或生产 Supabase。
测试使用合成 Key，但前端构建使用已审核公开配置，不重新构建另一批未经测试的发布镜像。
清理临时密钥、构建日志、测试容器和卷；不上传诊断日志、环境文件或镜像 tar。

发布前同时预检两个包：包已存在则必须 private；已有 SHA 标签的 config digest
必须等于本地镜像 ID，否则在第一次 push 前停止。内容一致则跳过该镜像 push。
首次新包使用 GHCR 默认 private，并在发布后通过 API 再核实 visibility。
每次 push 前再次检查标签，发布后按 digest 回读 manifest；只在两个包都通过后生成：

- `release.lock.yaml`：Compose override，Web/API 使用 image@sha256 且 platform:linux/amd64。
- `release.json`：完整源码 SHA、Registry Digest、压缩层大小、本地展开大小及私有可见性。

仅这两个文件上传 Actions artifact（保留 14 天）。发布前不生成假 digest 或假 lock。
认证/权限、Registry/API 请求失败、非单平台 manifest、平台或内容不符均停止。
失败日志不输出 Token、响应正文或 Docker 原始输出。

限制：GHCR 标签没有这里可用的原子 compare-and-set；并发组只能约束本工作流。
发布窗口必须停止其他写入者对相同 SHA 标签的写入。两镜像发布不是事务：若第二个失败，
第一个可能已存在，但不会产出完整 release lock；不要据此部署。重跑前先查两个包的固定标签和 Digest。
只有重建镜像与已存在镜像的 config digest 一致时才跳过旧包并补发缺失的包。如果出现冲突，保留现有镜像并停止，另行审核恢复方案。
基础镜像及 npm 版本锁定范围沿用固定源码；可变基础镜像标签可能令重建结果不同，
发现已有同 SHA 标签内容不同即停止，不覆盖。权限核验结果仍需在真实发布后确认。

## ECS 只读部署身份（后续单独授权）

建议独立部署账号，两个私有包只授予 Read；为该账号创建短期 PAT classic，仅勾选
`read:packages`，不授予 write/delete/repo。不扩大到其他包；若组织启用 SSO 按策略授权。
发布使用 GITHUB_TOKEN；此 PAT 只在后续 ECS 拉取时使用，不交给 CI。
Classic scope 不是单包 scope，账号本身的包权限必须最小化。

以下仅为后续获批后的 Bash 示例，本轮不执行。Workbench 终端必须关闭录屏/输入日志等敏感采集，
关闭 shell tracing，不在命令里粘贴 Token。使用临时 Docker config，避免凭据长期落盘：

```bash
set +x
export DOCKER_CONFIG="$(mktemp -d)"
chmod 700 "$DOCKER_CONFIG"
trap 'unset GHCR_READ_TOKEN; rm -rf -- "$DOCKER_CONFIG"; unset DOCKER_CONFIG' EXIT
read -r -p 'GHCR read-only user: ' GHCR_READ_USER
read -r -s -p 'GHCR read-only token: ' GHCR_READ_TOKEN
printf '\n'
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u "$GHCR_READ_USER" --password-stdin
unset GHCR_READ_TOKEN
# 先从获批 Actions artifact 获取并人工核对 release.lock.yaml、release.json。
# 已有 .env.ecs 中只存非镜像仓库凭据；不要把 PAT 写入 Compose 或环境文件。
docker compose --env-file .env.ecs -f compose.yaml -f release.lock.yaml config --images
docker compose --env-file .env.ecs -f compose.yaml -f release.lock.yaml pull web api
# 仅拉取，不 up/start/run；用 docker image inspect 核对 OS/Architecture/RepoDigests/Size。
docker logout ghcr.io
```

不要在 sudo 下丢失 DOCKER_CONFIG 后意外使用另一套凭据。Docker 的临时配置为明文等价认证信息，
目录限制 0700 并及时删除；需要持久认证时另行审核 credential helper，不写入 Shell history/Git。
拉取失败限定重试（例如最多 3 次，间隔 5/15 秒）；鉴权失败或 digest 不符立即停止。
拉取不会更改正在运行的应用，失败无需停机回滚；保留旧镜像，不执行 prune。
后续应用版本回滚使用上一份已审核 lock 和对应的兼容配置，不迁移或回滚 Supabase 数据。

## 费用与执行边界

GitHub Actions 分钟、artifact 存储及 GHCR 政策/账号额度在发布前从 Billing 核对；
不保证零费用，不新增收费资源。压缩下载大小由真实 Registry manifest 汇总，
展开磁盘占用由 image inspect 记录，不能把层大小当作 ECS 增量磁盘用量。
本轮不改 ECS、防火墙、安全组、Nginx、Vercel、Supabase，不启动 ECS 容器，也不运行收费 AI。
