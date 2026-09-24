// Which options a tracking field offers for a given project type.
//
// Options come from the sheet's Lists tab. The "Options By Type" tab can limit
// an option to certain project types, e.g.
//   Field: Artwork | Option: Digitized | Only For Project Types: Embroidery - Hats, Embroidery - Apparel, ...
// A type ending in * matches by prefix ("Embroidery*"). Options with no rule show for every type.

(function () {
  'use strict';

  function typeMatches(pattern, type) {
    const p = pattern.trim().toLowerCase();
    const t = String(type || '').trim().toLowerCase();
    if (p === '*') return true;
    if (p.endsWith('*')) return t.startsWith(p.slice(0, -1).trim());
    return p === t;
  }

  function allowedOptions(field, type, lists, rules, current) {
    const base = (lists.options && lists.options[field]) || [];
    const out = base.filter((opt) => {
      const limits = (rules || []).filter((r) => r.field === field && r.option === opt);
      return !limits.length || limits.some((r) => r.types.some((p) => typeMatches(p, type)));
    });
    // Never hide a value a job already has, even if the rules no longer allow it.
    if (current && !out.includes(current)) out.push(current);
    return out;
  }

  window.Options = { allowedOptions, typeMatches };
})();
