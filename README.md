# RichMan（大富翁联机版）

一个从 C++ 控制台游戏改造成"开服电脑 + 浏览器多端联机"的回合制金融生存游戏。

## 当前状态

**单元 00～04 与 05A/05C/05D/05E/05F 已完成**：规则引擎 + 同源服务端 + 引导式网页 UI（大厅/按阶段一次一问/断线恢复）
都可用；单元 05 的真人试玩（05B）已完成第一轮反馈并修复（提示吸顶可见、借款额度提示），真机复测仍在进行。

- 方案版本：V1.3.3（施工版）
- 已实现单元：00、01、02、03、04、05A、05C、05D、05E、05F
- 测试：29 文件 / 443 条（core 148、server 112、web 183）
- 双客户端冒烟：pnpm smoke:lan
- 代码提交：见 git log

## 快速开始

    pnpm install
    pnpm test          # 29 文件 / 443 条测试
    pnpm smoke:lan     # 双客户端冒烟（真实服务 + 两个 WS）
    pnpm typecheck
    pnpm build
    pnpm start         # http://localhost:8000/ ，/health

手机同一局域网访问启动日志里打印的 LAN 地址（默认 8000 端口）。

## 一键启动 / 停止（Windows）

脚本同时兼容 Windows PowerShell 5.1 与 pwsh 7，`.ps1` 均保存为 UTF-8 with BOM：

    powershell -ExecutionPolicy Bypass -File scripts/start-lan.ps1
    powershell -ExecutionPolicy Bypass -File scripts/start-tunnel.ps1
    powershell -ExecutionPolicy Bypass -File scripts/status.ps1
    powershell -ExecutionPolicy Bypass -File scripts/stop.ps1

- `start-lan.ps1`：单进程 `node --import tsx` 起服，先做健康检查；已运行则幂等退出。
  可选 `-Port 8000`、`-DataDir <目录>`、`-Build`（缺前端产物时先构建）、`-CheckOnly`。
- `start-tunnel.ps1`：要求本地 `/health` 先通过，再起 cloudflared 临时隧道并打印
  `https://<随机>.trycloudflare.com`。可选 `-Port`、`-Cloudflared <exe>`、`-CheckOnly`。
- `status.ps1`：查看本地服务与隧道健康；`-Json` 输出单行 JSON；可选 `-Port`、`-DataDir`。
- `stop.ps1`：只按 `run/server.json`、`run/tunnel.json` 里的 pid + 进程名白名单停止，
  绝不按端口杀陌生进程；可重复执行（幂等）。
- 状态与日志落在数据目录（默认 `apps/server/data`，可用 `-DataDir` 或
  `RICHMAN_DATA_DIR` 覆盖）：`run/server.json`、`run/tunnel.json`、
  `logs/server-*.log`、`logs/tunnel-*.log`。
- 隧道域名每次重启都会变；换域名后请用“房间码 + 恢复码”恢复。
- 手机访问需允许 Windows 防火墙入站 TCP（默认端口 8000，需管理员）；
  笔记本电池策略可能让服务睡眠，建议接电源或设置“接通电源时永不睡眠”。
- 非 Windows 仍使用 `corepack pnpm -s start`（隧道可用任意 cloudflared 客户端）。

## 四个指导文件在哪、哪个说了算

| 文件 | 作用 | 权威 |
|---|---|---|
| docs/plans/Richman分阶段联机开发方案_V1.3精简施工版.txt | **唯一施工依据**。10 个单元、规则、验收（当前 V1.3.2） | 最高 |
| docs/plans/Richman分阶段联机开发方案_V1.2修订版.txt | 完整规格，规则全集与来龙去脉 | 参考 |
| docs/plans/Richman分阶段联机开发方案.txt | 初版（V1.1），连接方式的历史来源 | 仅历史 |
| docs/reference/大富翁.cpp | 原始 C++ 源码，规则来源 | 规则来源，但已知 bug 以方案为准 |

冲突时：V1.3 > V1.2 > V1.1 > 源码。V1.3 没写到的，不要自己发明，先问。

## 目录

    AGENTS.md              给 AI 的工作守则（AI 先读这个）
    README.md              你正在看的这份
    docs/
      INDEX.md             文件索引：每个文件是什么、什么时候读
      plans/               三份开发方案
      reference/           原始源码（只读）
      notes/               审计记录
    handoff/
      项目当前状态.txt     当前进度、下一单元、阻塞
      规则决策表.txt       规则编号与来源 + 已确认的用户决策
      单元00-*.txt         四类交接（成果/运行验收/下一阶段/注意事项）
    packages/shared/       金额编解码、协议 schema、类型、冻结常量
    packages/game-core/    规则引擎（applyCommand 尚未实现，单元 03）
    apps/server/           HTTP 服务（现在只有 /health，WebSocket 在单元 04）
    apps/web/              React + Vite 空页面
    artifacts/test-logs/   测试日志（不入 Git）
    data/                  存档目录（不入 Git，绝不公网可访问）

## 给 AI 的开工话术

    cd D:\Lianjunjie\biancheng\RichMan
    请读 AGENTS.md 和 handoff/单元00-下一阶段交接.txt，然后只执行方案 V1.3.2 的单元 01。
    先列改动文件与验收，写会失败的测试，再实现并运行真实命令；完成后写四类交接并提交。

一次只做一个单元；每个单元结束后更新 handoff/项目当前状态.txt。

## 规则速览

2～10 人，每人 100 金币，最后一名未破产者获胜；每轮计息、银行到期、玩家行动、共同赌博，每三轮纳税；
可向银行或玩家借款、还款、催债；失信后不可还款、永久失信但不会被淘汰；危险（金币为负）可自救，否则破产。

细节一律以 V1.3.2 第三节（R01～R10）为准。
