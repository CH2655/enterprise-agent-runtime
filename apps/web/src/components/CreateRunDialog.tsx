import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BriefcaseBusiness, Building2, ClipboardPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { createRun } from "../api";
import type { DemoIdentity } from "../types";

export function CreateRunDialog({
  open,
  identity,
  onClose,
  onCreated,
}: {
  open: boolean;
  identity: DemoIdentity;
  onClose(): void;
  onCreated(runId: string): void;
}) {
  const queryClient = useQueryClient();
  const [caseId, setCaseId] = useState("");
  const [projectCode, setProjectCode] = useState("");
  const [supplierCode, setSupplierCode] = useState("");
  const mutation = useMutation({
    mutationFn: () => createRun({ caseId, projectCode, supplierCode }, identity),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ["runs", identity.tenantId] });
      queryClient.setQueryData(["run", identity.tenantId, run.id], run);
      onCreated(run.id);
    },
  });

  useEffect(() => {
    if (!open) return;
    const suffix = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
    setCaseId(`DD-${suffix}`);
    setProjectCode("P-2026-0819");
    setSupplierCode("SUP-1042");
    mutation.reset();
  }, [open]);

  if (!open) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-run-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <span className="dialog-icon"><ClipboardPlus size={19} /></span>
            <div>
              <h2 id="create-run-title">新建供应商尽调</h2>
              <p>当前租户：{identity.tenantId}</p>
            </div>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="form-field">
            <span>尽调编号</span>
            <div className="input-shell"><ClipboardPlus size={17} /><input value={caseId} onChange={(event) => setCaseId(event.target.value)} required /></div>
          </label>
          <label className="form-field">
            <span>项目编码</span>
            <div className="input-shell"><BriefcaseBusiness size={17} /><input value={projectCode} onChange={(event) => setProjectCode(event.target.value)} required /></div>
          </label>
          <label className="form-field">
            <span>供应商编码</span>
            <div className="input-shell"><Building2 size={17} /><input value={supplierCode} onChange={(event) => setSupplierCode(event.target.value)} required /></div>
          </label>
          {mutation.isError && <div className="inline-error">{mutation.error.message}</div>}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "正在创建..." : "发起尽调"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
