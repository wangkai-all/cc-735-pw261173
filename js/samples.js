import { DEFAULT_DRAFT } from './input.js';

function repeatLines(specs) {
  const lines = [];
  let n = 0;
  const add = (count, text) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      lines.push(`S${String(n).padStart(3, '0')}: ${text}`);
    }
  };
  for (const [count, text] of specs) add(count, text);
  return lines.join('\n');
}

const tieBallots = [
  ...Array.from({ length: 4 }, () => '阿明 > 陈清'),
  ...Array.from({ length: 2 }, () => '白岚 > 陈清 > 多瑙'),
  ...Array.from({ length: 2 }, () => '陈清 > 白岚 > 多瑙'),
  ...Array.from({ length: 2 }, () => '多瑙'),
]
  .map((prefs, i) => `T${String(i + 1).padStart(2, '0')}: ${prefs}`)
  .join('\n');

const longChainBallots = repeatLines([
  [15, '甲 > 乙 > 丙 > 丁 > 戊 > 己'],
  [9, '乙 > 丙 > 丁 > 戊 > 己'],
  [9, '丙 > 丁 > 戊 > 己'],
  [9, '丁 > 戊 > 己'],
  [9, '戊 > 己'],
  [4, '己'],
]);

const duplicateBallots = `D01: 周衡 > 周衡 > 林杉 > 林杉 > 许和
D02: 林杉 > 许和 > 林杉
D03: 许和 > 周衡 > 周衡
D04: 周衡 > 不存在的候选人 > 林杉
D05: 林杉 > 许和
D06: 许和 > 周衡`;

const noPreferenceBallots = `N01:
N02: .
N03: 火星 > 虚空
N04: 空白 > 无效候选
N05: 沈一 > 韩二
N06: 沈一 > 韩二
N07: 韩二 > 沈一
N08: 韩二 > 沈一
N09: 韩二 > 周三
N10: 周三 > 沈一`;

export const SAMPLES = [
  {
    id: 'tie-three-way',
    name: '三方最低票并列',
    description: '第 2 轮白岚、陈清、多瑙精确同分；可保存三个裁决分支，其中撤销多瑙后还会出现第二次并列。',
    draft: {
      ...DEFAULT_DRAFT,
      title: '样例 A：三方并列与分支裁决',
      seats: 2,
      candidateText: '阿明\n白岚\n陈清\n多瑙',
      ballotText: tieBallots,
      tiePolicy: 'manual',
      ballotOrder: 'input',
    },
  },
  {
    id: 'duplicate-candidates',
    name: '重复候选偏好',
    description: '同一张票重复填写候选人；默认只保留首次出现，后续重复项给出审计提示而不是用浮点或猜测处理。',
    draft: {
      ...DEFAULT_DRAFT,
      title: '样例 B：重复候选',
      seats: 1,
      candidateText: '周衡\n林杉\n许和',
      ballotText: duplicateBallots,
      duplicatePreference: 'first',
      tiePolicy: 'candidate-order',
    },
  },
  {
    id: 'no-valid-preference',
    name: '空白与无有效偏好',
    description: '包含显式空票、点号空票、未知候选票；这些票在初始分配时精确计入耗尽票，但仍满足总票值守恒。',
    draft: {
      ...DEFAULT_DRAFT,
      title: '样例 C：无有效偏好与耗尽票',
      seats: 2,
      candidateText: '沈一\n韩二\n周三',
      ballotText: noPreferenceBallots,
      tiePolicy: 'candidate-order',
    },
  },
  {
    id: 'fraction-long-chain',
    name: '分数长链转移',
    description: '55 张票、5 席、Droop 配额 10；一张原票连续经过 5 次余额系数，最终出现 1/3003 的精确票值。',
    draft: {
      ...DEFAULT_DRAFT,
      title: '样例 D：精确分数长链',
      seats: 5,
      candidateText: '甲\n乙\n丙\n丁\n戊\n己',
      ballotText: longChainBallots,
      tiePolicy: 'candidate-order',
      ballotOrder: 'input',
    },
  },
];

export function getSample(id) {
  return SAMPLES.find((sample) => sample.id === id) ?? SAMPLES[0];
}
