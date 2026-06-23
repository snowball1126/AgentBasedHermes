import {
  Activity,
  CheckCircle2,
  ClipboardCheck,
  Code2,
  FlaskConical,
  FolderOpen,
  LayoutDashboard,
  Loader2,
  PackageCheck,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getEvaluationScenarios,
  runEvaluationSuite,
  type EvaluationDomain,
  type EvaluationRun,
  type EvaluationScenario
} from "../lib/hermesClient";

type LabState = "idle" | "loading" | "running" | "ready" | "error";

const domainLabels: Record<EvaluationDomain, string> = {
  algorithm: "算法编程",
  product: "新产品研发",
  interface: "界面设计"
};

const domainIcons = {
  algorithm: Code2,
  product: PackageCheck,
  interface: LayoutDashboard
};

export function VerificationLab() {
  const [scenarios, setScenarios] = useState<EvaluationScenario[]>([]);
  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [state, setState] = useState<LabState>("loading");
  const [error, setError] = useState("");
  const [activeDomain, setActiveDomain] = useState<EvaluationDomain | "all">("all");
  const [selectedRound, setSelectedRound] = useState(1);

  useEffect(() => {
    void loadScenarios();
  }, []);

  const visibleScenarios = useMemo(
    () => (activeDomain === "all" ? scenarios : scenarios.filter((scenario) => scenario.domain === activeDomain)),
    [activeDomain, scenarios]
  );

  const selectedScenario =
    scenarios.find((scenario) => scenario.round === selectedRound) ?? visibleScenarios[0] ?? scenarios[0];
  const selectedResult = run?.results.find((result) => result.round === selectedScenario?.round);
  const passed = run?.passed ?? 0;
  const total = run?.total ?? scenarios.length;
  const averageScore = run?.averageScore ?? 0;

  async function loadScenarios() {
    try {
      setState("loading");
      const next = await getEvaluationScenarios();
      setScenarios(next);
      setSelectedRound(next[0]?.round ?? 1);
      setState("idle");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载评测用例失败");
      setState("error");
    }
  }

  async function runSuite() {
    try {
      setState("running");
      setError("");
      const next = await runEvaluationSuite();
      setRun(next);
      setSelectedRound(next.results[0]?.round ?? 1);
      setState("ready");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "十轮验证失败");
      setState("error");
    }
  }

  return (
    <div className="verify-shell">
      <aside className="verify-rail">
        <div className="verify-brand">
          <span>H</span>
          <div>
            <strong>Hermes Verify</strong>
            <small>PM + Codex quality lab</small>
          </div>
        </div>

        <div className="verify-domains" aria-label="Evaluation domains">
          <button
            type="button"
            className={activeDomain === "all" ? "is-active" : ""}
            onClick={() => setActiveDomain("all")}
          >
            <FlaskConical size={16} />
            <span>全部十轮</span>
          </button>
          {(Object.keys(domainLabels) as EvaluationDomain[]).map((domain) => {
            const Icon = domainIcons[domain];
            return (
              <button
                type="button"
                key={domain}
                className={activeDomain === domain ? "is-active" : ""}
                onClick={() => setActiveDomain(domain)}
              >
                <Icon size={16} />
                <span>{domainLabels[domain]}</span>
              </button>
            );
          })}
        </div>

        <a className="verify-back" href="/">
          返回办公室
        </a>
      </aside>

      <main className="verify-main">
        <header className="verify-hero">
          <div>
            <span className="office-kicker">Evidence-first evaluation</span>
            <h1>Hermes Agent 十轮验证</h1>
            <p>用固定验收标准检查任务拆解、算法正确性、产品研发流程、界面设计和报告归档。</p>
          </div>
          <button type="button" className="run-suite-button" onClick={runSuite} disabled={state === "running"}>
            {state === "running" ? <Loader2 size={18} className="spin" /> : <Activity size={18} />}
            <span>{state === "running" ? "验证中" : "运行十轮验证"}</span>
          </button>
        </header>

        <section className="verify-scoreboard">
          <article>
            <span>通过率</span>
            <strong>{total ? Math.round((passed / total) * 100) : 0}%</strong>
            <small>
              {passed}/{total || 10} rounds
            </small>
          </article>
          <article>
            <span>平均分</span>
            <strong>{averageScore || "--"}</strong>
            <small>90 分以上视为通过</small>
          </article>
          <article>
            <span>证据模式</span>
            <strong>严格</strong>
            <small>算法轮含断言</small>
          </article>
          <article>
            <span>归档</span>
            <strong>{run ? "已生成" : "待运行"}</strong>
            <small>项目文件夹 + Obsidian</small>
          </article>
        </section>

        {error ? (
          <section className="verify-error">
            <XCircle size={18} />
            <span>{error}</span>
          </section>
        ) : null}

        <section className="verify-board">
          <div className="round-list">
            {visibleScenarios.map((scenario) => {
              const result = run?.results.find((item) => item.round === scenario.round);
              return (
                <button
                  type="button"
                  key={scenario.id}
                  className={`round-card ${selectedRound === scenario.round ? "is-active" : ""}`}
                  onClick={() => setSelectedRound(scenario.round)}
                >
                  <span>Round {String(scenario.round).padStart(2, "0")}</span>
                  <strong>{scenario.title}</strong>
                  <small>{domainLabels[scenario.domain]}</small>
                  {result ? (
                    <em className={result.passed ? "is-pass" : "is-fail"}>
                      {result.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {result.score}
                    </em>
                  ) : null}
                </button>
              );
            })}
          </div>

          <article className="round-detail">
            {selectedScenario ? (
              <>
                <div className="round-detail-head">
                  <div>
                    <span>{domainLabels[selectedScenario.domain]} · Round {selectedScenario.round}</span>
                    <h2>{selectedScenario.title}</h2>
                  </div>
                  <strong className={selectedResult?.passed ? "score-pass" : "score-pending"}>
                    {selectedResult ? selectedResult.score : "待测"}
                  </strong>
                </div>

                <p className="round-prompt">{selectedScenario.prompt}</p>

                <div className="criteria-grid">
                  <section>
                    <h3>验收标准</h3>
                    {selectedScenario.acceptanceCriteria.map((criterion) => (
                      <p key={criterion}>
                        <ClipboardCheck size={15} />
                        <span>{criterion}</span>
                      </p>
                    ))}
                  </section>
                  <section>
                    <h3>证据要求</h3>
                    {selectedScenario.evidenceRequired.map((item) => (
                      <p key={item}>
                        <FolderOpen size={15} />
                        <span>{item}</span>
                      </p>
                    ))}
                  </section>
                </div>

                <div className="check-list">
                  <h3>本轮检查</h3>
                  {selectedResult ? (
                    selectedResult.checks.map((check) => (
                      <div key={check.label} className={`check-row ${check.passed ? "is-pass" : "is-fail"}`}>
                        {check.passed ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
                        <div>
                          <strong>{check.label}</strong>
                          <span>{check.evidence}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="check-empty">点击“运行十轮验证”后显示断言和证据。</div>
                  )}
                </div>
              </>
            ) : null}
          </article>
        </section>
      </main>

      <aside className="verify-report">
        <div className="report-card">
          <span className="office-kicker">Final report</span>
          <h2>Hermes 提交包</h2>
          <p>运行后会在项目文件夹保留评测报告、worker 分支记录和算法程序，并同步到 Obsidian。</p>
        </div>

        <div className="path-stack">
          <PathLine label="项目" value={run?.evaluationPath} />
          <PathLine label="程序" value={run?.programsPath} />
          <PathLine label="报告" value={run?.reportPath} />
          <PathLine label="Obsidian" value={run?.obsidianPath} />
        </div>

        <div className="domain-breakdown">
          <h3>分领域</h3>
          {(Object.keys(domainLabels) as EvaluationDomain[]).map((domain) => {
            const value = run?.domainBreakdown[domain];
            const Icon = domainIcons[domain];
            return (
              <article key={domain}>
                <Icon size={16} />
                <div>
                  <strong>{domainLabels[domain]}</strong>
                  <span>{value ? `${value.passed}/${value.total} · avg ${value.averageScore}` : "待运行"}</span>
                </div>
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function PathLine({ label, value }: { label: string; value?: string }) {
  return (
    <div className="path-line">
      <span>{label}</span>
      <strong>{value ?? "等待生成"}</strong>
    </div>
  );
}
