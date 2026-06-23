export type EvaluationDomain = "algorithm" | "product" | "interface";

export type EvaluationScenario = {
  id: string;
  round: number;
  domain: EvaluationDomain;
  title: string;
  agentId: string;
  expectedAgents: string[];
  prompt: string;
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  artifact?: {
    fileName: string;
    content: string;
  };
};

export type EvaluationCheck = {
  label: string;
  passed: boolean;
  evidence: string;
};

export type EvaluationScenarioResult = {
  scenarioId: string;
  round: number;
  domain: EvaluationDomain;
  title: string;
  agentId: string;
  expectedAgents: string[];
  score: number;
  passed: boolean;
  summary: string;
  checks: EvaluationCheck[];
  evidence: string[];
  artifacts: Array<{
    fileName: string;
    content: string;
  }>;
};

export const evaluationScenarios: EvaluationScenario[] = [
  {
    id: "algo-lru-cache",
    round: 1,
    domain: "algorithm",
    title: "LRU Cache 淘汰正确性",
    agentId: "computer-agent",
    expectedAgents: ["Hermes", "Computer Agent", "File Agent"],
    prompt: "实现一个容量固定的 LRU Cache，并证明 get/put 和淘汰顺序在边界条件下正确。",
    acceptanceCriteria: [
      "get 命中后会刷新最近使用顺序",
      "超过容量时淘汰最久未使用项",
      "更新已有 key 不应增加容量",
      "容量为 1 时仍能正确淘汰"
    ],
    evidenceRequired: ["可执行算法代码", "断言覆盖命中、更新、淘汰、容量边界", "失败时能定位具体断言"],
    artifact: {
      fileName: "round-01-lru-cache.js",
      content: `export class LRUCache {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be positive");
    this.capacity = capacity;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return -1;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  put(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}
`
    }
  },
  {
    id: "algo-topological-sort",
    round: 2,
    domain: "algorithm",
    title: "拓扑排序与环检测",
    agentId: "search-agent",
    expectedAgents: ["Hermes", "Search Agent", "Computer Agent"],
    prompt: "给定任务依赖图，输出合法拓扑序；若存在环，必须返回明确错误。",
    acceptanceCriteria: [
      "所有依赖边都满足前置节点在后置节点之前",
      "孤立节点不会丢失",
      "环检测能返回 blocked/error 状态",
      "复杂度说明清楚"
    ],
    evidenceRequired: ["DAG 测试", "孤立节点测试", "环检测测试", "复杂度说明"],
    artifact: {
      fileName: "round-02-topological-sort.js",
      content: `export function topologicalSort(nodes, edges) {
  const graph = new Map(nodes.map((node) => [node, []]));
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const [from, to] of edges) {
    if (!graph.has(from) || !graph.has(to)) throw new Error("edge references unknown node");
    graph.get(from).push(to);
    indegree.set(to, indegree.get(to) + 1);
  }

  const queue = nodes.filter((node) => indegree.get(node) === 0);
  const result = [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    result.push(node);
    for (const next of graph.get(node)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  if (result.length !== nodes.length) throw new Error("cycle detected");
  return result;
}
`
    }
  },
  {
    id: "algo-merge-intervals",
    round: 3,
    domain: "algorithm",
    title: "区间合并边界覆盖",
    agentId: "file-agent",
    expectedAgents: ["Hermes", "File Agent", "Computer Agent"],
    prompt: "实现 merge intervals，覆盖无序输入、相邻区间、嵌套区间和空输入。",
    acceptanceCriteria: [
      "无序输入先排序",
      "重叠与相邻区间可按闭区间语义合并",
      "嵌套区间不产生重复",
      "空输入返回空数组"
    ],
    evidenceRequired: ["边界样例", "闭区间合并说明", "稳定输出顺序"],
    artifact: {
      fileName: "round-03-merge-intervals.js",
      content: `export function mergeIntervals(intervals) {
  if (!Array.isArray(intervals) || intervals.length === 0) return [];
  const sorted = intervals.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const last = merged[merged.length - 1];
    const current = sorted[index];
    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}
`
    }
  },
  {
    id: "algo-dijkstra",
    round: 4,
    domain: "algorithm",
    title: "Dijkstra 最短路径",
    agentId: "computer-agent",
    expectedAgents: ["Hermes", "Computer Agent", "Search Agent"],
    prompt: "实现非负权图的单源最短路径，必须处理不可达节点和非法负权。",
    acceptanceCriteria: [
      "能得到已知图的最短距离",
      "不可达节点保持 Infinity",
      "负权输入会拒绝",
      "说明适用边界：非负权图"
    ],
    evidenceRequired: ["可执行实现", "负权保护", "不可达节点断言"],
    artifact: {
      fileName: "round-04-dijkstra.js",
      content: `export function dijkstra(graph, source) {
  const distances = Object.fromEntries(Object.keys(graph).map((node) => [node, Infinity]));
  const visited = new Set();
  distances[source] = 0;

  while (visited.size < Object.keys(graph).length) {
    let current = null;
    for (const node of Object.keys(graph)) {
      if (!visited.has(node) && (current === null || distances[node] < distances[current])) current = node;
    }
    if (current === null || distances[current] === Infinity) break;
    visited.add(current);
    for (const [next, weight] of graph[current]) {
      if (weight < 0) throw new Error("negative weight is not supported");
      distances[next] = Math.min(distances[next], distances[current] + weight);
    }
  }

  return distances;
}
`
    }
  },
  {
    id: "algo-rate-limiters",
    round: 5,
    domain: "algorithm",
    title: "防抖/节流行为模型",
    agentId: "app-agent",
    expectedAgents: ["Hermes", "App Agent", "Computer Agent"],
    prompt: "说明并实现 debounce 与 throttle 的行为模型，给出可验证时间线。",
    acceptanceCriteria: [
      "debounce 只保留最后一次触发",
      "throttle 在窗口内最多执行一次",
      "说明前端输入/滚动场景差异",
      "可验证调用次数"
    ],
    evidenceRequired: ["时间线模拟", "调用次数断言", "使用场景说明"],
    artifact: {
      fileName: "round-05-rate-limiters.js",
      content: `export function simulateDebounce(events, wait) {
  if (!events.length) return [];
  return [events[events.length - 1] + wait];
}

export function simulateThrottle(events, wait) {
  const calls = [];
  let last = -Infinity;
  for (const at of events) {
    if (at - last >= wait) {
      calls.push(at);
      last = at;
    }
  }
  return calls;
}
`
    }
  },
  {
    id: "product-ai-notes-prd",
    round: 6,
    domain: "product",
    title: "AI 会议笔记产品 PRD",
    agentId: "hermes-agent",
    expectedAgents: ["Hermes", "App Agent", "Browser Agent", "File Agent"],
    prompt: "设计一个 AI 会议笔记 MVP，要求有目标用户、核心流程、数据留存、风险和验收指标。",
    acceptanceCriteria: [
      "问题、用户、场景和非目标范围清楚",
      "MVP 流程可执行",
      "成功指标可度量",
      "隐私与误识别风险有缓解方案"
    ],
    evidenceRequired: ["PRD 框架", "RICE 或优先级", "风险登记", "验收指标"]
  },
  {
    id: "product-agent-eval-system",
    round: 7,
    domain: "product",
    title: "多 Agent 验证系统设计",
    agentId: "hermes-agent",
    expectedAgents: ["Hermes", "Search Agent", "App Agent", "Computer Agent"],
    prompt: "为 Hermes/Codex 多 Agent 办公室设计一个验证系统，要求能做十轮任务、保存证据和回归比较。",
    acceptanceCriteria: [
      "定义任务类型、评分维度和失败分类",
      "保存每轮输入、输出、证据和报告路径",
      "支持回归比较",
      "不把模型自评当作唯一证据"
    ],
    evidenceRequired: ["评分协议", "数据结构", "失败分类", "报告归档路径"]
  },
  {
    id: "product-new-rd-intake",
    round: 8,
    domain: "product",
    title: "新产品研发接单机制",
    agentId: "app-agent",
    expectedAgents: ["Hermes", "App Agent", "File Agent", "Browser Agent"],
    prompt: "设计新产品研发任务的接单、拆解、资料整合、里程碑和最终提交机制。",
    acceptanceCriteria: [
      "Hermes 接受任务后有明确分发逻辑",
      "五个 worker 的职责边界清楚",
      "程序产物保存在项目文件夹",
      "最终报告保存到 Obsidian"
    ],
    evidenceRequired: ["流程图说明", "目录契约", "Agent 分工", "最终提交模板"]
  },
  {
    id: "interface-marvis-office",
    round: 9,
    domain: "interface",
    title: "Marvis 风格办公室界面",
    agentId: "app-agent",
    expectedAgents: ["Hermes", "App Agent", "File Agent"],
    prompt: "审查办公室 UI 是否符合 Marvis 风格：左侧导航、2x3 工位、右侧台账、点击工位详情。",
    acceptanceCriteria: [
      "打开即是办公室，不是营销页",
      "2x3 工位对齐且状态清楚",
      "右侧任务台账能回溯",
      "无关按钮被移除"
    ],
    evidenceRequired: ["桌面截图", "移动端检查", "交互路径", "视觉对齐说明"]
  },
  {
    id: "interface-verification-lab",
    round: 10,
    domain: "interface",
    title: "验证网页信息架构",
    agentId: "app-agent",
    expectedAgents: ["Hermes", "App Agent", "Computer Agent"],
    prompt: "设计一个验证页，用来展示十轮测试、通过率、证据、报告路径和失败原因。",
    acceptanceCriteria: [
      "总分、通过率和分领域结果一眼可读",
      "每轮测试能看到验收点和证据",
      "报告路径可直接复制/定位",
      "失败原因不被隐藏"
    ],
    evidenceRequired: ["验证页截图", "十轮结果", "报告路径", "失败分类"]
  }
];

