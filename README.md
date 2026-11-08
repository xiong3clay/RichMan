# RichMan（大富翁联机版）

一个从 C++ 控制台游戏改造成「开服电脑 + 浏览器多端联机」的回合制金融生存游戏：
2～10 人、每人 100 金币，靠利息、借贷、赌博与纳税活到最后。

## 当前状态

**开发版 0.9.0，尚未正式发布（目标 V1.0）。**

- 方案版本：V1.3.3（施工版）；协议版本：1
- 已实现单元：00～09C-C。规则引擎、同源服务端、引导式网页 UI、教程/规则页、
  手机适配、8-bit 音频、债务中心、存档与重启恢复、备份/恢复/清理、服务加固与限流、
  下注结算传输层隐私均已完成
- 测试：66 文件 / 835 条（core、server、web）；`pnpm typecheck`、`pnpm build` 均通过
- 双客户端冒烟：`pnpm smoke:lan`
- 发布前剩余：09D 真机发布矩阵、单元 10 D6 多请求规则补全、单元 11 稳定性演练、单元 12 发布包
- 已知限制见 [CHANGELOG.md](CHANGELOG.md) 与 `handoff/项目当前状态.txt`

## 快速开始

    pnpm install
    pnpm test          # 66 文件 / 835 条测试
    pnpm smoke:lan     # 双客户端冒烟（真实服务 + 两个 WS）
    pnpm typecheck
    pnpm build
    pnpm start         # http://localhost:8000/ ，/health 返回版本、协议版本与在线计数

手机同一局域网访问启动日志里打印的 LAN 地址（默认 8000 端口）。
界面按阶段一次只问一个问题：行动阶段依次问私人借款 → 银行借款 → 还款/催收 → 结束行动；
下注阶段依次问猜点 → 金额 → 杠杆 → 锁定。顶部有「教程」「规则」「债务中心」「音频」入口。

## 一键启动 / 停止（Windows）

脚本同时兼容 Windows PowerShell 5.1 与 pwsh 7，`.ps1` 均保存为 UTF-8 with BOM：

    powershell -ExecutionPolicy Bypass -File scripts/start-lan.ps1
    powershell -ExecutionPolicy Bypass -File scripts/start-tunnel.ps1
    powershell -ExecutionPolicy Bypass -File scripts/status.ps1
    powershell -ExecutionPolicy Bypass -File scripts/stop.ps1

- `start-lan.ps1`：单进程 `node --import tsx` 起服，先做健康检查；已运行则幂等退出。
  可选 `-Port 8000`、`-DataDir <目录>`、`-Build`（缺前端产物时先构建）、`-CheckOnly`。
- `start-tunnel.ps1`：要求本地 `/health` 先通过，再起 cloudflared 临时隧道并打印
  `https://<随机>.trycloudflare.com`。可选 `-Port`、`-DataDir <目录>`、
  `-Cloudflared <exe>`、`-CheckOnly`。
- `status.ps1`：查看本地服务与隧道健康；`-Json` 输出单行 JSON；可选 `-Port`、`-DataDir`。
  未显式传 `-Port` 时从 `run/server.json` 读取端口，再回退 8000。
  即使状态文件过期/损坏/不匹配（`server.stateNote` = `stale`/`mismatch`/`unknown`/`broken`），
  只要该端口上的 RichMan 服务健康，仍 `ok=true`、exit 0；只有不健康才 exit 1。
- `stop.ps1`：只按 `run/server.json`、`run/tunnel.json` 里的 pid + **真实启动时间**
  停止；进程名或启动时间不符（PID 可能被复用）绝不杀进程、绝不删状态，告警并 exit 2。
  不匹配/坏状态文件同样 exit 2，重复执行仍是 exit 2 且状态保留；只有“无状态文件”
  时重复执行才是幂等 exit 0。停止动作本身失败（如权限不足）同样 exit 2，
  `reason=STOP_FAILED`、状态文件保留，不会打印“已全部停止”。
- 状态文件缺失/损坏、进程不匹配时的退出码 **2** 表示“需要人工确认”，不是普通失败。
- 状态与日志落在数据目录（默认 `apps/server/data`；四个脚本都支持 `-DataDir`，
  未显式传时依次读 `RICHMAN_DATA_DIR`、再回退 `apps/server/data`）：
  `run/server.json`、`run/tunnel.json`、`logs/server-*.log`、`logs/tunnel-*.log`。
