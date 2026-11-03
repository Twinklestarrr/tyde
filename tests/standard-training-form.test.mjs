import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  standardMaterialLink,
  standardTrainingDraft,
  standardTrainingInput,
} from '../apps/web/src/modules/projects/standard-training-form.ts';

const materials = {
  projectId: 701,
  standardContent: '原标准',
  standardLink: null,
  attachments: [{ id: 81, fileName: '案例.txt', fileSize: 12, objectKey: 'existing' }],
};

test('materials preserve existing attachment IDs, new upload credentials and intentional removals', () => {
  const draft = standardTrainingDraft(materials);
  draft.standardContent = ' 新标准 ';
  draft.files.push({
    key: 'new',
    name: '新标准.txt',
    size: 20,
    status: 'ready',
    reference: { objectKey: 'new', uploadToken: 'credential' },
  });
  assert.deepEqual(standardTrainingInput(materials, draft), {
    projectId: 701,
    standardContent: '新标准',
    standardLink: null,
    attachments: [
      { id: 81, sortNo: 0 },
      {
        attachmentType: 'STANDARD_REFERENCE',
        objectKey: 'new',
        uploadToken: 'credential',
        sortNo: 1,
      },
    ],
  });
  draft.files = [];
  draft.standardContent = ' ';
  draft.standardLink = ' https://example.com/standard ';
  assert.deepEqual(standardTrainingInput(materials, draft), {
    projectId: 701,
    standardContent: null,
    standardLink: 'https://example.com/standard',
    attachments: [],
  });
});

test('materials reject empty content, incomplete uploads and oversized UTF-8 JSON including attachments', () => {
  const draft = standardTrainingDraft(materials);
  draft.standardContent = ' ';
  assert.throws(() => standardTrainingInput(materials, draft), /至少填写一项/);
  draft.standardContent = '标准';
  draft.standardLink = 'a'.repeat(2001);
  assert.throws(() => standardTrainingInput(materials, draft), /2000/);
  draft.standardLink = '';
  draft.files[0].status = 'failed';
  assert.throws(() => standardTrainingInput(materials, draft), /上传/);
  draft.files = [
    { key: 'new', name: '新标准.txt', size: 12, status: 'ready', reference: { objectKey: 'new' } },
  ];
  assert.throws(() => standardTrainingInput(materials, draft), /凭证/);
  draft.files = [];
  const overhead =
    Buffer.byteLength(JSON.stringify(standardTrainingInput(materials, draft))) -
    Buffer.byteLength('标准');
  draft.standardContent = '中'.repeat(Math.floor((16384 - overhead) / 3));
  assert.ok(standardTrainingInput(materials, draft));
  draft.standardContent += '中';
  assert.throws(() => standardTrainingInput(materials, draft), /内容过长/);
  draft.standardContent = 'a'.repeat(16384 - overhead);
  assert.ok(standardTrainingInput(materials, draft));
  draft.files = standardTrainingDraft(materials).files;
  assert.throws(() => standardTrainingInput(materials, draft), /内容过长/);
  draft.files = Array.from({ length: 21 }, () => standardTrainingDraft(materials).files[0]);
  assert.throws(() => standardTrainingInput(materials, draft), /20个/);
});

test('historical links are only clickable for HTTP(S), never executable schemes', () => {
  assert.equal(
    standardMaterialLink('https://example.com/standard'),
    'https://example.com/standard',
  );
  assert.equal(standardMaterialLink('http://example.com'), 'http://example.com/');
  for (const value of [
    null,
    '',
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    '文档地址',
  ])
    assert.equal(standardMaterialLink(value), null);
});
