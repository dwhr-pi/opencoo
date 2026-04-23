// Negative-case fixture for opencoo/no-update-append-only.
// The UPDATE and DELETE calls target `agentRuns` and `pageCitations` —
// both append-only per THREAT-MODEL §2 invariant 8. The rule must flag
// each call site.
//
// `db` and the table identifiers are declared locally so the fixture
// is self-contained. The rule matches on the CallExpression shape
// (method name + first-argument Identifier name), not on the type of
// the caller, so these stub declarations are sufficient.

declare const db: {
  update: (t: unknown) => { set: (v: unknown) => void; where: (v: unknown) => void };
  delete: (t: unknown) => void;
  with: (c: unknown) => {
    update: (t: unknown) => { set: (v: unknown) => void };
  };
};
declare const cte: unknown;
declare const agentRuns: unknown;
declare const pageCitations: unknown;

db.update(agentRuns).set({ status: "success" });
db.delete(pageCitations);
db.with(cte).update(agentRuns).set({ status: "failed" });
