/**
 * 07C 第三轮 S-A：暂停门禁的唯一文案来源。
 * UI 由 GameView 的 showConfirmation 拦截；send() 这一层是纵深防御，
 * 用纯函数 + 源码契约测试锁住，避免删除守卫后 642 条测试仍全绿。
 */
export const PAUSED_SUBMIT_NOTICE = "房间已暂停，继续后才能提交；本次未发送";

export function pausedSubmitNotice(paused: boolean): string | null {
  return paused ? PAUSED_SUBMIT_NOTICE : null;
}
