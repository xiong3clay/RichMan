import { useEffect, useState } from "react";
import { HealthResponseSchema, type HealthResponse } from "@richman/shared";

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/health")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const parsed = HealthResponseSchema.safeParse(data);
        if (parsed.success) setHealth(parsed.data);
        else setError("健康检查返回格式不正确");
      })
      .catch(() => {
        if (!cancelled) setError("连不上本地服务，请确认服务器已启动");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <h1>RichMan</h1>
      <p className="subtitle">单元 00 骨架：页面能打开、能连上服务，就说明这条路通了。</p>
      <section className="card">
        <h2>服务状态</h2>
        {health ? (
          <ul>
            <li>服务：{health.service}，版本 {health.version}</li>
            <li>协议版本：{health.protocolVersion}</li>
            <li>在线连接：{health.connections}</li>
            <li>房间数：{health.rooms}</li>
            <li>已运行：{health.uptimeSec} 秒</li>
          </ul>
        ) : error ? (
          <p className="error">{error}</p>
        ) : (
          <p>检查中…</p>
        )}
      </section>
      <p className="note">游戏规则、房间、联机在后续单元实现；这里故意保持空架子。</p>
    </main>
  );
}
