// Monthly cost of a Terraform plan for the Lightsail stack, before and after.
// Used by terraform-plan.yml (PR comment) and terraform.yml (approval gate).
//
//   node terraform-cost.js plan.json bundles.json  -> prints the result as JSON
//
// plan.json comes from `terraform show -json tfplan`; bundles.json from
// `aws lightsail get-bundles --query 'bundles[].{id:bundleId,price:price}'`.

// Billed per hour only while detached (~730 h/month).
const STATIC_IP_IDLE = 0.005 * 730;
const PRICED = ['aws_lightsail_instance', 'aws_lightsail_static_ip'];
// Types that never add to the bill by themselves.
const FREE = [
  'aws_lightsail_instance_public_ports',
  'aws_lightsail_static_ip_attachment',
  'aws_lightsail_key_pair',
  'aws_lightsail_domain',
  'aws_lightsail_domain_entry',
];

function estimate(plan, bundles) {
  const prices = Object.fromEntries(bundles.map((b) => [b.id, b.price]));
  const changes = (plan.resource_changes || []).filter((r) => r.mode === 'managed');
  const attached = (state) =>
    new Set(
      changes
        .filter((r) => r.type === 'aws_lightsail_static_ip_attachment' && r.change[state])
        .map((r) => r.change[state].static_ip_name),
    );
  const rows = [];
  let before = 0;
  let after = 0;
  for (const r of changes) {
    if (!PRICED.includes(r.type)) continue;
    const cost = (state) => {
      const v = r.change[state];
      if (!v) return 0;
      if (r.type === 'aws_lightsail_instance') return prices[v.bundle_id] ?? NaN;
      return attached(state).has(v.name) ? 0 : STATIC_IP_IDLE;
    };
    const b = cost('before');
    const a = cost('after');
    before += b || 0;
    after += a || 0;
    const v = r.change.after || r.change.before;
    rows.push({ address: r.address, detail: r.type === 'aws_lightsail_instance' ? v.bundle_id : '', before: b, after: a });
  }
  // Resources whose price this script does not know, being created, replaced
  // or changed: treated as a cost change so they need approval.
  const unknown = changes
    .filter((r) => !PRICED.includes(r.type) && !FREE.includes(r.type))
    .filter((r) => r.change.actions.some((a) => a === 'create' || a === 'update'))
    .map((r) => r.address);
  const unpriced = rows.some((row) => Number.isNaN(row.before) || Number.isNaN(row.after));
  const round = (v) => Math.round(v * 100) / 100;
  return {
    rows,
    before: round(before),
    after: round(after),
    unknown,
    changesCost: unpriced || unknown.length > 0 || round(before) !== round(after),
  };
}

module.exports = { estimate };

if (require.main === module) {
  const fs = require('fs');
  const [planPath, bundlesPath] = process.argv.slice(2);
  const result = estimate(JSON.parse(fs.readFileSync(planPath, 'utf8')), JSON.parse(fs.readFileSync(bundlesPath, 'utf8')));
  process.stdout.write(JSON.stringify(result));
}
