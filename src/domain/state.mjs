export function createInitialState() {
  return {
    plans: new Map(), // planId -> {planId, headVersionId, versions: Map<versionId, version>}
    batches: new Map(), // batchId -> batch
    approvals: new Map(), // approvalId -> approval
    lots: new Map(), // lotId -> lot（按入库序号 FIFO）
    lotOrder: [], // lotId 按进入本机构库存的先后
    borrows: new Map(), // borrowId -> borrow
    recalls: new Map(), // recallId -> recall
  };
}
