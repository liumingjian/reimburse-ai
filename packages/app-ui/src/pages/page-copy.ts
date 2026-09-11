import type { TaskPage } from '../contract/stage';

// 各任务页面的标题与导语（沿用原型）。单独成文件，页面组件与路由都从这里取，避免互相引用。
export const PAGE_COPY: Readonly<Record<TaskPage, { title: string; lead: string }>> = {
  upload: { title: '上传材料', lead: '把这次出差的发票、行程单、结账单、车票照片一起拖进来。支付截图不在这里上传。' },
  inventory: { title: '材料盘点', lead: '每份材料由对应规则认领。二维码核对、配对和金额守恒的结果在「校验」列。' },
  pending: { title: '待确认项', lead: '对照原件补填或作出选择。' },
  review: { title: '整单明细确认', lead: '候选明细按统一业务序号排列。打印稿页序与 ERP 明细行共用这个序号。' },
  print: { title: '打印稿预览', lead: '每张主要报销凭证一页 A4。页眉是业务序号、日期、费用类别与价税合计。' },
  project: { title: '项目归属', lead: '为每条候选明细指定项目号，并填写报销事由。' },
  erp: { title: 'ERP 填报', lead: '导入发票、写入明细、保存草稿、严格回读。' },
  done: { title: '完成', lead: '草稿已保存并回读一致。接下来去 ERP 提交审批，把打印稿交给财务。' },
  reconcile: { title: '对账', lead: '写入结果不确定。应用已停止写入并与 ERP 对账，不会重放。' },
};
