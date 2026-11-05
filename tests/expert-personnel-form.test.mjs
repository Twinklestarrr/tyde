import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expertTaskExample } from '../apps/server/src/modules/expert/expert-task.schema.ts';
import {
  canManageExpertPersonnel,
  isExpertPersonnelApproval,
  expertOwnerIds,
  expertOwnersInput,
} from '../apps/web/src/modules/projects/expert-personnel-form.ts';

const manager = {
  ...structuredClone(expertTaskExample),
  basicInfo: {
    ...structuredClone(expertTaskExample.basicInfo),
    subjectType: 'ORGANIZATION',
    organizationId: '00000000-0000-4000-8000-000000000003',
  },
  acceptanceStatus: 'ACCEPTED',
  accessContext: {
    projectOwner: false,
    acceptedOrganizationOwner: true,
    canViewOrganizationData: true,
  },
};
const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const candidates = ids.map((userId) => ({
  userId,
  uid: userId,
  name: '负责人',
  position: 'MEMBER',
  avatarUrl: null,
  projectOwner: false,
}));
test('expert personnel requires accepted organization duties, while an exact movement approval is independent of roster scope', () => {
  assert.equal(canManageExpertPersonnel(manager), true);
  assert.equal(
    canManageExpertPersonnel({ ...manager, acceptanceStatus: 'PENDING_ACCEPTANCE' }),
    false,
  );
  assert.equal(
    canManageExpertPersonnel({
      ...manager,
      accessContext: { ...manager.accessContext, acceptedOrganizationOwner: false },
    }),
    false,
  );
  assert.equal(
    canManageExpertPersonnel({
      ...manager,
      basicInfo: { ...manager.basicInfo, organizationId: null },
    }),
    false,
  );
  const approval = {
    ...manager,
    sourceBizType: 'PROJECT_MEMBER_TRANSFER',
    assignmentId: null,
    movementId: 9,
    branchNodeCode: 'MEMBER_MOVEMENT_APPROVAL',
    accessContext: {
      projectOwner: false,
      acceptedOrganizationOwner: false,
      canViewOrganizationData: false,
    },
  };
  assert.equal(isExpertPersonnelApproval(approval), true);
  assert.equal(canManageExpertPersonnel(approval), false);
  assert.equal(isExpertPersonnelApproval({ ...approval, branchNodeCode: 'ENTRANCE_EXAM' }), false);
  assert.equal(isExpertPersonnelApproval({ ...approval, movementId: null }), false);
});
test('owner replacement sends a complete real candidate set only from an accepted supervisor source', () => {
  assert.deepEqual(expertOwnersInput(manager, [ids[0], ids[0], ids[1]], candidates), {
    assignmentId: manager.assignmentId,
    projectOwnerUserIds: ids,
  });
  assert.throws(() => expertOwnersInput(manager, [], candidates), /1至20/);
  assert.throws(() => expertOwnersInput(manager, ['not-a-candidate'], candidates), /有效候选/);
  assert.throws(
    () =>
      expertOwnersInput(
        {
          ...manager,
          accessContext: {
            ...manager.accessContext,
            acceptedOrganizationOwner: false,
            projectOwner: true,
          },
        },
        [ids[0]],
        candidates,
      ),
    /有效主管/,
  );
  const partial = {
    ...manager,
    basicInfo: {
      ...manager.basicInfo,
      projectOwners: [{ userId: null, name: '隐藏标识', avatarUrl: null }],
    },
  };
  assert.throws(() => expertOwnersInput(partial, [ids[0]], candidates), /标识不完整/);
  assert.deepEqual(
    expertOwnerIds({
      ...manager,
      basicInfo: { ...manager.basicInfo, projectOwners: [], projectOwnerUserId: ids[0] },
    }),
    [ids[0]],
  );
  const many = Array.from({ length: 21 }, (_, i) => ({
    ...candidates[0],
    userId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  }));
  assert.throws(
    () =>
      expertOwnersInput(
        manager,
        many.map((row) => row.userId),
        many,
      ),
    /1至20/,
  );
});
