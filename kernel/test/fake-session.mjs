// 假会话：Runtime.evaluate 按顺序吐预先排好的返回值，其余命令只记账。
// 要钉住的是"发了哪些输入事件、在什么坐标上发"，这跟浏览器无关。
//
// 只此一份：写入路径（erpform）和只读对账路径（erpreconcile）用的是同一条缝，
// 不各自发明一种假会话 —— 两条路径对"什么算副作用"的判据必须完全一致。
export function fakeSession(evaluations) {
  const sent = [];
  const queue = [...evaluations];
  return {
    sent,
    send(method, params) {
      sent.push({ method, params });
      if (method === 'Runtime.evaluate') {
        if (queue.length === 0) throw new Error('求值次数超出预期');
        return Promise.resolve({ result: { value: queue.shift() } });
      }
      return Promise.resolve({});
    },
    close() {},
  };
}

/** 发出去的输入事件。真正的只读路径上这个数组必须是空的。 */
export const inputs = (s) => s.sent.filter((c) => c.method.startsWith('Input.'));

/** 第 n 次求值真正发进页面的那段 JS。 */
export const expressions = (s) =>
  s.sent.filter((c) => c.method === 'Runtime.evaluate').map((c) => c.params.expression);
