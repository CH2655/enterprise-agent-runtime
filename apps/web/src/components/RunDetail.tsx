import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  BookOpenText,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Database,
  FileWarning,
  Fingerprint,
  Gauge,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { approveRun, getRun } from "../api";
import { useRunEvents } from "../hooks/use-run-events";
import { useEventStore } from "../stores/event-store";
import type { AgentEvent, DemoIdentity, EvidenceRecord, RiskFinding } from "../types";
import { StatusBadge } from "./StatusBadge";

export function RunDetail({ runId, identity }: { runId: string; identity: DemoIdentity }) {
  const queryClient = useQueryClient();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();
  const [approvalOpen, setApprovalOpen] = useState(false);
  const runQuery = useQuery({
    queryKey: ["run", identity.tenantId, runId],
    queryFn: () => getRun(runId, identity),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ["running", "queued"].includes(status) ? 1_500 : false;
    },
  });
  useRunEvents(runId, identity);
  const projection = useEventStore((state) => state.runs[runId]);
  const connection = useEventStore((state) => state.connections[runId] ?? "idle");
  const approveMutation = useMutation({
    mutationFn: () => approveRun(runId, identity),
    onSuccess: (run) => {
      queryClient.setQueryData(["run", identity.tenantId, runId], run);
      void queryClient.invalidateQueries({ queryKey: ["runs", identity.tenantId] });
      setApprovalOpen(false);
    },
  });

  const evidence = runQuery.data?.state.evidence ?? [];
  const selectedEvidence = useMemo(
    () => evidence.find((item) => item.id === selectedEvidenceId) ?? evidence[0],
    [evidence, selectedEvidenceId],
  );

  if (runQuery.isLoading) return <RunDetailSkeleton />;
  if (runQuery.isError) {
    return (
      <div className="detail-error">
        <AlertCircle size={28} />
        <h2>任务加载失败</h2>
        <p>{runQuery.error.message}</p>
        <button className="secondary-button" type="button" onClick={() => void runQuery.refetch()}>
          <RefreshCw size={16} /> 重试
        </button>
      </div>
    );
  }
  const run = runQuery.data!;
  const state = run.state;

  return (
    <div className="run-detail">
      <div className="detail-header">
        <div className="detail-title">
          <div className="detail-title-line">
            <h1>{run.input.caseId}</h1>
            <StatusBadge status={run.status} />
          </div>
          <div className="detail-meta">
            <span>{run.input.projectCode}</span><ArrowRight size={14} /><span>{run.input.supplierCode}</span>
            <span className="meta-separator" />
            <span>{formatDateTime(run.createdAt)}</span>
          </div>
        </div>
        <div className={`connection-state connection-${connection}`}>
          <span />
          {connection === "live" ? "实时连接" : connection === "reconnecting" ? "正在重连" : "连接中"}
        </div>
      </div>

      <section className="metric-strip" aria-label="尽调指标">
        <Metric icon={<Gauge size={18} />} label="证据覆盖" value={`${Math.round((state.coverage ?? 0) * 100)}%`} tone="teal" />
        <Metric icon={<RefreshCw size={18} />} label="取证轮次" value={`${state.iteration ?? 0} / 3`} tone="blue" />
        <Metric icon={<Database size={18} />} label="有效证据" value={String(evidence.length)} tone="green" />
        <Metric icon={<ShieldAlert size={18} />} label="风险发现" value={String(state.findings?.length ?? 0)} tone="red" />
      </section>

      <div className="detail-columns">
        <div className="report-column">
          <section className="content-section">
            <div className="section-title">
              <div><ShieldAlert size={19} /><h2>风险结论</h2></div>
              <span>{state.findings?.length ?? 0} 项</span>
            </div>
            <div className="finding-list">
              {state.findings?.map((finding) => (
                <FindingItem
                  key={finding.id}
                  finding={finding}
                  evidence={evidence}
                  onEvidence={setSelectedEvidenceId}
                />
              ))}
              {!state.findings?.length && (
                <NoFindings status={run.status} missing={state.missingCategories ?? []} />
              )}
            </div>
          </section>

          <section className="content-section evidence-section">
            <div className="section-title">
              <div><Fingerprint size={19} /><h2>证据链</h2></div>
              <span>{evidence.length} 条</span>
            </div>
            <div className="evidence-workspace">
              <div className="evidence-index" role="list">
                {evidence.map((item) => (
                  <button
                    key={item.id}
                    className={selectedEvidence?.id === item.id ? "active" : ""}
                    type="button"
                    onClick={() => setSelectedEvidenceId(item.id)}
                  >
                    <EvidenceIcon sourceType={item.sourceType} />
                    <span><strong>{categoryLabel(item.category)}</strong><small>{sourceLabel(item.sourceType)}</small></span>
                  </button>
                ))}
              </div>
              <div className="evidence-preview">
                {selectedEvidence ? <EvidencePreview evidence={selectedEvidence} /> : (
                  <div className="empty-evidence">暂无证据</div>
                )}
              </div>
            </div>
          </section>
        </div>

        <aside className="timeline-column">
          <div className="section-title">
            <div><Clock3 size={19} /><h2>执行记录</h2></div>
            <span>#{projection?.lastSequence ?? 0}</span>
          </div>
          <div className="timeline-list">
            {projection?.events.map((event) => <TimelineItem key={event.sequence} event={event} />)}
            {!projection?.events.length && <div className="timeline-loading"><LoaderCircle size={18} /> 正在读取事件</div>}
          </div>
        </aside>
      </div>

      {run.status === "waiting_approval" && (
        <div className="approval-bar">
          <div>
            <BadgeCheck size={21} />
            <span><strong>风险报告等待人工确认</strong><small>批准后将创建整改任务，操作具备幂等保护。</small></span>
          </div>
          <button className="approve-button" type="button" onClick={() => setApprovalOpen(true)}>
            <Check size={17} /> 审批并创建整改
          </button>
        </div>
      )}

      {state.writeBack && (
        <div className="writeback-banner">
          <CheckCircle2 size={20} />
          <span><strong>整改任务已创建</strong><small>{state.writeBack.taskId}</small></span>
        </div>
      )}

      {approvalOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setApprovalOpen(false)}>
          <section className="dialog-panel approval-dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-header">
              <div><span className="dialog-icon approval"><BadgeCheck size={20} /></span><div><h2>确认风险处置</h2><p>{run.input.caseId}</p></div></div>
              <button className="icon-button" type="button" title="关闭" onClick={() => setApprovalOpen(false)}><X size={19} /></button>
            </div>
            <div className="approval-summary">
              <div><span>风险发现</span><strong>{state.findings?.length ?? 0} 项</strong></div>
              <div><span>后续动作</span><strong>创建整改任务</strong></div>
              <div><span>幂等键</span><code>{run.id.slice(0, 8)}:rectification</code></div>
            </div>
            {approveMutation.isError && <div className="inline-error">{approveMutation.error.message}</div>}
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setApprovalOpen(false)}>取消</button>
              <button className="approve-button" type="button" disabled={approveMutation.isPending} onClick={() => approveMutation.mutate()}>
                {approveMutation.isPending ? "正在执行..." : "确认批准"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) {
  return <div className={`metric-item metric-${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function FindingItem({ finding, evidence, onEvidence }: { finding: RiskFinding; evidence: EvidenceRecord[]; onEvidence(id: string): void }) {
  return (
    <article className={`finding-item finding-${finding.level}`}>
      <div className="finding-head">
        <span className="risk-level">{finding.level === "high" ? "高风险" : finding.level === "medium" ? "中风险" : "低风险"}</span>
        <strong>{finding.dimension}</strong>
        <span className="confidence">置信度 {Math.round(finding.confidence * 100)}%</span>
      </div>
      <p>{finding.claim}</p>
      <div className="recommendation"><Sparkles size={15} /><span>{finding.recommendation}</span></div>
      <div className="citation-row">
        {finding.evidenceIds.map((id) => {
          const item = evidence.find((candidate) => candidate.id === id);
          return <button key={id} type="button" onClick={() => onEvidence(id)}>#{item ? categoryLabel(item.category) : id}</button>;
        })}
      </div>
    </article>
  );
}

function EvidencePreview({ evidence }: { evidence: EvidenceRecord }) {
  const locator = parseLocator(evidence.locator);
  const structured = parseStructuredContent(evidence.content);
  return (
    <div>
      <div className="evidence-preview-head">
        <div><strong>{categoryLabel(evidence.category)}</strong><span>{evidence.sourceId}</span></div>
        <span className="source-chip">{sourceLabel(evidence.sourceType)}</span>
      </div>
      {locator && (
        <div className="locator-bar">
          <BookOpenText size={15} />
          <span>{locator.section ?? "原文"}</span>
          {locator.documentVersion && <span>v{locator.documentVersion}</span>}
          {locator.startLine && <span>L{locator.startLine}-{locator.endLine}</span>}
        </div>
      )}
      {structured ? (
        <dl className="structured-evidence">
          {Object.entries(structured).map(([key, value]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd>{String(value)}</dd></div>)}
        </dl>
      ) : <blockquote className="policy-content">{evidence.content}</blockquote>}
      <div className="evidence-foot"><code>{evidence.id}</code><span>{formatDateTime(evidence.collectedAt)}</span></div>
    </div>
  );
}

function TimelineItem({ event }: { event: AgentEvent }) {
  const meta = eventMeta(event);
  return (
    <div className={`timeline-item timeline-${meta.tone}`}>
      <div className="timeline-marker">{meta.icon}</div>
      <div><div><strong>{meta.title}</strong><span>#{event.sequence}</span></div><p>{meta.detail}</p><time>{formatTime(event.timestamp)}</time></div>
    </div>
  );
}

function eventMeta(event: AgentEvent) {
  const payload = event.payload;
  if (event.type === "run.created") return { title: "任务已创建", detail: "Runtime 已建立执行上下文", tone: "neutral", icon: <CircleDot size={13} /> };
  if (event.type === "plan.created") return { title: "取证计划已生成", detail: `${String(payload.iteration ?? "-")} 轮 · ${Array.isArray(payload.tools) ? payload.tools.length : 0} 个工具`, tone: "blue", icon: <Sparkles size={13} /> };
  if (event.type === "tool.started") return { title: "调用业务工具", detail: String(payload.toolName ?? "受控工具"), tone: "neutral", icon: <LoaderCircle size={13} /> };
  if (event.type === "tool.completed") return { title: "工具调用完成", detail: String(payload.toolName ?? "证据已返回"), tone: "green", icon: <Check size={13} /> };
  if (event.type === "tool.failed" || event.type === "node.failed") return { title: "执行异常", detail: String(payload.error ?? "节点执行失败"), tone: "red", icon: <AlertCircle size={13} /> };
  if (event.type === "evidence.added") return { title: "证据已登记", detail: String(payload.category ?? payload.evidenceId ?? "Evidence"), tone: "teal", icon: <Database size={13} /> };
  if (event.type === "approval.required") return { title: "等待人工审批", detail: `${String(payload.findingCount ?? 0)} 项风险待确认`, tone: "amber", icon: <Clock3 size={13} /> };
  if (event.type === "approval.completed") return { title: "审批已通过", detail: String(payload.approvedBy ?? "风控负责人"), tone: "green", icon: <BadgeCheck size={13} /> };
  if (event.type === "run.completed") return { title: "任务已完成", detail: String(payload.taskId ?? "运行闭环完成"), tone: "green", icon: <CheckCircle2 size={13} /> };
  if (event.type === "run.waiting_input") return { title: "等待补充材料", detail: "必要证据尚未覆盖", tone: "amber", icon: <FileWarning size={13} /> };
  return { title: event.nodeId ? nodeLabel(event.nodeId) : event.type, detail: typeof payload.message === "string" ? payload.message : "状态已更新", tone: "neutral", icon: <CircleDot size={13} /> };
}

function NoFindings({ status, missing }: { status: string; missing: string[] }) {
  if (status === "waiting_input") return <div className="diagnostic-state"><FileWarning size={25} /><div><strong>证据覆盖不足</strong><p>待补充：{missing.map(categoryLabel).join("、") || "业务材料"}</p></div></div>;
  return <div className="diagnostic-state"><LoaderCircle size={25} /><div><strong>正在形成风险结论</strong><p>Agent 尚未提交可验证的 Finding。</p></div></div>;
}

function EvidenceIcon({ sourceType }: { sourceType: EvidenceRecord["sourceType"] }) {
  return sourceType === "knowledge" ? <BookOpenText size={17} /> : sourceType === "business_object" ? <Database size={17} /> : <Fingerprint size={17} />;
}

function RunDetailSkeleton() {
  return <div className="detail-skeleton"><span /><span /><div><span /><span /><span /><span /></div><section><span /><span /></section></div>;
}

function parseLocator(value?: string): Record<string, string | number> | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as Record<string, string | number>; } catch { return undefined; }
}

function parseStructuredContent(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function categoryLabel(value: string): string {
  return ({ project: "项目档案", supplier: "供应商档案", "enterprise-risk": "企业信用", "bank-statement": "资金流水", policy: "准入制度" } as Record<string, string>)[value] ?? value;
}

function sourceLabel(value: EvidenceRecord["sourceType"]): string {
  return ({ knowledge: "制度知识库", business_object: "PaaS 业务对象", tool: "受控工具", document: "业务文档" } as const)[value];
}

function fieldLabel(value: string): string {
  return ({ code: "业务编码", name: "名称", budget: "项目预算", registeredCapital: "注册资本", dishonest: "失信记录", legalCaseCount: "法律案件", abnormalTransactions: "异常交易", cashFlowStable: "资金稳定" } as Record<string, string>)[value] ?? value;
}

function nodeLabel(value: string): string {
  return ({ plan: "生成取证计划", collect: "执行证据采集", evaluate: "评估证据覆盖", synthesize: "生成风险结论", verify: "校验证据引用", human_review: "人工审批", write_back: "整改写回" } as Record<string, string>)[value] ?? value;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}
