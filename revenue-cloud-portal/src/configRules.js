// Applies a bundle's Configurator rules (from Salesforce Setup > Product Configurator) to a
// selection of component product ids. Currently understands the one action the portal's bundle
// page needs: AutoAdd ("if these products are selected, also select this one"). Unrecognised
// operators/actions are already filtered out server-side, so every rule here is one we can run.

// A rule criterion can also carry attribute conditions on the bundle itself (e.g. "AI powered Detection
// equals Yes"). `attrs` holds the bundle's chosen values keyed by AttributeDefinition id.
const norm = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'true' ? 'yes' : s === 'false' ? 'no' : s; // a checkbox attribute is Yes / No
};

const attributeMet = (cond, attrs) => {
  const entry = Object.entries(attrs ?? {}).find(([id]) => id.slice(0, 15) === cond.attributeId);
  const actual = norm(entry?.[1]);
  if (!actual) return false; // attribute not chosen: cannot match
  const listed = cond.values.some((v) => norm(v) === actual);
  return cond.operator === 'Not Equals' || cond.operator === 'Not In' ? !listed : listed; // Equals / In
};

const conditionMet = (criterion, selected, attrs) => {
  // when the criterion is the bundle itself, the bundle is always part of the configuration
  const present = criterion.onBundle || criterion.productIds.some((id) => selected.has(id));
  const productMet = criterion.operator === 'Does Not Contain' ? !present : present; // Equals / Contains
  return productMet && (criterion.attributes ?? []).every((c) => attributeMet(c, attrs));
};

const ruleFires = (rule, selected, attrs) =>
  rule.mode === 'Any' ? rule.criteria.some((c) => conditionMet(c, selected, attrs)) : rule.criteria.every((c) => conditionMet(c, selected, attrs));

// Adds whatever the rules require, repeating until nothing more changes (a rule's own action
// could satisfy another rule's condition). `addableIds` limits additions to products that can
// actually be added (priced and part of this bundle).
export function applyConfigRules(selected, rules, addableIds, attrs) {
  if (!rules?.length) return selected;
  let set = selected;
  for (let pass = 0; pass < rules.length + 1; pass++) {
    let next = set;
    for (const rule of rules) {
      if (!ruleFires(rule, next, attrs)) continue;
      for (const action of rule.actions) {
        if (addableIds.has(action.productId) && !next.has(action.productId)) {
          if (next === set) next = new Set(set);
          next.add(action.productId);
        }
      }
    }
    if (next === set) break;
    set = next;
  }
  return set;
}

// Which currently-selected products are only selected because a rule requires them right now -
// used to lock their checkbox so unchecking them can't "stick" while the rule still fires.
export function requiredByRules(selected, rules, attrs) {
  const required = new Set();
  for (const rule of rules ?? []) {
    if (!ruleFires(rule, selected, attrs)) continue;
    for (const action of rule.actions) required.add(action.productId);
  }
  return required;
}