- 隧道域名每次重启都会变；换域名后请用“房间码 + 恢复码”恢复。
- 手机访问需允许 Windows 防火墙入站 TCP（默认端口 8000，需管理员）；
  笔记本电池策略可能让服务睡眠，建议接电源或设置“接通电源时永不睡眠”。
- 非 Windows 仍使用 `corepack pnpm -s start`（隧道可用任意 cloudflared 客户端）。

## 玩法与界面

- 每轮顺序：利息 → 银行到期 → 玩家行动 → 全员下注 →（第 3/6/9… 轮）税收 → 本轮结算。
- 银行普通贷款最多借「当前金币的 50%」，每轮利息 10%，发放轮之后第 N+3 轮计息完到期；
  到期余额不足直接失信，失信后不能还款、不再计息、不能再借银行、下注只能 1 倍，但不会被淘汰。
- 私人借贷由借款人填金额与利率（0～10000 基点），出借人 45 秒内答复；同一时间只处理一个待答复请求；
  出借人最多可收「剩余应收」与「对方当前金币」的较小值，借出当轮不能催收；借款人破产记坏账，出借人破产则合同冻结。
- 危险（金币为负）可在自救阶段向银行/玩家筹钱，否则破产；最后一名未破产者获胜。
- 隐私：只看得到别人的昵称、座位、存活、信用、失信欠款；看不到别人的贷款、下注金额与猜测；
  下注结算也只下发本人的注额、输赢与余额变化。
- 教程 5 页、规则 8 节，可跳过、可重看；教程与查账都不消耗行动。

## 规则速览

2～10 人，每人 100 金币，最后一名未破产者获胜；每轮计息、银行到期、玩家行动、共同赌博，每三轮纳税；
可向银行或玩家借款、还款、催债；失信后不可还款、永久失信但不会被淘汰；危险（金币为负）可自救，否则破产。

细节一律以 V1.3.3 第三节（R01～R10）与 `handoff/规则决策表.txt` 为准。

## 目录

    AGENTS.md              给 AI 的工作守则（AI 先读这个）
    README.md              你正在看的这份
    CHANGELOG.md           版本与变更记录
    LICENSE                MIT 许可证
    docs/
      INDEX.md             文件索引：每个文件是什么、什么时候读
      plans/               三份开发方案（V1.3.3 为唯一施工版）
      reference/           原始源码（只读）
      notes/               审计记录
    handoff/
      项目当前状态.txt     当前进度、下一单元、阻塞
      规则决策表.txt       规则编号与来源 + 已确认的用户决策
      单元NN-*.txt         每单元四类交接（成果/运行验收/下一阶段/注意事项）
      复核-单元NN*.txt     Qoder 只读复核报告
    packages/shared/       金额编解码、协议 schema、类型、冻结常量
    packages/game-core/    规则引擎、阶段机、视图投影
    apps/server/            HTTP + WebSocket 服务、房间/会话/命令队列/调度、存档与备份
    apps/web/              React + Vite 引导式界面、教程、音频、手机适配
    scripts/               启停/状态/备份/恢复/清理（PowerShell）与冒烟脚本
    apps/server/data/      默认存档目录（不入 Git，绝不公网可访问）
    artifacts/test-logs/   测试日志（不入 Git）

## 文档与权威

| 文件 | 作用 | 权威 |
|---|---|---|
| docs/plans/Richman分阶段联机开发方案_V1.3精简施工版.txt | **唯一施工依据**。规则、单元、验收（当前 V1.3.3） | 最高 |
| docs/plans/Richman分阶段联机开发方案_V1.2修订版.txt | 完整规格，规则全集与来龙去脉 | 参考 |
| docs/plans/Richman分阶段联机开发方案.txt | 初版（V1.1），连接方式的历史来源 | 仅历史 |
| docs/reference/大富翁.cpp | 原始 C++ 源码，规则来源 | 规则来源，但已知 bug 以方案为准 |

冲突时：V1.3 > V1.2 > V1.1 > 源码。V1.3 没写到的，不要自己发明，先问。

