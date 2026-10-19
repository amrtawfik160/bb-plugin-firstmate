import { createOwnerAsks } from '../lib/owner-asks.ts';
import { createProductionApprovals } from '../lib/production-approval.ts';

/** Fixture for an owner-approved card at the exact head under test. */
export function approvePr(db: Parameters<typeof createOwnerAsks>[0], captain: string, pr: string, head: string): void {
  const asks = createOwnerAsks(db);
  const ask = asks.create({captain,kind:'approval',text:`Merge ${pr}?`,options:[{label:'Approve',value:'approve'},{label:'No',value:'no'}],createdAt:Date.now()});
  createProductionApprovals(db).bindCard(ask.id,[{pr,head}]);
  const at=Date.now();
  asks.resolve(ask.id,captain,'answered','Approve',at,'owner',{tapId:'test:'+ask.id,answeredAt:at});
}
