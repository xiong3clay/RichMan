# docs/INDEX.md — 文件索引

读文件前先看这张表，别把历史稿当施工依据。

| 路径 | 类型 | 权威 | 什么时候读 | 备注 |
|---|---|---|---|---|
| ../AGENTS.md | 守则 | 流程最高 | 每次开工 | AI 的流程规定 |
| plans/Richman分阶段联机开发方案_V1.3精简施工版.txt | 方案 | 规则最高 | 每次开工 | 唯一施工依据 V1.3.3，10 单元 |
| plans/Richman分阶段联机开发方案_V1.2修订版.txt | 方案 | 参考 | 追溯规则来源 | 规则全集，653 行 |
| plans/Richman分阶段联机开发方案.txt | 方案 | 仅历史 | 几乎不用 | V1.1，连接方式来源 |
| reference/大富翁.cpp | 源码 | 规则来源 | 追溯规则时 | 1047 行，float 算钱，有已知 bug |
| notes/审计-V1.2到V1.3覆盖差异.txt | 审计 | 说明性 | 怀疑 V1.3 漏规则时 | 解释三处改动与补回项，不构成规则 |
| ../handoff/项目当前状态.txt | 状态 | 事实 | 每次开工 | 上一轮到哪、下一单元 |
| ../handoff/规则决策表.txt | 规则 | 事实 | 单元 00 之后 | 规则编号 R01～R10 与来源标签 |

## 方案里四个"改动点"（读 V1.3 前后各看一遍）

1. 金额用 number 整数分（上限 10^12 分），不是 bigint；乘除只在 money.ts 里用一次 BigInt。
2. 存档用单文件 JSON 快照作提交点（rename 即提交），不是 SQLite；RoomStore 接口保留可换实现。
3. 阶段 14 个子阶段合并成 10 个单元，可按 04A/07B 拆分，编号不变。
4. 金额容量从 V1.2 的 10^30-1 下调到 10^12，属规则数值变更，写进决策表。

## 交付物在哪里

- 代码：apps/（服务端与网页）、packages/（共享协议与规则引擎），当前开发版 0.9.0
- 版本记录：CHANGELOG.md；许可证：LICENSE（MIT，含自制音频声明）
- 交接：handoff/单元NN-*.txt（四类）与 handoff/复核-单元NN*.txt（Qoder 复核）
- 测试证据：artifacts/test-logs/ 与 apps/web/artifacts/mobile-metrics.txt
- 存档：apps/server/data/（默认，入 .gitignore；可用 RICHMAN_DATA_DIR 覆盖）