## 给 AI 的开工话术

    cd D:\Lianjunjie\biancheng\RichMan
    请读 AGENTS.md、handoff/项目当前状态.txt 与 handoff/规则决策表.txt，然后只执行方案 V1.3.3 的当前单元。
    先列改动文件与验收，写会失败的测试，再实现并运行真实命令；完成后写四类交接并复核。

一次只做一个单元；每个单元结束后更新 `handoff/项目当前状态.txt`，由 Lead 验收后提交。
## 备份、恢复与清理（Windows）

三个脚本使用 Windows PowerShell 5.1 兼容语法，支持 `-Json` 输出一行 JSON。以下使用自选数据目录；省略 `-DataDir` 时沿用启动脚本的目录解析规则。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup.ps1 -DataDir D:\RichManData -Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restore.ps1 -DataDir D:\RichManData -Backup D:\RichManData\backups\richman-backup-20261108-120000 -All -Json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/cleanup.ps1 -DataDir D:\RichManData -DryRun -Json
```

备份可在服务运行时读取完整的 `snapshot.json`。省略 `-Out` 时在 `<DataDir>\backups\richman-backup-<时间戳>` 创建全新目录；显式指定 `-Out` 必须指向尚不存在的路径，已有空目录也不能复用；目录或文件只要已存在，脚本均以 `BACKUP_OUT_EXISTS`、退出码 2 拒绝且不写入。可用 `-WithAudit` 复制已有审计日志，`-Keep N` 在备份后保留最近 N 份；默认 `-Keep 0` 不删除旧备份。

```text
richman-backup-<时间戳>/
  manifest.json
  rooms/<房间码>/snapshot.json
  rooms/<房间码>/events.ndjson    # 仅 -WithAudit 且源文件存在时
```

**恢复前必须停止服务**：先运行 `scripts/stop.ps1 -DataDir D:\RichManData` 并确认已退出。恢复脚本同时检查进程归属和端口 `/health`。`run/server.json` 缺失或损坏时，自定义端口必须显式传 `-Port`，否则只探测 8000，不能据此认定其它端口上的服务已停止。服务仍在运行就以 `SERVICE_RUNNING`、退出码 2 拒绝，且不写入数据。用 `-Room 0042` 恢复指定房间，或用 `-All` 恢复备份中全部房间；两者不能同时使用。目标房间已经存在时必须显式加 `-Force`，旧档保留为 `rooms/restore-keep-*`，需要人工保留或清理。恢复完运行 `scripts/start-lan.ps1 -DataDir D:\RichManData`；房间按暂停态载入，由房主在界面点“继续游戏”。

清理默认保留每类日志 20 个（server/tunnel 分别计）、备份 10 份、损坏隔离目录 5 个，仅删除超过 24 小时的 `.tmp` 普通文件；可用 `-KeepLogs`、`-KeepBackups`、`-KeepCorrupt`、`-TmpHours` 调整。先用 `-DryRun` 查看 `wouldRemove` 四类计数；此时没有实际删除，核心 `removed` 数组保持空，脚本 `removed` 计数为 0。正式清理逐项报告 `failed`，单项失败不阻止其它项；不会删除有效房间或 `restore-keep-*`。数据目录不存在时返回 `DATA_DIR_MISSING`、退出码 1；存在但没有可清理项时仍成功返回零计数。

退出码：0 为成功；1 为参数、校验、运行或清理项失败；2 为需要人工处理（显式输出路径已存在（含空目录）、恢复目标已存在、服务仍在运行）。

备份包含身份摘要和私有账务，不得公开、上传或贴到聊天。核心备份写入口 `outDir` 及其任一父路径不允许是符号链接或 junction，创建前检查并以 `BACKUP_OUT_INVALID` 拒绝；显式 `-Out` 本身已存在时，脚本会先按 `BACKUP_OUT_EXISTS` 拒绝。只读 `backupDir`（校验/恢复所用的备份目录）允许跟随链接，但仍应使用可信目录。空备份不可用于恢复。

## 许可证

代码与自制 8-bit 音频以 MIT 许可证发布，见 [LICENSE](LICENSE)。
音频由 `apps/web/scripts/make-audio.mjs` 现场合成，不含任何第三方采样或音乐素材；
若替换为外部素材，必须在此登记来源与许可证。备份文件含身份摘要与私有账务，不得公开、上传或贴到聊天。
