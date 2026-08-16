import { useOutletContext } from "react-router-dom";
import { parseProofSummary, useWarrants, type Warrant, type WarrantProofSummary } from "../../api";
import { relTime } from "../../lib/format";
import { CopyableHash } from "../../components/CopyableHash";

type Ctx = { dna: string };

export function DnaWarrants() {
  const { dna } = useOutletContext<Ctx>();
  const { data } = useWarrants({ dna });
  const rows = data?.warrants ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Warrants in this DNA: <span className="mono">{rows.length}</span>
      </p>
      <div className="border border-border rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th className="text-left px-3 py-2">Type</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Author</th>
              <th className="text-left px-3 py-2">Target</th>
              <th className="text-left px-3 py-2">Sighted</th>
              <th className="text-left px-3 py-2">Integrated</th>
              <th className="text-left px-3 py-2">Proof</th>
              <th className="text-left px-3 py-2">Observer</th>
              <th className="text-left px-3 py-2">Op</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <WarrantRow key={`${r.observer_id}-${r.op_hash_b64}`} row={r} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-6 text-center text-muted" colSpan={9}>
                  No warrants observed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WarrantRow({ row }: { row: Warrant }) {
  const proof = parseProofSummary(row.proof_summary_json);
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <span className="chip">{row.warrant_type}</span>
      </td>
      <td className="px-3 py-2">
        <StatusChip status={row.validation_status} />
      </td>
      <td className="px-3 py-2 text-xs">
        <CopyableHash value={row.author_b64} />
      </td>
      <td className="px-3 py-2 text-xs">
        <CopyableHash value={row.target_b64} />
      </td>
      <td className="px-3 py-2">{relTime(row.ts_iso)}</td>
      <td className="px-3 py-2">
        {row.integrated_ts_iso ? (
          relTime(row.integrated_ts_iso)
        ) : (
          <span className="text-muted">pending</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        <ProofCell proof={proof} />
      </td>
      <td className="px-3 py-2 text-xs">
        <CopyableHash value={row.observer_id} />
      </td>
      <td className="px-3 py-2 text-xs">
        <CopyableHash value={row.op_hash_b64} head={10} tail={6} />
      </td>
    </tr>
  );
}

/// Validation status badge. `Valid` means the warrant was accepted (the
/// warrantee did misbehave), `Rejected` means the warrantor was wrong,
/// `Abandoned` means dependencies never resolved.
function StatusChip({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted">—</span>;
  const lower = status.toLowerCase();
  let cls = "chip";
  if (lower === "valid") cls += " text-ok";
  else if (lower === "rejected") cls += " text-danger";
  else cls += " text-muted";
  return <span className={cls}>{status}</span>;
}

function ProofCell({ proof }: { proof: WarrantProofSummary | null }) {
  if (!proof) return <span className="text-muted">—</span>;
  if (proof.kind === "InvalidChainOp") {
    return (
      <div className="space-y-1">
        <div className="text-muted">{proof.chain_op_type}</div>
        {/* Holochain 0.7's human-readable rejection reason (B110). */}
        {proof.reason && (
          <div>
            <span className="text-muted">reason:</span> {proof.reason}
          </div>
        )}
        <div>
          <span className="text-muted">action:</span> <CopyableHash value={proof.action_hash_b64} />
        </div>
        <div>
          <span className="text-muted">by:</span> <CopyableHash value={proof.action_author_b64} />
        </div>
      </div>
    );
  }
  if (proof.kind === "ChainFork") {
    return (
      <div className="space-y-1">
        {/* `seq` localises the fork to a chain position (B110). */}
        <div className="text-muted">
          {proof.seq != null ? `fork at seq ${proof.seq}:` : "fork at:"}
        </div>
        <div>
          <CopyableHash value={proof.action_a_hash_b64} />
        </div>
        <div>
          <CopyableHash value={proof.action_b_hash_b64} />
        </div>
        <div>
          <span className="text-muted">author:</span>{" "}
          <CopyableHash value={proof.chain_author_b64} />
        </div>
      </div>
    );
  }
  return <span className="text-muted">{proof.description}</span>;
}
