// Applies a bundle's Configurator rules (from Salesforce Setup > Product Configurator) to a
// selection of component product ids. Currently understands the one action the portal's bundle
// page needs: AutoAdd ("if these products are selected, also select this one"). Unrecognised
// operators/actions are already filtered out server-side, so every rule here is one we can run.

const conditionMet = (criterion, selected) => {
  const present = criterion.productIds.some((id) => selected.has(id));
  return criterion.operator === 'Does Not Contain' ? !present : present; // Equals / Contains
};

const ruleFires = (rule, selected) =>
  rule.mode === 'Any' ? rule.criteria.some((c) => conditionMet(c, selected)) : rule.criteria.every((c) => conditionMet(c, selected));

// Adds whatever the rules require, repeating until nothing more changes (a rule's own action
// could satisfy another rule's condition). `addableIds` limits additions to products that can
// actually be added (priced and part of this bundle).
export function applyConfigRules(selected, rules, addableIds) {
  if (!rules?.length) return selected;
  let set = selected;
  for (let pass = 0; pass < rules.length + 1; pass++) {
    let next = set;
    for (const rule of rules) {
      if (!ruleFires(rule, next)) continue;
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
export function requiredByRules(selected, rules) {
  const required = new Set();
  for (const rule of rules ?? []) {
    if (!ruleFires(rule, selected)) continue;
    for (const action of rule.actions) required.add(action.productId);
  }
  return required;
}