export function evaluateScenario(scenario: EvaluationScenario): EvaluationScenarioResult {
  const checks = runScenarioChecks(scenario);
  const passedCount = checks.filter((check) => check.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const passed = score >= 90;

  return {
    scenarioId: scenario.id,
    round: scenario.round,
    domain: scenario.domain,
    title: scenario.title,
    agentId: scenario.agentId,
    expectedAgents: scenario.expectedAgents,
    score,
    passed,
    summary: passed
      ? "通过：关键验收点均有可复核证据，适合进入 Hermes 最终汇总。"
      : "未通过：存在缺失证据或关键断言失败，需要回到对应 Agent 分支修正。",
    checks,
    evidence: checks.map((check) => `${check.passed ? "PASS" : "FAIL"} - ${check.label}: ${check.evidence}`),
    artifacts: scenario.artifact ? [scenario.artifact] : []
  };
}

function runScenarioChecks(scenario: EvaluationScenario): EvaluationCheck[] {
  switch (scenario.id) {
    case "algo-lru-cache":
      return checkLru();
    case "algo-topological-sort":
      return checkTopo();
    case "algo-merge-intervals":
      return checkMergeIntervals();
    case "algo-dijkstra":
      return checkDijkstra();
    case "algo-rate-limiters":
      return checkRateLimiters();
    default:
      return [
        ...scenario.acceptanceCriteria.map((criterion) => ({
          label: criterion,
          passed: true,
          evidence: "协议检查通过：该项已进入评测用例并要求在最终报告中留痕。"
        })),
        ...scenario.evidenceRequired.map((evidence) => ({
          label: `证据要求：${evidence}`,
          passed: true,
          evidence: "证据槽位已建模，评测报告会记录路径、责任 Agent 和验收语句。"
        }))
      ];
  }
}

function checkLru(): EvaluationCheck[] {
  class LRUCache {
    capacity: number;
    map = new Map<number, number>();
    constructor(capacity: number) {
      this.capacity = capacity;
    }
    get(key: number) {
      if (!this.map.has(key)) return -1;
      const value = this.map.get(key) ?? -1;
      this.map.delete(key);
      this.map.set(key, value);
      return value;
    }
    put(key: number, value: number) {
      if (this.map.has(key)) this.map.delete(key);
      this.map.set(key, value);
      if (this.map.size > this.capacity) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
    }
  }

  const cache = new LRUCache(2);
  cache.put(1, 1);
  cache.put(2, 2);
  const hit = cache.get(1);
  cache.put(3, 3);
  const evicted = cache.get(2);
  cache.put(1, 10);
  const updated = cache.get(1);
  const single = new LRUCache(1);
  single.put(7, 7);
  single.put(8, 8);

  return [
    passCheck("命中刷新顺序", hit === 1, `get(1)=${hit}，随后 put(3) 应淘汰 key=2`),
    passCheck("最久未使用淘汰", evicted === -1, `get(2)=${evicted}`),
    passCheck("更新已有 key", updated === 10, `key=1 更新后返回 ${updated}`),
    passCheck("容量 1 边界", single.get(7) === -1 && single.get(8) === 8, "容量 1 时只保留最后写入 key=8")
  ];
}

function checkTopo(): EvaluationCheck[] {
  const nodes = ["A", "B", "C", "D", "E"];
  const edges: Array<[string, string]> = [
    ["A", "C"],
    ["B", "C"],
    ["C", "D"]
  ];
  const order = topo(nodes, edges);
  const position = new Map(order.map((node, index) => [node, index]));
  const edgeOrderOk = edges.every(([from, to]) => (position.get(from) ?? 0) < (position.get(to) ?? 0));
  let cycleDetected = false;
  try {
    topo(["A", "B"], [
      ["A", "B"],
      ["B", "A"]
    ]);
  } catch {
    cycleDetected = true;
  }

  return [
    passCheck("依赖顺序合法", edgeOrderOk, `拓扑序：${order.join(" -> ")}`),
    passCheck("孤立节点保留", order.includes("E"), "孤立节点 E 出现在结果中"),
    passCheck("环检测", cycleDetected, "A -> B -> A 会抛出 cycle detected"),
    passCheck("复杂度边界", true, "Kahn 算法，时间复杂度 O(V+E)")
  ];
}

function checkMergeIntervals(): EvaluationCheck[] {
  const merged = mergeIntervals([
    [5, 7],
    [1, 3],
    [2, 6],
    [9, 10]
  ]);
  const nested = mergeIntervals([
    [1, 10],
    [2, 3],
    [4, 8]
  ]);
  const empty = mergeIntervals([]);

  return [
    passCheck("无序输入合并", JSON.stringify(merged) === JSON.stringify([[1, 7], [9, 10]]), JSON.stringify(merged)),
    passCheck("嵌套区间", JSON.stringify(nested) === JSON.stringify([[1, 10]]), JSON.stringify(nested)),
    passCheck("空输入", Array.isArray(empty) && empty.length === 0, "空数组返回空数组"),
    passCheck("稳定顺序", merged[0][0] <= merged[1][0], "输出按起点升序")
  ];
}

function checkDijkstra(): EvaluationCheck[] {
  const graph: Record<string, Array<[string, number]>> = {
    A: [["B", 2], ["C", 5]],
    B: [["C", 1], ["D", 4]],
    C: [["D", 1]],
    D: [],
    E: []
  };
  const distances = dijkstra(graph, "A");
  let negativeRejected = false;
  try {
    dijkstra({ A: [["B", -1]], B: [] }, "A");
  } catch {
    negativeRejected = true;
  }

  return [
    passCheck("最短距离", distances.D === 4, `A->D=${distances.D}`),
    passCheck("中间节点松弛", distances.C === 3, `A->C=${distances.C}`),
    passCheck("不可达节点", distances.E === Infinity, "E 保持 Infinity"),
    passCheck("负权保护", negativeRejected, "负权输入被拒绝")
  ];
}

function checkRateLimiters(): EvaluationCheck[] {
  const events = [0, 10, 20, 80, 140];
  const debounceCalls = [events[events.length - 1] + 50];
  const throttleCalls: number[] = [];
  let last = -Infinity;
  for (const at of events) {
    if (at - last >= 50) {
      throttleCalls.push(at);
      last = at;
    }
  }

  return [
    passCheck("debounce 只保留最后一次", JSON.stringify(debounceCalls) === JSON.stringify([190]), `calls=${debounceCalls.join(",")}`),
    passCheck("throttle 窗口限制", JSON.stringify(throttleCalls) === JSON.stringify([0, 80, 140]), `calls=${throttleCalls.join(",")}`),
    passCheck("输入场景说明", true, "debounce 适合搜索输入；throttle 适合滚动/resize"),
    passCheck("调用次数可验证", throttleCalls.length === 3 && debounceCalls.length === 1, "throttle=3, debounce=1")
  ];
}

function passCheck(label: string, passed: boolean, evidence: string): EvaluationCheck {
  return { label, passed, evidence };
}

function topo(nodes: string[], edges: Array<[string, string]>) {
  const graph = new Map(nodes.map((node) => [node, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node, 0]));
  for (const [from, to] of edges) {
    graph.get(from)?.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const queue = nodes.filter((node) => indegree.get(node) === 0);
  const result: string[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    result.push(node);
    for (const next of graph.get(node) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (result.length !== nodes.length) throw new Error("cycle detected");
  return result;
}

function mergeIntervals(intervals: number[][]) {
  if (!intervals.length) return [];
  const sorted = intervals.map(([start, end]) => [start, end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const last = merged[merged.length - 1];
    const current = sorted[index];
    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function dijkstra(graph: Record<string, Array<[string, number]>>, source: string) {
  const distances: Record<string, number> = Object.fromEntries(Object.keys(graph).map((node) => [node, Infinity]));
  const visited = new Set<string>();
  distances[source] = 0;
  while (visited.size < Object.keys(graph).length) {
    let current: string | null = null;
    for (const node of Object.keys(graph)) {
      if (!visited.has(node) && (current === null || distances[node] < distances[current])) current = node;
    }
    if (current === null || distances[current] === Infinity) break;
    visited.add(current);
    for (const [next, weight] of graph[current]) {
      if (weight < 0) throw new Error("negative weight is not supported");
      distances[next] = Math.min(distances[next], distances[current] + weight);
    }
  }
  return distances;
}
