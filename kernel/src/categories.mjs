// 费用类别与 ERP 费用项目的对照表。
//
// `费用类别`是公司规则根据费用事实确定的业务分类；`费用项目`是 ERP 里的一条主数据，
// 有自己的编码。两者不是一回事，所以这里是一张**对照表**，不是一个字段的两种叫法。
//
// 每条编码都记着它的来源（`source`），因为来源不同，能承担的重量也不同：
//
//   - `erp_save_readback`：在真实 ERP 上保存过草稿并回读确认过。最强的证据。
//   - `user_declared`：由领域负责人（本项目的用户）直接给出的公司主数据。
//     它是可信的 —— 用户给的同一份对照表里，另外三条与 ERP 实测结果逐一相同 ——
//     但毕竟还没有在 ERP 上落过一条明细，所以第一次保存前要如实标注。
//
// 没有来源的编码就是 `null`，那不是待补的 TODO，是一个**硬阻塞**：
// 猜一个编码去点选择器，轻则保存失败，重则把费用挂到别人的费用项目上。

export const CATEGORIES = {
  accommodation: {
    label: '住宿',
    expenseItemCode: 'FY010001',
    expenseItemName: '住宿',
    source: 'erp_save_readback',
    verifiedBy: '住宿发票样本：ERP 明细按 FY010001 保存草稿并回读一致（save-contract）',
  },
  local_city_transport: {
    label: '本地市内交通',
    expenseItemCode: 'FY008001',
    expenseItemName: '本地市内交通',
    source: 'erp_save_readback',
    verifiedBy: '曹操出行与风韵出行样本：常驻城市广州，ERP 明细按 FY008001 保存草稿并回读一致（save-contract）',
  },
  long_distance: {
    label: '长途交通',
    expenseItemCode: 'FY010003',
    expenseItemName: '长途交通',
    source: 'erp_save_readback',
    verifiedBy: '铁路电子客票样本：合肥南至广州南，ERP 明细按 FY010003 保存草稿并回读一致（save-contract）',
  },
  remote_city_transport: {
    label: '外地市内交通',
    expenseItemCode: 'FY010002',
    expenseItemName: '外地市内交通',
    // 这一类还没有在真实 ERP 上落过明细，编码来自用户给出的公司对照表。
    // 同一份对照表里另外三条与 ERP 实测逐一相同，所以不阻塞；
    // 但在第一次保存回读确认之前，它要一直带着这条提示。
    source: 'user_declared',
    verifiedBy: '用户给出的公司费用项目对照表；同一份表里另外三条与 ERP 实测结果一致',
    unconfirmedNote: '外地市内交通的费用项目编码 FY010002 来自用户给出的公司对照表，'
      + '还没有在真实 ERP 上保存并回读确认过。第一次保存草稿之后要核对 ERP 回读的费用项目，'
      + '对不上就停下来，不要改成别的编码继续',
  },
};

export const categoryLabel = (key) => CATEGORIES[key]?.label ?? null;

/**
 * 城市名归一化，只做**书写差异**的归一，不做地理推断。
 * "广州" 和 "广州市" 是同一个城市的两种写法；"广州" 和 "广东" 不是，这里也不去猜。
 */
export const normalizeCity = (s) =>
  (s === null || s === undefined ? '' : String(s)).normalize('NFKC').trim().replace(/[市]$/, '');
