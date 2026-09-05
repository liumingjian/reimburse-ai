// 费用类别与 ERP 费用项目的对照表。
//
// `费用类别`是公司规则根据费用事实确定的业务分类；`费用项目`是 ERP 里的一条主数据，
// 有自己的编码。两者不是一回事，所以这里是一张**对照表**，不是一个字段的两种叫法。
//
// 这张表里的编码只有一个来源：在真实 ERP 上保存过草稿、并且回读确认过的样本。
// 没有这样的样本，编码就是 `null` —— 那不是待补的 TODO，是一个**硬阻塞**：
// 猜一个编码去点选择器，轻则保存失败，重则把费用挂到别人的费用项目上。

export const CATEGORIES = {
  accommodation: {
    label: '住宿',
    expenseItemCode: 'FY010001',
    expenseItemName: '住宿',
    verifiedBy: '住宿发票样本：ERP 明细按 FY010001 保存草稿并回读一致（save-contract）',
  },
  local_city_transport: {
    label: '本地市内交通',
    expenseItemCode: 'FY008001',
    expenseItemName: '本地市内交通',
    verifiedBy: '曹操出行与风韵出行样本：常驻城市广州，ERP 明细按 FY008001 保存草稿并回读一致（save-contract）',
  },
  long_distance: {
    label: '长途交通',
    expenseItemCode: 'FY010003',
    expenseItemName: '长途交通',
    verifiedBy: '铁路电子客票样本：合肥南至广州南，ERP 明细按 FY010003 保存草稿并回读一致（save-contract）',
  },
  remote_city_transport: {
    label: '外地市内交通',
    // 这一类在 v1 范围内，但**从来没有在真实 ERP 上落过一条明细**，
    // 因此没有可信的费用项目编码。这里如实留空，由上层形成硬阻塞。
    expenseItemCode: null,
    expenseItemName: null,
    verifiedBy: null,
    blockedNote: '外地市内交通的 ERP 费用项目编码还没有在真实 ERP 上验证过。'
      + '不能拿本地市内交通的 FY008001 顶替，也不能猜一个编码去点选择器 —— '
      + '这一条要等外地市内交通样本在 ERP 上走通并回读确认，才能填进对照表',
  },
};

export const categoryLabel = (key) => CATEGORIES[key]?.label ?? null;

/**
 * 城市名归一化，只做**书写差异**的归一，不做地理推断。
 * "广州" 和 "广州市" 是同一个城市的两种写法；"广州" 和 "广东" 不是，这里也不去猜。
 */
export const normalizeCity = (s) =>
  (s === null || s === undefined ? '' : String(s)).normalize('NFKC').trim().replace(/[市]$/, '');
